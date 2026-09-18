/**
 * The local persistence port (PRD §21, §50).
 *
 * POSA runs on three runtimes with different storage engines:
 *   - native/desktop  → SQLite (expo-sqlite)
 *   - web / PWA       → IndexedDB (Dexie)
 *   - tests / preview → in-memory
 *
 * Rather than let the choice leak into the application, everything above this
 * file talks to `LocalStore`. The port is deliberately narrow: keyed document
 * collections, PLUS two purpose-built stores that are the hot paths:
 *
 *   1. `barcodes` — a typed, denormalised table (PRD §10.4). A scan must resolve
 *      in well under 100ms, so it gets a real primary key on the barcode itself
 *      rather than a JSON document scan.
 *
 *   2. `outbox`  — the durable sync queue (PRD §21). It is queried by
 *      `acked_at IS NULL AND next_attempt_at <= now` on every sync tick, so it
 *      also gets real columns and an index.
 *
 * Everything else (catalog, ledger, sales) is a document collection. Those are
 * append-mostly and read via the in-memory catalog cache at boot, which is how a
 * till stays responsive with a 50,000-product catalogue.
 */

import type { BarcodeIndexEntry } from "@/domain/types";
import type { OutboxEvent } from "@/domain/sync-protocol";

export const COLLECTIONS = [
  "business",
  "branches",
  "users",
  "devices",
  "categories",
  "products",
  "variants",
  "priceOverrides",
  "priceHistory",
  "inventoryLedger",
  "stockCountSessions",
  "stockCountLines",
  "stockTransfers",
  "sales",
  "saleLines",
  "payments",
  "heldSales",
  "returns",
  "returnLines",
  "customers",
  "suppliers",
  "purchases",
  "shifts",
  "cashMovements",
  "expenses",
  "expenseCategories",
  "auditLogs",
  "conflicts",
] as const;

export type CollectionName = (typeof COLLECTIONS)[number];

export interface Identified {
  id: string;
}

export interface QueryOptions {
  sortBy?: string;
  direction?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export type LocalStoreKind = "sqlite" | "dexie" | "memory";

export interface OutboxStats {
  pending: number;
  /** Events that have exhausted a sensible retry count and need attention. */
  failing: number;
  total: number;
  oldestPendingAt: string | null;
  /** Highest attempt count in the queue, for the "is it stuck?" indicator. */
  maxAttempts: number;
}

/** Anything with an `id` can be stored; the store owns the key. */
export type StoreDoc = Record<string, unknown> & { id?: string };

export interface LocalStore {
  readonly kind: LocalStoreKind;

  /** Open the database, run migrations. Safe to call more than once. */
  init(): Promise<void>;

  /* --- Generic document collections ---------------------------------- */

  get<T extends StoreDoc>(
    collection: CollectionName,
    id: string,
  ): Promise<T | null>;
  put<T extends StoreDoc>(collection: CollectionName, doc: T): Promise<void>;
  putMany<T extends StoreDoc>(
    collection: CollectionName,
    docs: readonly T[],
  ): Promise<void>;
  delete(collection: CollectionName, id: string): Promise<void>;
  getAll<T extends StoreDoc>(collection: CollectionName): Promise<T[]>;
  count(collection: CollectionName): Promise<number>;
  clear(collection: CollectionName): Promise<void>;

  /**
   * Filter a collection. `sortBy` and `limit` are applied AFTER filtering, so
   * ordering is total and deterministic given identical predicates.
   */
  query<T extends StoreDoc>(
    collection: CollectionName,
    predicate: (doc: T) => boolean,
    options?: QueryOptions,
  ): Promise<T[]>;

  /* --- Barcode index: the <100ms hot path (PRD §10.4) ---------------- */

  getBarcode(barcode: string): Promise<BarcodeIndexEntry | null>;
  putBarcodes(entries: readonly BarcodeIndexEntry[]): Promise<void>;
  deleteBarcode(barcode: string): Promise<void>;
  /** Prefix search so a half-typed code can still find the product. */
  searchBarcodes(prefix: string, limit?: number): Promise<BarcodeIndexEntry[]>;
  /**
   * Enumerate the whole index. Kept separate from `searchBarcodes('')` because a
   * range scan on an empty prefix is not well-defined in SQL or IndexedDB.
   */
  allBarcodes(limit?: number): Promise<BarcodeIndexEntry[]>;
  countBarcodes(): Promise<number>;

  /**
   * Does this barcode already belong to a DIFFERENT product? Used to prevent a
   * duplicate assignment and explain the conflict (PRD §10.3, §46).
   */
  findBarcodeOwner(
    barcode: string,
  ): Promise<{
    productId: string;
    variantId: string | null;
    productName: string;
  } | null>;

  /* --- Outbox: the durable sync queue (PRD §21) ---------------------- */

  enqueue(events: readonly OutboxEvent[]): Promise<void>;
  /** Events due for delivery, in dependency-safe order. */
  pendingEvents(limit: number, nowIso: string): Promise<OutboxEvent[]>;
  ackEvents(ids: readonly string[]): Promise<void>;
  markEventFailed(
    id: string,
    error: string,
    nextAttemptAt: string,
  ): Promise<void>;
  rescheduleEvent(id: string, nextAttemptAt: string): Promise<void>;
  outboxStats(): Promise<OutboxStats>;
  /** Everything not yet acknowledged — used by the Sync Center detail view. */
  allPendingEvents(limit?: number): Promise<OutboxEvent[]>;

  /* --- Key/value metadata ------------------------------------------- */

  getMeta<T>(key: string): Promise<T | null>;
  setMeta<T>(key: string, value: T): Promise<void>;

  /* --- Durability ---------------------------------------------------- */

  /**
   * Run a unit of work atomically. This is what makes the sale commit
   * all-or-nothing (PRD §21.2, §45).
   */
  transaction<T>(fn: (tx: LocalStore) => Promise<T>): Promise<T>;

  /** Desperation move: clear everything. Only reachable behind a typed confirm. */
  wipe(): Promise<void>;
}

/** Standard metadata keys. Keeping them in one place avoids typo'd strings. */
export const META_KEYS = {
  deviceId: "device.id",
  deviceSequence: "device.sequence",
  deviceCode: "device.code",
  session: "auth.session",
  offlineSubjects: "auth.offlineSubjects",
  syncCursor: "sync.cursor",
  lastSyncAt: "sync.lastSyncAt",
  lastSyncError: "sync.lastError",
  catalogVersion: "catalog.version",
  businessId: "tenant.businessId",
  branchId: "tenant.branchId",
  activeShiftId: "shift.activeId",
  activeCart: "pos.activeCart",
  installId: "device.installId",
  /** True when the catalog was populated by the first-run demo seed. */
  demo: "install.demo",
  cloudBusinessId: "cloud.businessId",
  cloudUserId: "cloud.userId",
  /** Cash rounding increment and mode, as configured on this terminal. */
  rounding: "pos.rounding",
  /** Last selected sellable branch, so the till reopens where you left it. */
  lastBranchId: "tenant.lastBranchId",
  lastCategoryId: "pos.lastCategoryId",
} as const;

export type MetaKey = (typeof META_KEYS)[keyof typeof META_KEYS];

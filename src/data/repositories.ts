/**
 * The data facade — the single door between the application and local storage.
 *
 * Two responsibilities matter most:
 *
 * 1. ATOMIC COMMIT. `commitSale` writes the sale, its lines, its payments, the
 *    inventory ledger entries, the audit rows AND the outbox events inside ONE
 *    storage transaction. If the device dies mid-write, SQLite/IndexedDB rolls
 *    the whole thing back and the cashier sees "not completed" — which is the
 *    only honest answer. If it succeeds, the sale is durable before we ever
 *    mention the network (PRD §21.2, §36, §45).
 *
 * 2. IN-MEMORY CATALOG CACHE. PRD §10.4 and §39 demand sub-100ms barcode lookup
 *    and a responsive checkout with a large catalogue. The barcode table gives
 *    us the indexed lookup; the cache gives us instant product search with no
 *    round trip at all. The cache is rebuilt from storage on boot and patched on
 *    every write, so it can never drift from the database.
 */

import type {
  AuditLogEntry,
  BarcodeIndexEntry,
  Branch,
  Business,
  Category,
  Customer,
  Device,
  Expense,
  ExpenseCategory,
  InventoryLedgerEntry,
  Purchase,
  Sale,
  SaleLine,
  Shift,
  StockCountLine,
  StockCountSession,
  StockLevel,
  Supplier,
  User,
} from "@/domain/types";
import type { OutboxEvent, SyncConflict } from "@/domain/sync-protocol";
import type { EntityKind } from "@/domain/sync-protocol";
import { ulid } from "@/domain/ulid";
import type { CommitBundle } from "@/domain/sale";
import type { ReturnBundle } from "@/domain/returns";
import { deriveStockLevels, movementKey } from "@/domain/inventory";
import { normaliseScan } from "@/domain/barcode";
import {
  META_KEYS,
  type CollectionName,
  type LocalStore,
  type OutboxStats,
  type StoreDoc,
} from "./local";
import { createBarcodeIndexEntry, type CatalogProduct } from "./catalog";

export interface ResolvedScan {
  kind: "found" | "unknown" | "blocked" | "ambiguous";
  entry: BarcodeIndexEntry | null;
  /** Populated for `ambiguous` — several products claim this barcode. */
  candidates: BarcodeIndexEntry[];
  message: string | null;
}

export interface CatalogSnapshot {
  products: CatalogProduct[];
  barcodes: BarcodeIndexEntry[];
  loadedAt: string;
}

export class PosaData {
  constructor(readonly store: LocalStore) {}

  /** Write a syncable row and its outbox event as one local transaction. */
  private async saveSyncable<T extends StoreDoc>(
    collection: CollectionName,
    entity: EntityKind,
    doc: T,
    branchId: string | null = null,
  ): Promise<void> {
    if (!doc.id) throw new Error(`Cannot sync a ${entity} without an id.`);
    const existing = await this.store.get<StoreDoc>(collection, doc.id);
    const deviceId =
      (await this.store.getMeta<string>(META_KEYS.deviceId)) ??
      String(doc.deviceId ?? doc.id);
    const now = new Date().toISOString();
    const event: OutboxEvent = {
      id: ulid(),
      businessId: String(doc.businessId ?? ""),
      branchId,
      deviceId,
      entity,
      entityId: doc.id,
      op: existing ? "update" : "insert",
      payload: doc as Record<string, unknown>,
      baseRevision: Number(existing?.revision ?? 0),
      dependsOn: [],
      attempts: 0,
      lastError: null,
      nextAttemptAt: now,
      createdAt: now,
      ackedAt: null,
      serverRevision: null,
    };
    await this.store.transaction(async (tx) => {
      await tx.put(collection, doc);
      await tx.enqueue([event]);
    });
  }

  private productCache = new Map<string, CatalogProduct>();
  private barcodeCache = new Map<string, BarcodeIndexEntry>();
  private levelCache = new Map<string, StockLevel>();
  private cacheLoaded = false;

  get storeKind() {
    return this.store.kind;
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                               */
  /* ------------------------------------------------------------------ */

  async init(): Promise<void> {
    await this.store.init();
    await this.reloadCaches();
  }

  /** Rebuild the in-memory caches from durable storage. */
  async reloadCaches(): Promise<void> {
    const [products, indexedBarcodes] = await Promise.all([
      this.store.getAll<CatalogProduct & StoreDoc>("products"),
      this.store.allBarcodes(),
    ]);

    this.productCache = new Map(
      products.map((product) => [product.id, product]),
    );
    this.barcodeCache = new Map(
      indexedBarcodes.map((entry) => [entry.barcode.toUpperCase(), entry]),
    );

    await this.refreshStockLevels();
    this.cacheLoaded = true;
  }

  async refreshStockLevels(): Promise<void> {
    const ledger = await this.store.getAll<InventoryLedgerEntry & StoreDoc>(
      "inventoryLedger",
    );
    this.levelCache = deriveStockLevels(ledger);
    // Reflect derived stock into the barcode index so a scanned item can show
    // availability without a second read (PRD §10.3 "scan-to-price-check").
    const updates: BarcodeIndexEntry[] = [];
    for (const [key, entry] of this.barcodeCache) {
      const level = this.levelCache.get(
        movementKey(entry.productId, entry.variantId, entry.branchId),
      );
      if (level && level.quantity !== entry.stock) {
        updates.push({ ...entry, stock: level.quantity });
        this.barcodeCache.set(key, { ...entry, stock: level.quantity });
      }
    }
    if (updates.length > 0) await this.store.putBarcodes(updates);
  }

  /* ------------------------------------------------------------------ */
  /* Meta & session                                                     */
  /* ------------------------------------------------------------------ */

  getMeta<T>(key: string) {
    return this.store.getMeta<T>(key);
  }

  setMeta<T>(key: string, value: T) {
    return this.store.setMeta(key, value);
  }

  /* ------------------------------------------------------------------ */
  /* Barcode scanning — the hot path                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Resolve a scan to a product.
   *
   * Reads the in-memory index first (microseconds), then the indexed store. An
   * unknown barcode is a first-class outcome with a recovery path, not an error
   * (PRD §10.3, §37).
   */
  async resolveScan(
    rawScan: string,
    branchId: string | null,
  ): Promise<ResolvedScan> {
    const code = normaliseScan(rawScan);
    if (!code)
      return {
        kind: "unknown",
        entry: null,
        candidates: [],
        message: "Empty scan",
      };

    const cached = this.barcodeCache.get(code);
    if (cached) {
      if (cached.status === "blocked") {
        return {
          kind: "blocked",
          entry: cached,
          candidates: [cached],
          message: `${cached.productName} is blocked from sale.`,
        };
      }
      if (cached.status === "archived") {
        return {
          kind: "blocked",
          entry: cached,
          candidates: [cached],
          message: `${cached.productName} has been archived.`,
        };
      }
      return {
        kind: "found",
        entry: cached,
        candidates: [cached],
        message: null,
      };
    }

    const stored = await this.store.getBarcode(code);
    if (!stored) {
      return {
        kind: "unknown",
        entry: null,
        candidates: [],
        message: `No product matches barcode ${code}.`,
      };
    }
    this.barcodeCache.set(code, stored);
    if (stored.status !== "active") {
      return {
        kind: "blocked",
        entry: stored,
        candidates: [stored],
        message: `${stored.productName} cannot be sold.`,
      };
    }
    void branchId;
    return {
      kind: "found",
      entry: stored,
      candidates: [stored],
      message: null,
    };
  }

  /** Synchronous cache-only lookup, for the scan feedback flash. */
  peekBarcode(rawScan: string): BarcodeIndexEntry | null {
    return this.barcodeCache.get(normaliseScan(rawScan)) ?? null;
  }

  /**
   * Guard a barcode assignment. Prevents the duplicate-barcode footgun where two
   * products silently share a code and the till sells the wrong one (PRD §10.3).
   */
  async checkBarcodeAvailable(
    barcode: string,
    productId: string,
    variantId: string | null,
  ) {
    const normalised = normaliseScan(barcode);
    const owner = await this.store.findBarcodeOwner(normalised);
    if (!owner) return { available: true as const, message: null };
    if (owner.productId === productId && owner.variantId === variantId) {
      return { available: true as const, message: null };
    }
    return {
      available: false as const,
      message: `Barcode ${normalised} is already assigned to "${owner.productName}".`,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Catalog                                                            */
  /* ------------------------------------------------------------------ */

  /** Snapshot for the product grid and search — no storage round trip. */
  catalog(): CatalogSnapshot {
    return {
      products: [...this.productCache.values()],
      barcodes: [...this.barcodeCache.values()],
      loadedAt: new Date().toISOString(),
    };
  }

  cachedProducts(): CatalogProduct[] {
    return [...this.productCache.values()];
  }

  isCacheLoaded() {
    return this.cacheLoaded;
  }

  getProductSync(id: string): CatalogProduct | null {
    return this.productCache.get(id) ?? null;
  }

  /**
   * Search by name, SKU or barcode. Ordered by a cheap relevance score so an
   * exact SKU or barcode match floats to the top (PRD §29 lookup priority).
   */
  search(
    query: string,
    limit = 60,
  ): Array<{ product: CatalogProduct; stock: number; score: number }> {
    const needle = query.trim().toLowerCase();
    const results: Array<{
      product: CatalogProduct;
      stock: number;
      score: number;
    }> = [];

    for (const product of this.productCache.values()) {
      if (product.status !== "active") continue;
      const name = product.name.toLowerCase();
      const sku = product.sku.toLowerCase();

      let score = 0;
      if (!needle) {
        score = 1;
      } else if (sku === needle) {
        score = 1000;
      } else if (name === needle) {
        score = 900;
      } else if (sku.startsWith(needle)) {
        score = 700;
      } else if (name.startsWith(needle)) {
        score = 600;
      } else if (name.includes(needle)) {
        score = 400;
      } else if ((product.brand ?? "").toLowerCase().includes(needle)) {
        score = 200;
      } else {
        continue;
      }

      const level = this.levelCache.get(
        movementKey(product.id, null, product.branchId ?? ""),
      );
      results.push({ product, stock: level?.quantity ?? 0, score });
    }

    results.sort(
      (a, b) =>
        b.score - a.score || a.product.name.localeCompare(b.product.name),
    );
    return results.slice(0, limit);
  }

  async listProducts(): Promise<CatalogProduct[]> {
    return this.store.query<CatalogProduct & StoreDoc>("products", () => true, {
      sortBy: "name",
    });
  }

  async saveProduct(product: CatalogProduct): Promise<void> {
    await this.saveSyncable(
      "products",
      "product",
      product as CatalogProduct & StoreDoc,
      product.branchId ?? null,
    );
    this.productCache.set(product.id, product);
  }

  async saveProducts(products: readonly CatalogProduct[]): Promise<void> {
    for (const product of products) await this.saveProduct(product);
    for (const product of products) this.productCache.set(product.id, product);
  }

  async archiveProduct(
    id: string,
    now = new Date().toISOString(),
  ): Promise<void> {
    const product = this.productCache.get(id);
    if (!product) return;
    const archived: CatalogProduct = {
      ...product,
      status: "archived",
      updatedAt: now,
    };
    await this.saveProduct(archived);
    const barcodes = [...this.barcodeCache.values()].filter(
      (entry) => entry.productId === id,
    );
    if (barcodes.length > 0) {
      await this.store.putBarcodes(
        barcodes.map((entry) => ({
          ...entry,
          status: "archived",
          updatedAt: now,
        })),
      );
      for (const entry of barcodes) {
        this.barcodeCache.set(entry.barcode, {
          ...entry,
          status: "archived",
          updatedAt: now,
        });
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Barcode index maintenance (PRD §10.4)                              */
  /* ------------------------------------------------------------------ */

  async indexCatalogProducts(
    products: readonly CatalogProduct[],
  ): Promise<number> {
    const entries = products.map((product) => createBarcodeIndexEntry(product));
    await this.store.putBarcodes(entries);
    for (const entry of entries)
      this.barcodeCache.set(entry.barcode.toUpperCase(), entry);
    return entries.length;
  }

  async assignBarcode(
    entry: BarcodeIndexEntry,
  ): Promise<{ ok: boolean; message: string | null }> {
    const check = await this.checkBarcodeAvailable(
      entry.barcode,
      entry.productId,
      entry.variantId,
    );
    if (!check.available) return { ok: false, message: check.message };
    await this.store.putBarcodes([entry]);
    this.barcodeCache.set(normaliseScan(entry.barcode), entry);
    const deviceId =
      (await this.store.getMeta<string>(META_KEYS.deviceId)) ?? entry.productId;
    const now = new Date().toISOString();
    await this.store.enqueue([
      {
        id: ulid(),
        businessId: entry.businessId,
        branchId: entry.branchId,
        deviceId,
        entity: "barcode",
        entityId: entry.barcode,
        op: "upsert",
        payload: entry as unknown as Record<string, unknown>,
        baseRevision: 0,
        dependsOn: [],
        attempts: 0,
        lastError: null,
        nextAttemptAt: now,
        createdAt: now,
        ackedAt: null,
        serverRevision: null,
      },
    ]);
    return { ok: true, message: null };
  }

  async removeBarcode(barcode: string): Promise<void> {
    const existing = await this.store.getBarcode(barcode);
    await this.store.deleteBarcode(barcode);
    this.barcodeCache.delete(normaliseScan(barcode));
    if (existing) {
      const deviceId =
        (await this.store.getMeta<string>(META_KEYS.deviceId)) ??
        existing.productId;
      const now = new Date().toISOString();
      await this.store.enqueue([
        {
          id: ulid(),
          businessId: existing.businessId,
          branchId: existing.branchId,
          deviceId,
          entity: "barcode",
          entityId: existing.barcode,
          op: "delete",
          payload: existing as unknown as Record<string, unknown>,
          baseRevision: 0,
          dependsOn: [],
          attempts: 0,
          lastError: null,
          nextAttemptAt: now,
          createdAt: now,
          ackedAt: null,
          serverRevision: null,
        },
      ]);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Inventory                                                          */
  /* ------------------------------------------------------------------ */

  stockFor(
    productId: string,
    variantId: string | null,
    branchId: string,
  ): number {
    return (
      this.levelCache.get(movementKey(productId, variantId, branchId))
        ?.quantity ?? 0
    );
  }

  levels(): Map<string, StockLevel> {
    return this.levelCache;
  }

  async listLedger(filter?: {
    productId?: string;
    branchId?: string;
    limit?: number;
  }): Promise<InventoryLedgerEntry[]> {
    return this.store.query<InventoryLedgerEntry & StoreDoc>(
      "inventoryLedger",
      (entry) => {
        if (filter?.productId && entry.productId !== filter.productId)
          return false;
        if (filter?.branchId && entry.branchId !== filter.branchId)
          return false;
        return true;
      },
      { sortBy: "occurredAt", direction: "desc", limit: filter?.limit ?? 300 },
    );
  }

  async recordMovements(
    movements: readonly InventoryLedgerEntry[],
    events: readonly OutboxEvent[],
  ): Promise<void> {
    await this.store.transaction(async (tx) => {
      await tx.putMany(
        "inventoryLedger",
        movements as unknown as Array<InventoryLedgerEntry & StoreDoc>,
      );
      await tx.enqueue(events);
    });
    await this.refreshStockLevels();
  }

  /* ------------------------------------------------------------------ */
  /* Sales                                                              */
  /* ------------------------------------------------------------------ */

  /** Per-device monotonic sequence, used in the receipt number. */
  async nextSequence(): Promise<number> {
    const current =
      (await this.store.getMeta<number>(META_KEYS.deviceSequence)) ?? 0;
    const next = current + 1;
    await this.store.setMeta(META_KEYS.deviceSequence, next);
    return next;
  }

  async peekSequence(): Promise<number> {
    return (await this.store.getMeta<number>(META_KEYS.deviceSequence)) ?? 0;
  }

  /**
   * THE COMMIT. Everything the sale produced lands together or not at all.
   *
   * Note what is NOT here: any network call, any retry, any connectivity check.
   * The commit is unconditional once local validation passed. That is what makes
   * PRD §45's acceptance criterion true rather than aspirational.
   */
  async commitSale(
    bundle: CommitBundle,
  ): Promise<{ sale: Sale; queued: number }> {
    await this.store.transaction(async (tx) => {
      await tx.put("sales", bundle.sale as unknown as Sale & StoreDoc);
      await tx.putMany(
        "saleLines",
        bundle.lines as unknown as Array<SaleLine & StoreDoc>,
      );
      await tx.putMany(
        "payments",
        bundle.payments as unknown as Array<StoreDoc>,
      );
      await tx.putMany(
        "inventoryLedger",
        bundle.inventory as unknown as Array<InventoryLedgerEntry & StoreDoc>,
      );
      await tx.putMany(
        "auditLogs",
        bundle.audit as unknown as Array<AuditLogEntry & StoreDoc>,
      );
      await tx.enqueue(bundle.events);
    });

    await this.refreshStockLevels();
    return {
      sale: bundle.sale as unknown as Sale,
      queued: bundle.events.length,
    };
  }

  async listSales(filter?: {
    branchId?: string;
    limit?: number;
    from?: string;
    to?: string;
  }): Promise<Sale[]> {
    return this.store.query<Sale & StoreDoc>(
      "sales",
      (sale) => {
        if (filter?.branchId && sale.branchId !== filter.branchId) return false;
        if (filter?.from && sale.committedAt < filter.from) return false;
        if (filter?.to && sale.committedAt > filter.to) return false;
        return true;
      },
      { sortBy: "committedAt", direction: "desc", limit: filter?.limit ?? 100 },
    );
  }

  async getSale(id: string): Promise<Sale | null> {
    return this.store.get<Sale & StoreDoc>("sales", id);
  }

  async findSaleByReceipt(receiptNumber: string): Promise<Sale | null> {
    const matches = await this.store.query<Sale & StoreDoc>(
      "sales",
      (sale) =>
        sale.receiptNumber.toUpperCase() === receiptNumber.trim().toUpperCase(),
      { limit: 1 },
    );
    return matches[0] ?? null;
  }

  async getSaleLines(saleId: string): Promise<SaleLine[]> {
    return this.store.query<SaleLine & StoreDoc>(
      "saleLines",
      (line) => line.saleId === saleId,
    );
  }

  async getSalePayments(saleId: string) {
    return this.store.query<StoreDoc>(
      "payments",
      (payment) => payment.saleId === saleId,
    );
  }

  async countSales(): Promise<number> {
    return this.store.count("sales");
  }

  /** Apply a sale status patch (void / returned) without touching history fields. */
  async patchSale(id: string, patch: Record<string, unknown>): Promise<void> {
    const sale = await this.getSale(id);
    if (!sale) return;
    await this.store.put("sales", { ...sale, ...patch } as Sale & StoreDoc);
  }

  async patchSaleLine(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const line = await this.store.get<SaleLine & StoreDoc>("saleLines", id);
    if (!line) return;
    await this.store.put("saleLines", { ...line, ...patch } as SaleLine &
      StoreDoc);
  }

  /* ------------------------------------------------------------------ */
  /* Held sales (PRD §11)                                               */
  /* ------------------------------------------------------------------ */

  async listHeldSales(deviceId?: string): Promise<Array<StoreDoc>> {
    return this.store.query<StoreDoc>(
      "heldSales",
      (held) => (deviceId ? held.deviceId === deviceId : true),
      { sortBy: "heldAt", direction: "desc" },
    );
  }

  async putHeldSale(held: StoreDoc): Promise<void> {
    await this.saveSyncable(
      "heldSales",
      "held_sale",
      held,
      String(held.branchId ?? ""),
    );
  }

  async removeHeldSale(id: string): Promise<void> {
    await this.store.delete("heldSales", id);
  }

  /* ------------------------------------------------------------------ */
  /* Returns                                                            */
  /* ------------------------------------------------------------------ */

  async commitReturn(bundle: ReturnBundle): Promise<void> {
    await this.store.transaction(async (tx) => {
      await tx.put("returns", bundle.returnRecord as StoreDoc);
      await tx.putMany(
        "returnLines",
        bundle.returnLines as unknown as StoreDoc[],
      );
      for (const patch of bundle.saleLinePatches) {
        const id = String(patch.id);
        const line = await tx.get<SaleLine & StoreDoc>("saleLines", id);
        if (line)
          await tx.put("saleLines", { ...line, ...patch } as SaleLine &
            StoreDoc);
      }
      await tx.putMany(
        "inventoryLedger",
        bundle.inventory as unknown as Array<InventoryLedgerEntry & StoreDoc>,
      );
      await tx.putMany(
        "auditLogs",
        bundle.audit as unknown as Array<AuditLogEntry & StoreDoc>,
      );
      await tx.enqueue(bundle.events);
    });
    await this.refreshStockLevels();
    await this.patchSale(String(bundle.salePatch.id), bundle.salePatch);
  }

  async listReturns(limit = 100): Promise<StoreDoc[]> {
    return this.store.query<StoreDoc>("returns", () => true, {
      sortBy: "committedAt",
      direction: "desc",
      limit,
    });
  }

  /* ------------------------------------------------------------------ */
  /* Customers, shifts, audit, conflicts                                */
  /* ------------------------------------------------------------------ */

  async listCustomers(): Promise<Customer[]> {
    return this.store.query<Customer & StoreDoc>(
      "customers",
      (c) => c.status !== "archived",
      { sortBy: "name" },
    );
  }

  async saveCustomer(customer: Customer): Promise<void> {
    await this.saveSyncable(
      "customers",
      "customer",
      customer as Customer & StoreDoc,
    );
  }

  /* ------------------------------------------------------------------ */
  /* Suppliers, purchasing, expenses, categories, counts, devices        */
  /* ------------------------------------------------------------------ */

  async listSuppliers(): Promise<Supplier[]> {
    return this.store.query<Supplier & StoreDoc>(
      "suppliers",
      (s) => s.status !== "archived",
      { sortBy: "name" },
    );
  }

  async saveSupplier(supplier: Supplier): Promise<void> {
    await this.saveSyncable(
      "suppliers",
      "supplier",
      supplier as Supplier & StoreDoc,
    );
  }

  async listPurchases(limit = 200): Promise<Purchase[]> {
    return this.store.query<Purchase & StoreDoc>("purchases", () => true, {
      sortBy: "createdAt",
      direction: "desc",
      limit,
    });
  }

  async savePurchase(purchase: Purchase): Promise<void> {
    await this.saveSyncable(
      "purchases",
      "purchase",
      purchase as Purchase & StoreDoc,
      purchase.branchId ?? null,
    );
  }

  async listExpenses(limit = 200): Promise<Expense[]> {
    return this.store.query<Expense & StoreDoc>("expenses", () => true, {
      sortBy: "spentAt",
      direction: "desc",
      limit,
    });
  }

  async saveExpense(expense: Expense): Promise<void> {
    await this.saveSyncable(
      "expenses",
      "expense",
      expense as Expense & StoreDoc,
      expense.branchId ?? null,
    );
  }

  async listExpenseCategories(): Promise<ExpenseCategory[]> {
    return this.store.query<ExpenseCategory & StoreDoc>(
      "expenseCategories",
      () => true,
      { sortBy: "name" },
    );
  }

  async saveExpenseCategory(category: ExpenseCategory): Promise<void> {
    await this.saveSyncable(
      "expenseCategories",
      "expense_category",
      category as ExpenseCategory & StoreDoc,
    );
  }

  async listCategories(): Promise<Category[]> {
    return this.store.query<Category & StoreDoc>("categories", () => true, {
      sortBy: "sortOrder",
    });
  }

  async saveCategory(category: Category): Promise<void> {
    await this.saveSyncable(
      "categories",
      "category",
      category as Category & StoreDoc,
    );
  }

  async listDevices(): Promise<Device[]> {
    return this.store.query<Device & StoreDoc>("devices", () => true, {
      sortBy: "registeredAt",
    });
  }

  async listStockCountSessions(limit = 50): Promise<StockCountSession[]> {
    return this.store.query<StockCountSession & StoreDoc>(
      "stockCountSessions",
      () => true,
      {
        sortBy: "startedAt",
        direction: "desc",
        limit,
      },
    );
  }

  async saveStockCountSession(session: StockCountSession): Promise<void> {
    await this.saveSyncable(
      "stockCountSessions",
      "stock_count_session",
      session as StockCountSession & StoreDoc,
      session.branchId,
    );
  }

  async listStockCountLines(sessionId: string): Promise<StockCountLine[]> {
    return this.store.query<StockCountLine & StoreDoc>(
      "stockCountLines",
      (line) => line.sessionId === sessionId,
      { sortBy: "id" },
    );
  }

  async saveStockCountLines(lines: readonly StockCountLine[]): Promise<void> {
    for (const line of lines) {
      await this.saveSyncable(
        "stockCountLines",
        "stock_count_line",
        line as StockCountLine & StoreDoc,
      );
    }
  }

  async applyRemoteBarcode(
    row: StoreDoc | null,
    barcode: string,
  ): Promise<void> {
    if (!row) {
      await this.store.deleteBarcode(barcode);
      this.barcodeCache.delete(normaliseScan(barcode));
      return;
    }
    const entry = row as unknown as BarcodeIndexEntry;
    await this.store.putBarcodes([entry]);
    this.barcodeCache.set(normaliseScan(entry.barcode), entry);
  }

  async getOpenShift(deviceId: string): Promise<Shift | null> {
    const matches = await this.store.query<Shift & StoreDoc>(
      "shifts",
      (shift) => shift.deviceId === deviceId && shift.status === "open",
      { limit: 1 },
    );
    return matches[0] ?? null;
  }

  async saveShift(shift: Shift): Promise<void> {
    await this.saveSyncable(
      "shifts",
      "shift",
      shift as Shift & StoreDoc,
      shift.branchId,
    );
    await this.store.setMeta(
      META_KEYS.activeShiftId,
      shift.status === "open" ? shift.id : null,
    );
  }

  async listShifts(limit = 50): Promise<Shift[]> {
    return this.store.query<Shift & StoreDoc>("shifts", () => true, {
      sortBy: "openedAt",
      direction: "desc",
      limit,
    });
  }

  async writeAudit(entry: AuditLogEntry, event?: OutboxEvent): Promise<void> {
    const syncEvent =
      event ??
      ({
        id: ulid(),
        businessId: entry.businessId,
        branchId: entry.branchId,
        deviceId: entry.deviceId,
        entity: "audit_log" as const,
        entityId: entry.id,
        op: "insert" as const,
        payload: entry as unknown as Record<string, unknown>,
        baseRevision: 0,
        dependsOn: [],
        attempts: 0,
        lastError: null,
        nextAttemptAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        ackedAt: null,
        serverRevision: null,
      } satisfies OutboxEvent);
    await this.store.transaction(async (tx) => {
      await tx.put("auditLogs", entry as unknown as AuditLogEntry & StoreDoc);
      await tx.enqueue([syncEvent]);
    });
  }

  async listAudit(limit = 200): Promise<AuditLogEntry[]> {
    return this.store.query<AuditLogEntry & StoreDoc>("auditLogs", () => true, {
      sortBy: "occurredAt",
      direction: "desc",
      limit,
    });
  }

  async listConflicts(
    status?: SyncConflict["status"],
  ): Promise<SyncConflict[]> {
    return this.store.query<SyncConflict & StoreDoc>(
      "conflicts",
      (conflict) => (status ? conflict.status === status : true),
      { sortBy: "detectedAt", direction: "desc" },
    );
  }

  async saveConflict(conflict: SyncConflict): Promise<void> {
    await this.store.put("conflicts", conflict as SyncConflict & StoreDoc);
  }

  async resolveConflictRecord(
    id: string,
    status: SyncConflict["status"],
    resolvedBy: string,
    note: string | null,
  ): Promise<void> {
    const conflict = await this.store.get<SyncConflict & StoreDoc>(
      "conflicts",
      id,
    );
    if (!conflict) return;
    await this.store.put("conflicts", {
      ...conflict,
      status,
      resolvedBy,
      resolvedAt: new Date().toISOString(),
      note,
    } as SyncConflict & StoreDoc);
  }

  /* ------------------------------------------------------------------ */
  /* Outbox pass-through (the sync engine owns policy)                  */
  /* ------------------------------------------------------------------ */

  pendingEvents(limit: number, nowIso: string) {
    return this.store.pendingEvents(limit, nowIso);
  }

  ackEvents(ids: readonly string[]) {
    return this.store.ackEvents(ids);
  }

  markEventFailed(id: string, error: string, nextAttemptAt: string) {
    return this.store.markEventFailed(id, error, nextAttemptAt);
  }

  outboxStats(): Promise<OutboxStats> {
    return this.store.outboxStats();
  }

  allPendingEvents(limit?: number) {
    return this.store.allPendingEvents(limit);
  }

  enqueue(events: readonly OutboxEvent[]) {
    return this.store.enqueue(events);
  }

  /* ------------------------------------------------------------------ */
  /* Operators and tenant                                               */
  /* ------------------------------------------------------------------ */

  async listUsers(): Promise<User[]> {
    return this.store.query<User & StoreDoc>("users", () => true, {
      sortBy: "fullName",
    });
  }

  async saveUser(user: User, event?: OutboxEvent): Promise<void> {
    await this.store.transaction(async (tx) => {
      await tx.put("users", user as User & StoreDoc);
      if (event) await tx.enqueue([event]);
    });
  }

  async listBranches(): Promise<Branch[]> {
    return this.store.query<Branch & StoreDoc>("branches", () => true, {
      sortBy: "name",
    });
  }

  async saveBranch(branch: Branch): Promise<void> {
    await this.saveSyncable(
      "branches",
      "branch",
      branch as Branch & StoreDoc,
      branch.id,
    );
  }

  async getBusiness(): Promise<Business | null> {
    const all = await this.store.query<Business & StoreDoc>(
      "business",
      () => true,
      { limit: 1 },
    );
    return all[0] ?? null;
  }

  async saveBusiness(business: Business): Promise<void> {
    await this.saveSyncable(
      "business",
      "business",
      business as Business & StoreDoc,
    );
  }

  async getDevice(): Promise<Device | null> {
    const all = await this.store.query<Device & StoreDoc>(
      "devices",
      () => true,
      { limit: 1 },
    );
    return all[0] ?? null;
  }

  async saveDevice(device: Device): Promise<void> {
    await this.saveSyncable(
      "devices",
      "device",
      device as Device & StoreDoc,
      device.branchId,
    );
  }

  async collectionCount(name: CollectionName): Promise<number> {
    return this.store.count(name);
  }

  /*
   * Collection-level pass-throughs. The sync engine needs to fold pulled rows
   * into arbitrary collections without going through a typed repository method
   * for each of the 28 entities, and it must NOT touch the catalog cache for
   * those writes (it reloads the cache once at the end of a pull instead of
   * once per row).
   */
  storeGet<T extends StoreDoc>(collection: CollectionName, id: string) {
    return this.store.get<T>(collection, id);
  }

  storePut<T extends StoreDoc>(collection: CollectionName, doc: T) {
    return this.store.put(collection, doc);
  }

  storeDelete(collection: CollectionName, id: string) {
    return this.store.delete(collection, id);
  }

  async wipe(): Promise<void> {
    await this.store.wipe();
    this.productCache.clear();
    this.barcodeCache.clear();
    this.levelCache.clear();
    this.cacheLoaded = false;
  }
}

let singleton: PosaData | null = null;

export function getData(store: LocalStore): PosaData {
  if (!singleton) singleton = new PosaData(store);
  return singleton;
}

export function peekData(): PosaData | null {
  return singleton;
}

export function resetData(): void {
  singleton = null;
}

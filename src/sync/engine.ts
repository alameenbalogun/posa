/**
 * The sync engine (PRD §21, §36, §39).
 *
 * THE CONTRACT WITH THE REST OF THE APPLICATION:
 *   - The engine never blocks a sale. It is a background loop over a durable queue.
 *   - Nothing it does can create or destroy a financial record. It moves events
 *     that already exist from the local queue to the cloud, and updates local
 *     copies from the cloud. The commit already happened.
 *   - If the cloud is not configured, it idles and reports that fact. It does not
 *     retry, warn, or degrade anything.
 *
 * FAILURE HANDLING, precisely (PRD §37 "Sync failed" / "Duplicate sync"):
 *   applied | duplicate  -> acknowledge, never re-send.
 *   dependency_missing   -> retry soon: the parent is simply behind in the queue.
 *   rate_limited         -> retry with backoff.
 *   transient            -> retry with backoff, capped.
 *   rejected (permanent) -> stop retrying, park the event as a conflict so a
 *                           human sees it in the Sync Center rather than the
 *                           queue silently growing forever.
 *   conflict (stale)     -> the server kept its version and stored both; we
 *                           record it locally and acknowledge the event, because
 *                           re-sending it would only re-conflict.
 */

import type {
  OutboxEvent,
  SyncConflict,
  SyncPushResponse,
} from "@/domain/sync-protocol";
import { backoffDelayMs, isRetryable } from "@/domain/sync-protocol";
import type { CollectionName } from "@/data/local";
import { META_KEYS, type StoreDoc } from "@/data/local";
import type { PosaData } from "@/data/repositories";
import {
  subscribeToChanges,
  type RealtimeSubscription,
} from "@/cloud/realtime";
import { connectivity, type ConnectivitySnapshot } from "./connectivity";
import { ulid } from "@/domain/ulid";

/**
 * Where pulled rows land locally. `null` means "this device does not keep a copy"
 * — tenant configuration and settings live only in the cloud for the features
 * that never need them offline.
 */
export const ENTITY_COLLECTION: Record<string, CollectionName | null> = {
  // Plural aliases keep clients compatible with change_log rows created before
  // migration 0007 was applied.
  businesses: "business",
  branches: "branches",
  users: "users",
  devices: "devices",
  categories: "categories",
  products: "products",
  variants: "variants",
  barcodes: null,
  user: "users",
  business: "business",
  branch: "branches",
  device: "devices",
  category: "categories",
  product: "products",
  variant: "variants",
  barcode: null, // handled through the denormalised barcode index below
  price_override: "priceOverrides",
  price_history: "priceHistory",
  inventory_ledger: "inventoryLedger",
  stock_count_session: "stockCountSessions",
  stock_count_line: "stockCountLines",
  stock_transfer: "stockTransfers",
  sale: "sales",
  sale_line: "saleLines",
  payment: "payments",
  held_sale: "heldSales",
  return: "returns",
  return_line: "returnLines",
  customer: "customers",
  supplier: "suppliers",
  purchase: "purchases",
  shift: "shifts",
  cash_movement: "cashMovements",
  expense_category: "expenseCategories",
  expense: "expenses",
  audit_log: "auditLogs",
};

export type SyncState =
  | "unconfigured"
  | "idle"
  | "syncing"
  | "offline"
  | "error";

export interface SyncStatus {
  state: SyncState;
  cloudConfigured: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  pending: number;
  failing: number;
  openConflicts: number;
  /** Enqueue time of the oldest unsent event — drives the "waiting since" copy. */
  oldestPendingAt: string | null;
  cursor: string | null;
  /** Events acknowledged in the most recent successful push. */
  lastPushed: number;
  lastPulled: number;
  online: boolean;
}

/** The minimal transport the engine needs. Matches `SyncTransport`. */
export interface SyncEngineTransport {
  push(input: {
    deviceId: string;
    businessId: string;
    sequence: number;
    events: readonly OutboxEvent[];
  }): Promise<SyncPushResponse>;
  pull(input: {
    deviceId: string;
    businessId: string;
    branchId: string | null;
    cursor: string | null;
    limit?: number;
  }): Promise<{
    cursor: string;
    serverTime: string;
    hasMore: boolean;
    changes: Array<{
      entity: string;
      entityId: string;
      op: string;
      revision: number;
      row: Record<string, unknown> | null;
    }>;
  }>;
}

export interface SyncEngineOptions {
  data: PosaData;
  transport: SyncEngineTransport | null;
  deviceId: string;
  businessId: string;
  branchId: string | null;
  /** Read the device's current outbound sequence for the ack watermark. */
  getSequence: () => Promise<number>;
  onStatusChange?: (status: SyncStatus) => void;
  /** Notify the application after remote rows have been folded into storage. */
  onDataChanged?: () => void | Promise<void>;
  /** Batch size for a single push. Bounded so a huge backlog still makes progress. */
  batchSize?: number;
  intervalMs?: number;
}

export class SyncEngine {
  private readonly options: SyncEngineOptions;
  private status: SyncStatus;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeConnectivity: (() => void) | null = null;
  private realtimeSub: RealtimeSubscription | null = null;
  private running = false;
  private inFlight = false;

  constructor(options: SyncEngineOptions) {
    this.options = options;
    this.status = {
      state: options.transport ? "idle" : "unconfigured",
      cloudConfigured: options.transport !== null,
      lastSyncAt: null,
      lastError: null,
      pending: 0,
      failing: 0,
      openConflicts: 0,
      oldestPendingAt: null,
      cursor: null,
      lastPushed: 0,
      lastPulled: 0,
      online: connectivity.current.state !== "offline",
    };
  }

  get current(): SyncStatus {
    return this.status;
  }

  /* ------------------------------------------------------------------ */

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.status.lastSyncAt = await this.options.data.getMeta<string>(
      META_KEYS.lastSyncAt,
    );
    this.status.cursor = await this.options.data.getMeta<string>(
      META_KEYS.syncCursor,
    );
    await this.refreshCounters();
    this.publish();

    connectivity.start();
    this.unsubscribeConnectivity = connectivity.subscribe((snapshot) =>
      this.onConnectivity(snapshot),
    );

    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.intervalMs ?? 20_000);

    // First tick happens soon after boot but NOT during it: the till must be
    // usable before any network work is attempted (PRD §39).
    setTimeout(() => void this.tick(), 3_000);

    // Realtime: listen for cross-device changes so we pull immediately.
    this.startRealtime();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribeConnectivity?.();
    this.unsubscribeConnectivity = null;
    this.realtimeSub?.unsubscribe();
    this.realtimeSub = null;
    connectivity.stop();
  }

  private async startRealtime(): Promise<void> {
    if (this.realtimeSub) return;
    this.realtimeSub = await subscribeToChanges(this.options.businessId, () => {
      // Another device pushed changes — pull immediately rather than
      // waiting for the next poll interval (PRD §39).
      if (this.running && !this.inFlight) void this.tick();
    });
  }

  private onConnectivity(snapshot: ConnectivitySnapshot): void {
    const online = snapshot.state !== "offline";
    if (online !== this.status.online) {
      this.status.online = online;
      this.publish();
    }
    // Coming back online is the moment to drain the queue.
    if (online && this.status.cloudConfigured) void this.tick();
  }

  private async refreshCounters(): Promise<void> {
    const [stats, conflicts] = await Promise.all([
      this.options.data.outboxStats(),
      this.options.data.listConflicts("open"),
    ]);
    this.status.pending = stats.pending;
    this.status.failing = stats.failing;
    this.status.oldestPendingAt = stats.oldestPendingAt;
    this.status.openConflicts = conflicts.length;
  }

  private publish(): void {
    this.options.onStatusChange?.({ ...this.status });
  }

  /* ------------------------------------------------------------------ */
  /* The loop                                                           */
  /* ------------------------------------------------------------------ */

  async tick(): Promise<void> {
    if (!this.running || this.inFlight) return;

    if (!this.options.transport) {
      // Local-only build: stay quiet, keep the counters honest for the UI.
      await this.refreshCounters();
      this.status.state = "unconfigured";
      this.publish();
      return;
    }

    if (connectivity.current.state === "offline") {
      await this.refreshCounters();
      this.status.state = "offline";
      this.publish();
      return;
    }

    this.inFlight = true;
    this.status.state = "syncing";
    this.publish();

    try {
      const pushed = await this.drainOutbox();
      const pulled = await this.pull();

      this.status.lastPushed = pushed;
      this.status.lastPulled = pulled;
      this.status.lastError = null;
      this.status.state = "idle";
      this.status.lastSyncAt = new Date().toISOString();
      await this.options.data.setMeta(
        META_KEYS.lastSyncAt,
        this.status.lastSyncAt,
      );
      await this.options.data.setMeta(META_KEYS.lastSyncError, null);
      connectivity.reportCloudResult(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.status.lastError = message;
      this.status.state = "error";
      await this.options.data.setMeta(META_KEYS.lastSyncError, message);
      connectivity.reportCloudResult(false);
    } finally {
      await this.refreshCounters();
      this.inFlight = false;
      this.publish();
    }
  }

  /**
   * Push everything due, in dependency-safe order, until the queue is drained or
   * a batch makes no progress. Returns how many events were acknowledged.
   */
  async drainOutbox(): Promise<number> {
    const transport = this.options.transport;
    if (!transport) return 0;

    const batchSize = this.options.batchSize ?? 100;
    const sequence = await this.options.getSequence();
    let acknowledged = 0;
    let rounds = 0;

    while (rounds < 20) {
      rounds += 1;
      const now = new Date().toISOString();
      const batch = await this.options.data.pendingEvents(batchSize, now);
      if (batch.length === 0) break;

      const response = await transport.push({
        deviceId: this.options.deviceId,
        businessId: this.options.businessId,
        sequence,
        events: batch,
      });

      if (response.reauthRequired) {
        throw new Error(
          "Cloud rejected this terminal. Sign in again to resume syncing.",
        );
      }

      const acked: string[] = [];
      const byId = new Map(batch.map((event) => [event.id, event]));

      for (const result of response.results) {
        const event = byId.get(result.eventId);
        if (!event) continue;

        if (result.status === "applied" || result.status === "duplicate") {
          acked.push(result.eventId);
          continue;
        }

        if (result.status === "conflict") {
          // The server kept its copy and stored both versions. Acknowledge so we
          // stop re-sending, and surface it locally for a human (PRD §21.3).
          acked.push(result.eventId);
          await this.recordConflict(
            event,
            result.serverRecord,
            result.message ?? "Version conflict.",
          );
          continue;
        }

        // Rejected.
        if (isRetryable(result.code)) {
          await this.options.data.markEventFailed(
            event.id,
            result.message ?? "Temporarily rejected.",
            new Date(
              Date.now() + backoffDelayMs(event.attempts + 1),
            ).toISOString(),
          );
        } else {
          // Permanent. Park it far in the future and record it, so it appears in
          // the Sync Center instead of retrying for eternity.
          await this.options.data.markEventFailed(
            event.id,
            result.message ?? `Rejected: ${result.code ?? "unknown"}`,
            new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
          );
          await this.recordConflict(
            event,
            null,
            result.message ?? `Rejected: ${result.code ?? "unknown"}`,
          );
        }
      }

      // Only ack AFTER the whole batch is accounted for: if we crash mid-batch we
      // would rather re-send (idempotent) than lose an event.
      if (acked.length > 0) {
        await this.options.data.ackEvents(acked);
        acknowledged += acked.length;
      }

      await this.options.data.setMeta(META_KEYS.syncCursor, response.cursor);
      this.status.cursor = response.cursor;

      // A batch where nothing was acknowledged means we are blocked on a
      // dependency that is parked; stop instead of spinning.
      if (acked.length === 0) break;
      if (batch.length < batchSize) break;
    }

    return acknowledged;
  }

  /**
   * Pull remote changes and fold them into local storage.
   *
   * Note the reconciliation rule: a pulled row never overwrites a local row that
   * still has unsynced local changes, because the local edit is the newer intent
   * and the server will hear about it on the next push. Append-only entities are
   * inserted only if absent.
   */
  async pull(): Promise<number> {
    const transport = this.options.transport;
    if (!transport) return 0;

    const cursor = await this.options.data.getMeta<string>(
      META_KEYS.syncCursor,
    );
    const response = await transport.pull({
      deviceId: this.options.deviceId,
      businessId: this.options.businessId,
      branchId: this.options.branchId,
      cursor,
      limit: 500,
    });

    let applied = 0;
    for (const change of response.changes) {
      const collection = ENTITY_COLLECTION[change.entity];
      if (change.entity === "barcode") {
        await this.options.data.applyRemoteBarcode(
          change.row ? (change.row as StoreDoc) : null,
          change.entityId,
        );
        applied += 1;
        continue;
      }
      if (!collection) continue;
      if (!change.row) {
        await this.options.data.storeDelete(collection, change.entityId);
        applied += 1;
        continue;
      }

      const existing = await this.options.data.storeGet<StoreDoc>(
        collection,
        change.entityId,
      );
      const localIsDirty =
        existing &&
        typeof existing.syncState === "string" &&
        existing.syncState === "local";
      if (localIsDirty) continue;

      await this.options.data.storePut(collection, {
        ...change.row,
        id: change.entityId,
        revision: change.revision,
        syncState: "synced",
        deletedAt: (change.row.deletedAt as string | null) ?? null,
      } as StoreDoc);
      applied += 1;
    }

    if (response.changes.length > 0 || response.cursor !== cursor) {
      await this.options.data.setMeta(META_KEYS.syncCursor, response.cursor);
      this.status.cursor = response.cursor;
      // The catalog cache must reflect anything we just learned.
      await this.options.data.reloadCaches();
      await this.options.onDataChanged?.();
    }

    return applied;
  }

  private async recordConflict(
    event: OutboxEvent,
    serverRecord: unknown,
    message: string,
  ): Promise<void> {
    const conflict: SyncConflict = {
      id: ulid(),
      businessId: event.businessId,
      deviceId: event.deviceId,
      entity: event.entity,
      entityId: event.entityId,
      localPayload: event.payload,
      localRevision: event.baseRevision,
      serverPayload: serverRecord ?? null,
      serverRevision:
        (serverRecord as { revision?: number } | null)?.revision ?? 0,
      detectedAt: new Date().toISOString(),
      status: "open",
      resolvedBy: null,
      resolvedAt: null,
      note: message,
    };
    await this.options.data.saveConflict(conflict);
  }

  /** Force an immediate attempt — used by the "Sync now" button. */
  async syncNow(): Promise<SyncStatus> {
    await this.tick();
    return this.current;
  }

  /**
   * Pull ALL data from the cloud (cursor=0). Used on first sign-in or when
   * the app needs to bootstrap from the cloud before showing the UI.
   * This is a blocking call — the app should show a loading indicator.
   */
  async pullAll(): Promise<number> {
    const transport = this.options.transport;
    if (!transport) return 0;

    // Reset cursor to 0 so we pull everything
    await this.options.data.setMeta(META_KEYS.syncCursor, "0");

    let totalPulled = 0;
    let hasMore = true;
    let cursor: string | null = "0";

    while (hasMore) {
      const response = await transport.pull({
        deviceId: this.options.deviceId,
        businessId: this.options.businessId,
        branchId: this.options.branchId,
        cursor,
        limit: 500,
      });

      for (const change of response.changes) {
        const collection = ENTITY_COLLECTION[change.entity];
        if (change.entity === "barcode") {
          await this.options.data.applyRemoteBarcode(
            change.row ? (change.row as StoreDoc) : null,
            change.entityId,
          );
          totalPulled += 1;
          continue;
        }
        if (!collection) continue;
        if (!change.row) {
          await this.options.data.storeDelete(collection, change.entityId);
          totalPulled += 1;
          continue;
        }

        const existing = await this.options.data.storeGet<StoreDoc>(
          collection,
          change.entityId,
        );
        const localIsDirty =
          existing &&
          typeof existing.syncState === "string" &&
          existing.syncState === "local";
        if (localIsDirty) continue;

        await this.options.data.storePut(collection, {
          ...change.row,
          id: change.entityId,
          revision: change.revision,
          syncState: "synced",
          deletedAt: (change.row.deletedAt as string | null) ?? null,
        } as StoreDoc);
        totalPulled += 1;
      }

      hasMore = response.hasMore;
      cursor = response.cursor;
      await this.options.data.setMeta(META_KEYS.syncCursor, response.cursor);
      this.status.cursor = response.cursor;
    }

    if (totalPulled > 0) {
      await this.options.data.reloadCaches();
      await this.options.onDataChanged?.();
    }

    return totalPulled;
  }

  /** How many events have backed off too far to be retried automatically. */
  async needsAttention(): Promise<boolean> {
    const stats = await this.options.data.outboxStats();
    return stats.failing > 0;
  }
}

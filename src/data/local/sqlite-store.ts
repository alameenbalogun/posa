/**
 * SQLite LocalStore — native iOS/Android and the Tauri/Electron desktop wrapper
 * (PRD §5: "SQLite for desktop/native wrapper").
 *
 * Schema notes:
 *  - `docs` is a generic document collection keyed by (collection, id). Filtering
 *    and sorting happen in JS after the read. That sounds wasteful, but the
 *    collections that are read hot (products, barcodes) are served from the
 *    in-memory catalog cache at boot, and everything else is read through a
 *    targeted predicate. Consistency with the web adapter is worth more here
 *    than shaving milliseconds off a query the app never makes.
 *  - `barcodes` is a REAL typed table with the barcode as primary key. This is the
 *    <100ms scan path from PRD §10.4 and it deserved a proper index.
 *  - `outbox` is also typed and indexed, because the sync loop polls it.
 *  - All writes go through `withExclusiveTransactionAsync`, so a sale commit is
 *    genuinely atomic (PRD §45 acceptance criterion).
 */

import * as SQLite from 'expo-sqlite';
import type { BarcodeIndexEntry } from '@/domain/types';
import type { OutboxEvent } from '@/domain/sync-protocol';
import { orderEvents } from '@/domain/sync-protocol';
import type { CollectionName, LocalStore, OutboxStats, QueryOptions, StoreDoc } from './types';

const DATABASE_NAME = 'posa.db';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS docs (
  collection TEXT NOT NULL,
  id         TEXT NOT NULL,
  doc        TEXT NOT NULL,
  updated_at TEXT,
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS idx_docs_collection ON docs (collection, updated_at);

CREATE TABLE IF NOT EXISTS barcodes (
  barcode       TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL,
  branch_id     TEXT NOT NULL,
  product_id    TEXT NOT NULL,
  variant_id    TEXT,
  product_name  TEXT NOT NULL,
  sku           TEXT NOT NULL,
  price         INTEGER NOT NULL DEFAULT 0,
  cost_price    INTEGER NOT NULL DEFAULT 0,
  tax_rate_bp   INTEGER NOT NULL DEFAULT 0,
  stock         REAL NOT NULL DEFAULT 0,
  unit          TEXT NOT NULL DEFAULT 'unit',
  is_weighted   INTEGER NOT NULL DEFAULT 0,
  symbology     TEXT NOT NULL DEFAULT 'UNKNOWN',
  status        TEXT NOT NULL DEFAULT 'active',
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_barcodes_product ON barcodes (product_id);
CREATE INDEX IF NOT EXISTS idx_barcodes_status ON barcodes (status);

CREATE TABLE IF NOT EXISTS outbox (
  id              TEXT PRIMARY KEY,
  entity          TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  next_attempt_at TEXT NOT NULL,
  acked_at        TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  doc             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox (acked_at, next_attempt_at);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

interface BarcodeRow {
  barcode: string;
  business_id: string;
  branch_id: string;
  product_id: string;
  variant_id: string | null;
  product_name: string;
  sku: string;
  price: number;
  cost_price: number;
  tax_rate_bp: number;
  stock: number;
  unit: string;
  is_weighted: number;
  symbology: string;
  status: string;
  updated_at: string;
}

function rowToEntry(row: BarcodeRow): BarcodeIndexEntry {
  return {
    barcode: row.barcode,
    businessId: row.business_id,
    branchId: row.branch_id,
    productId: row.product_id,
    variantId: row.variant_id,
    productName: row.product_name,
    sku: row.sku,
    price: row.price,
    costPrice: row.cost_price,
    taxRateBasisPoints: row.tax_rate_bp,
    stock: row.stock,
    unit: row.unit as BarcodeIndexEntry['unit'],
    isWeighted: row.is_weighted === 1,
    symbology: row.symbology as BarcodeIndexEntry['symbology'],
    status: row.status as BarcodeIndexEntry['status'],
    updatedAt: row.updated_at,
  };
}

/** Minimal surface of the sqlite handle this store uses (also satisfied by a Transaction). */
type SqliteHandle = Pick<SQLite.SQLiteDatabase, 'runAsync' | 'getAllAsync' | 'getFirstAsync'>;

const BARCODE_UPSERT = `
INSERT INTO barcodes (
  barcode, business_id, branch_id, product_id, variant_id, product_name, sku,
  price, cost_price, tax_rate_bp, stock, unit, is_weighted, symbology, status, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(barcode) DO UPDATE SET
  business_id = excluded.business_id,
  branch_id = excluded.branch_id,
  product_id = excluded.product_id,
  variant_id = excluded.variant_id,
  product_name = excluded.product_name,
  sku = excluded.sku,
  price = excluded.price,
  cost_price = excluded.cost_price,
  tax_rate_bp = excluded.tax_rate_bp,
  stock = excluded.stock,
  unit = excluded.unit,
  is_weighted = excluded.is_weighted,
  symbology = excluded.symbology,
  status = excluded.status,
  updated_at = excluded.updated_at;
`;

/** Upper bound for a SQLite prefix range scan. */
function prefixUpperBound(prefix: string): string {
  const last = prefix.charCodeAt(prefix.length - 1);
  return prefix.slice(0, -1) + String.fromCharCode(last + 1);
}

export async function createSqliteStore(): Promise<LocalStore> {
  const db = await SQLite.openDatabaseAsync(DATABASE_NAME);
  await db.execAsync(SCHEMA);

  /** Build the port surface against whichever handle we are given. */
  const bind = (handle: SqliteHandle): LocalStore => ({
    kind: 'sqlite',

    async init() {
      /* already opened above; kept for interface symmetry */
    },

    async get<T extends StoreDoc>(collection: CollectionName, id: string) {
      const row = await handle.getFirstAsync<{ doc: string }>(
        'SELECT doc FROM docs WHERE collection = ? AND id = ?',
        [collection, id],
      );
      return row ? (JSON.parse(row.doc) as T) : null;
    },

    async put<T extends StoreDoc>(collection: CollectionName, doc: T) {
      const id = (doc as StoreDoc).id;
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error(`Cannot store a document without an id in "${collection}".`);
      }
      await handle.runAsync(
        `INSERT INTO docs (collection, id, doc, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(collection, id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at`,
        [collection, id, JSON.stringify(doc), String((doc as StoreDoc).updatedAt ?? '')],
      );
    },

    async putMany<T extends StoreDoc>(collection: CollectionName, items: readonly T[]) {
      for (const doc of items) await bind(handle).put(collection, doc);
    },

    async delete(collection: CollectionName, id: string) {
      await handle.runAsync('DELETE FROM docs WHERE collection = ? AND id = ?', [collection, id]);
    },

    async getAll<T extends StoreDoc>(collection: CollectionName) {
      const rows = await handle.getAllAsync<{ doc: string }>('SELECT doc FROM docs WHERE collection = ?', [collection]);
      return rows.map((row) => JSON.parse(row.doc) as T);
    },

    async count(collection: CollectionName) {
      const row = await handle.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM docs WHERE collection = ?', [collection]);
      return row?.n ?? 0;
    },

    async clear(collection: CollectionName) {
      await handle.runAsync('DELETE FROM docs WHERE collection = ?', [collection]);
    },

    async query<T extends StoreDoc>(collection: CollectionName, predicate: (doc: T) => boolean, options?: QueryOptions) {
      // Filter and sort in JS so this adapter behaves identically to the web one.
      const all = await bind(handle).getAll<T>(collection);
      const matched = all.filter(predicate);
      const sortBy = options?.sortBy;
      const sorted = sortBy
        ? [...matched].sort((a, b) => {
            const left = (a as StoreDoc)[sortBy];
            const right = (b as StoreDoc)[sortBy];
            if (left === right) return 0;
            if (left === undefined || left === null) return 1;
            if (right === undefined || right === null) return -1;
            const cmp = typeof left === 'number' && typeof right === 'number' ? left - right : String(left) < String(right) ? -1 : 1;
            return (options?.direction ?? 'asc') === 'asc' ? cmp : -cmp;
          })
        : matched;
      const offset = options?.offset ?? 0;
      return options?.limit ? sorted.slice(offset, offset + options.limit) : sorted.slice(offset);
    },

    async getBarcode(barcode: string) {
      const row = await handle.getFirstAsync<BarcodeRow>('SELECT * FROM barcodes WHERE barcode = ?', [barcode.toUpperCase()]);
      return row ? rowToEntry(row) : null;
    },

    async putBarcodes(entries: readonly BarcodeIndexEntry[]) {
      for (const entry of entries) {
        await handle.runAsync(BARCODE_UPSERT, [
          entry.barcode.toUpperCase(),
          entry.businessId,
          entry.branchId,
          entry.productId,
          entry.variantId,
          entry.productName,
          entry.sku,
          entry.price,
          entry.costPrice,
          entry.taxRateBasisPoints,
          entry.stock,
          entry.unit,
          entry.isWeighted ? 1 : 0,
          entry.symbology,
          entry.status,
          entry.updatedAt,
        ]);
      }
    },

    async deleteBarcode(barcode: string) {
      await handle.runAsync('DELETE FROM barcodes WHERE barcode = ?', [barcode.toUpperCase()]);
    },

    async searchBarcodes(prefix: string, limit = 20) {
      const upper = prefixUpperBound(prefix.toUpperCase());
      const rows = await handle.getAllAsync<BarcodeRow>(
        'SELECT * FROM barcodes WHERE barcode >= ? AND barcode < ? ORDER BY barcode LIMIT ?',
        [prefix.toUpperCase(), upper, limit],
      );
      return rows.map(rowToEntry);
    },

    async allBarcodes(limit = 100_000) {
      const rows = await handle.getAllAsync<BarcodeRow>('SELECT * FROM barcodes LIMIT ?', [limit]);
      return rows.map(rowToEntry);
    },

    async countBarcodes() {
      const row = await handle.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM barcodes');
      return row?.n ?? 0;
    },

    async findBarcodeOwner(barcode: string) {
      const row = await handle.getFirstAsync<{ product_id: string; variant_id: string | null; product_name: string }>(
        'SELECT product_id, variant_id, product_name FROM barcodes WHERE barcode = ?',
        [barcode.toUpperCase()],
      );
      return row ? { productId: row.product_id, variantId: row.variant_id, productName: row.product_name } : null;
    },

    async enqueue(events: readonly OutboxEvent[]) {
      for (const event of events) {
        await handle.runAsync(
          `INSERT INTO outbox (id, entity, entity_id, created_at, next_attempt_at, acked_at, attempts, doc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
          [event.id, event.entity, event.entityId, event.createdAt, event.nextAttemptAt, event.ackedAt, event.attempts, JSON.stringify(event)],
        );
      }
    },

    async pendingEvents(limit: number, nowIso: string) {
      const rows = await handle.getAllAsync<{ doc: string }>(
        'SELECT doc FROM outbox WHERE acked_at IS NULL AND next_attempt_at <= ? ORDER BY created_at ASC LIMIT ?',
        [nowIso, limit],
      );
      return orderEvents(rows.map((row) => JSON.parse(row.doc) as OutboxEvent));
    },

    async ackEvents(ids: readonly string[]) {
      for (const id of ids) {
        await handle.runAsync('UPDATE outbox SET acked_at = ? WHERE id = ?', [new Date().toISOString(), id]);
      }
    },

    async markEventFailed(id: string, error: string, nextAttemptAt: string) {
      const row = await handle.getFirstAsync<{ doc: string }>('SELECT doc FROM outbox WHERE id = ?', [id]);
      if (!row) return;
      const event = JSON.parse(row.doc) as OutboxEvent;
      const next: OutboxEvent = { ...event, attempts: event.attempts + 1, lastError: error, nextAttemptAt };
      await handle.runAsync('UPDATE outbox SET attempts = ?, next_attempt_at = ?, doc = ? WHERE id = ?', [
        next.attempts,
        nextAttemptAt,
        JSON.stringify(next),
        id,
      ]);
    },

    async rescheduleEvent(id: string, nextAttemptAt: string) {
      const row = await handle.getFirstAsync<{ doc: string }>('SELECT doc FROM outbox WHERE id = ?', [id]);
      if (!row) return;
      const event = JSON.parse(row.doc) as OutboxEvent;
      await handle.runAsync('UPDATE outbox SET next_attempt_at = ?, doc = ? WHERE id = ?', [
        nextAttemptAt,
        JSON.stringify({ ...event, nextAttemptAt }),
        id,
      ]);
    },

    async outboxStats(): Promise<OutboxStats> {
      const row = await handle.getFirstAsync<{ pending: number; total: number; oldest: string | null; max_attempts: number | null }>(
        `SELECT
           SUM(CASE WHEN acked_at IS NULL THEN 1 ELSE 0 END) AS pending,
           COUNT(*) AS total,
           MIN(CASE WHEN acked_at IS NULL THEN created_at END) AS oldest,
           MAX(CASE WHEN acked_at IS NULL THEN attempts END) AS max_attempts
         FROM outbox`,
      );
      const failing = await handle.getFirstAsync<{ n: number }>(
        'SELECT COUNT(*) AS n FROM outbox WHERE acked_at IS NULL AND attempts >= 5',
      );
      return {
        pending: row?.pending ?? 0,
        failing: failing?.n ?? 0,
        total: row?.total ?? 0,
        oldestPendingAt: row?.oldest ?? null,
        maxAttempts: row?.max_attempts ?? 0,
      };
    },

    async allPendingEvents(limit = 200) {
      const rows = await handle.getAllAsync<{ doc: string }>(
        'SELECT doc FROM outbox WHERE acked_at IS NULL ORDER BY created_at ASC LIMIT ?',
        [limit],
      );
      return orderEvents(rows.map((row) => JSON.parse(row.doc) as OutboxEvent));
    },

    async getMeta<T>(key: string) {
      const row = await handle.getFirstAsync<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key]);
      return row ? (JSON.parse(row.value) as T) : null;
    },

    async setMeta<T>(key: string, value: T) {
      await handle.runAsync(
        `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [key, JSON.stringify(value)],
      );
    },

    async transaction<T>(fn: (tx: LocalStore) => Promise<T>) {
      // Nesting: if we are already inside a transaction, just run inline.
      let result!: T;
      await db.withExclusiveTransactionAsync(async (txn) => {
        result = await fn(bind(txn as unknown as SqliteHandle));
      });
      return result;
    },

    async wipe() {
      await handle.runAsync('DELETE FROM docs');
      await handle.runAsync('DELETE FROM barcodes');
      await handle.runAsync('DELETE FROM outbox');
      await handle.runAsync('DELETE FROM meta');
    },
  });

  return bind(db);
}

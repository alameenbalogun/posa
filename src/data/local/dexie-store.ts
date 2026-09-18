/**
 * IndexedDB LocalStore via Dexie — web and PWA (PRD §5: "IndexedDB with Dexie
 * for web/PWA").
 *
 * Mirrors the SQLite adapter's semantics exactly so the app cannot behave
 * differently depending on which till you are standing in front of.
 *
 * Notes:
 *  - `docs` uses a compound primary key [collection+id] so one object store
 *    serves every collection without a schema migration per entity.
 *  - `barcodes` is its own store with the barcode as primary key and an index on
 *    productId: this is the <100ms scan path.
 *  - `outbox` is indexed on [ackedAt+nextAttemptAt] so the sync loop does not
 *    scan the whole queue.
 *  - Dexie gives us real transactions; all writes inside `transaction()` join the
 *    same zone, which is what makes the sale commit atomic.
 */

import Dexie, { type Table } from "dexie";
import type { BarcodeIndexEntry } from "@/domain/types";
import type { OutboxEvent } from "@/domain/sync-protocol";
import { orderEvents } from "@/domain/sync-protocol";
import type {
  CollectionName,
  LocalStore,
  OutboxStats,
  QueryOptions,
  StoreDoc,
} from "./types";

interface DocRow {
  collection: string;
  id: string;
  doc: StoreDoc;
  updatedAt: string;
}

interface OutboxRow {
  id: string;
  nextAttemptAt: string;
  ackedAt: string | null;
  createdAt: string;
  attempts: number;
  doc: OutboxEvent;
}

class PosaDatabase extends Dexie {
  docs!: Table<DocRow, [string, string]>;
  barcodes!: Table<BarcodeIndexEntry, string>;
  outbox!: Table<OutboxRow, string>;
  meta!: Table<{ key: string; value: unknown }, string>;

  constructor() {
    super("posa-local");
    this.version(1).stores({
      docs: "[collection+id], collection, updatedAt",
      barcodes: "barcode, productId, status",
      outbox: "id, ackedAt, nextAttemptAt, createdAt, attempts",
      meta: "key",
    });
  }
}

const db = new PosaDatabase();

function prefixUpperBound(prefix: string): string {
  const last = prefix.charCodeAt(prefix.length - 1);
  return prefix.slice(0, -1) + String.fromCharCode(last + 1);
}

export function createDexieStore(): LocalStore {
  const store: LocalStore = {
    kind: "dexie",

    async init() {
      if (!db.isOpen()) await db.open();
    },

    async get<T extends StoreDoc>(collection: CollectionName, id: string) {
      const row = await db.docs.get([collection, id]);
      return row ? (row.doc as T) : null;
    },

    async put<T extends StoreDoc>(collection: CollectionName, doc: T) {
      const id = (doc as StoreDoc).id;
      if (typeof id !== "string" || id.length === 0) {
        throw new Error(
          `Cannot store a document without an id in "${collection}".`,
        );
      }
      await db.docs.put({
        collection,
        id,
        doc,
        updatedAt: String((doc as StoreDoc).updatedAt ?? ""),
      });
    },

    async putMany<T extends StoreDoc>(
      collection: CollectionName,
      items: readonly T[],
    ) {
      await db.docs.bulkPut(
        items.map((doc) => ({
          collection,
          id: String((doc as StoreDoc).id),
          doc,
          updatedAt: String((doc as StoreDoc).updatedAt ?? ""),
        })),
      );
    },

    async delete(collection: CollectionName, id: string) {
      await db.docs.delete([collection, id]);
    },

    async getAll<T extends StoreDoc>(collection: CollectionName) {
      const rows = await db.docs
        .where("collection")
        .equals(collection)
        .toArray();
      return rows.map((row) => row.doc as T);
    },

    async count(collection: CollectionName) {
      return db.docs.where("collection").equals(collection).count();
    },

    async clear(collection: CollectionName) {
      const keys = await db.docs
        .where("collection")
        .equals(collection)
        .primaryKeys();
      await db.docs.bulkDelete(keys);
    },

    async query<T extends StoreDoc>(
      collection: CollectionName,
      predicate: (doc: T) => boolean,
      options?: QueryOptions,
    ) {
      const all = await store.getAll<T>(collection);
      const matched = all.filter(predicate);
      const sortBy = options?.sortBy;
      const sorted = sortBy
        ? [...matched].sort((a, b) => {
            const left = (a as StoreDoc)[sortBy];
            const right = (b as StoreDoc)[sortBy];
            if (left === right) return 0;
            if (left === undefined || left === null) return 1;
            if (right === undefined || right === null) return -1;
            const cmp =
              typeof left === "number" && typeof right === "number"
                ? left - right
                : String(left) < String(right)
                  ? -1
                  : 1;
            return (options?.direction ?? "asc") === "asc" ? cmp : -cmp;
          })
        : matched;
      const offset = options?.offset ?? 0;
      return options?.limit
        ? sorted.slice(offset, offset + options.limit)
        : sorted.slice(offset);
    },

    async getBarcode(barcode: string) {
      return (await db.barcodes.get(barcode.toUpperCase())) ?? null;
    },

    async putBarcodes(entries: readonly BarcodeIndexEntry[]) {
      await db.barcodes.bulkPut(
        entries.map((entry) => ({
          ...entry,
          barcode: entry.barcode.toUpperCase(),
        })),
      );
    },

    async deleteBarcode(barcode: string) {
      await db.barcodes.delete(barcode.toUpperCase());
    },

    async searchBarcodes(prefix: string, limit = 20) {
      const normalized = prefix.toUpperCase();
      if (!normalized) return db.barcodes.limit(limit).toArray();
      const upper = prefixUpperBound(normalized);
      return db.barcodes
        .where("barcode")
        .between(normalized, upper, true, false)
        .limit(limit)
        .toArray();
    },

    async allBarcodes(limit = 100_000) {
      return db.barcodes.limit(limit).toArray();
    },

    async countBarcodes() {
      return db.barcodes.count();
    },

    async findBarcodeOwner(barcode: string) {
      const entry = await db.barcodes.get(barcode.toUpperCase());
      if (!entry) return null;
      return {
        productId: entry.productId,
        variantId: entry.variantId,
        productName: entry.productName,
      };
    },

    async enqueue(events: readonly OutboxEvent[]) {
      await db.outbox.bulkPut(
        events.map((event) => ({
          id: event.id,
          nextAttemptAt: event.nextAttemptAt,
          ackedAt: event.ackedAt,
          createdAt: event.createdAt,
          attempts: event.attempts,
          doc: event,
        })),
      );
    },

    async pendingEvents(limit: number, nowIso: string) {
      const rows = await db.outbox
        .filter((row) => row.ackedAt === null && row.nextAttemptAt <= nowIso)
        .limit(limit * 2)
        .toArray();
      return orderEvents(rows.map((row) => row.doc)).slice(0, limit);
    },

    async ackEvents(ids: readonly string[]) {
      const now = new Date().toISOString();
      await db.transaction("rw", db.outbox, async () => {
        for (const id of ids) {
          const row = await db.outbox.get(id);
          if (!row) continue;
          await db.outbox.put({
            ...row,
            ackedAt: now,
            doc: { ...row.doc, ackedAt: now },
          });
        }
      });
    },

    async markEventFailed(id: string, error: string, nextAttemptAt: string) {
      const row = await db.outbox.get(id);
      if (!row) return;
      const attempts = row.attempts + 1;
      await db.outbox.put({
        ...row,
        attempts,
        nextAttemptAt,
        doc: { ...row.doc, attempts, lastError: error, nextAttemptAt },
      });
    },

    async rescheduleEvent(id: string, nextAttemptAt: string) {
      const row = await db.outbox.get(id);
      if (!row) return;
      await db.outbox.put({
        ...row,
        nextAttemptAt,
        doc: { ...row.doc, nextAttemptAt },
      });
    },

    async outboxStats(): Promise<OutboxStats> {
      const all = await db.outbox.toArray();
      const pending = all.filter((row) => row.ackedAt === null);
      return {
        pending: pending.length,
        failing: pending.filter((row) => row.attempts >= 5).length,
        total: all.length,
        oldestPendingAt: pending.length
          ? pending.reduce(
              (min, row) => (row.createdAt < min ? row.createdAt : min),
              pending[0].createdAt,
            )
          : null,
        maxAttempts: pending.reduce(
          (max, row) => Math.max(max, row.attempts),
          0,
        ),
      };
    },

    async allPendingEvents(limit = 200) {
      const rows = await db.outbox
        .filter((row) => row.ackedAt === null)
        .limit(limit * 2)
        .toArray();
      return orderEvents(rows.map((row) => row.doc)).slice(0, limit);
    },

    async getMeta<T>(key: string) {
      const row = await db.meta.get(key);
      return row ? (row.value as T) : null;
    },

    async setMeta<T>(key: string, value: T) {
      await db.meta.put({ key, value });
    },

    async transaction<T>(fn: (tx: LocalStore) => Promise<T>) {
      return db.transaction(
        "rw",
        [db.docs, db.barcodes, db.outbox, db.meta],
        async () => fn(store),
      );
    },

    async wipe() {
      await db.transaction(
        "rw",
        [db.docs, db.barcodes, db.outbox, db.meta],
        async () => {
          await db.docs.clear();
          await db.barcodes.clear();
          await db.outbox.clear();
          await db.meta.clear();
        },
      );
    },
  };

  return store;
}

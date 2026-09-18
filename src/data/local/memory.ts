/**
 * In-memory LocalStore.
 *
 * Used by the domain/repository tests, by the web preview when IndexedDB is
 * unavailable (private browsing, some embedded webviews), and as the reference
 * implementation the other adapters are checked against.
 *
 * It is NOT a toy: it implements the same transactional semantics, so the
 * atomic-commit test against it is meaningful.
 */

import type { BarcodeIndexEntry } from '@/domain/types';
import type { OutboxEvent } from '@/domain/sync-protocol';
import { orderEvents } from '@/domain/sync-protocol';
import type { CollectionName, LocalStore, OutboxStats, QueryOptions, StoreDoc } from './types';

type Snapshot = Map<CollectionName, Map<string, StoreDoc>>;

export function createMemoryStore(): LocalStore {
  let docs: Snapshot = new Map();
  let barcodes = new Map<string, BarcodeIndexEntry>();
  let outbox = new Map<string, OutboxEvent>();
  let meta = new Map<string, unknown>();

  const collection = (name: CollectionName): Map<string, StoreDoc> => {
    let bucket = docs.get(name);
    if (!bucket) {
      bucket = new Map();
      docs.set(name, bucket);
    }
    return bucket;
  };

  const applySort = <T extends StoreDoc>(
    rows: T[],
    sortBy: string | undefined,
    direction: 'asc' | 'desc' | undefined,
  ): T[] => {
    if (!sortBy) return rows;
    const dir = direction ?? 'asc';
    return [...rows].sort((a, b) => {
      const left = a[sortBy];
      const right = b[sortBy];
      if (left === right) return 0;
      if (left === undefined || left === null) return 1;
      if (right === undefined || right === null) return -1;
      const comparison = typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left) < String(right)
          ? -1
          : 1;
      return dir === 'asc' ? comparison : -comparison;
    });
  };

  const store: LocalStore = {
    kind: 'memory',

    async init() {
      /* nothing to open */
    },

    async get<T extends StoreDoc>(name: CollectionName, id: string) {
      return (collection(name).get(id) as T | undefined) ?? null;
    },

    async put<T extends StoreDoc>(name: CollectionName, doc: T) {
      const id = (doc as StoreDoc).id;
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error(`Cannot store a document without an id in "${name}".`);
      }
      collection(name).set(id, doc);
    },

    async putMany<T extends StoreDoc>(name: CollectionName, items: readonly T[]) {
      for (const doc of items) await store.put(name, doc);
    },

    async delete(name: CollectionName, id: string) {
      collection(name).delete(id);
    },

    async getAll<T extends StoreDoc>(name: CollectionName) {
      return [...collection(name).values()] as T[];
    },

    async count(name: CollectionName) {
      return collection(name).size;
    },

    async clear(name: CollectionName) {
      docs.set(name, new Map());
    },

    async query<T extends StoreDoc>(
      name: CollectionName,
      predicate: (doc: T) => boolean,
      options?: QueryOptions,
    ) {
      const matched = ([...collection(name).values()] as T[]).filter(predicate);
      const sorted = applySort(matched, options?.sortBy, options?.direction);
      const offset = options?.offset ?? 0;
      return options?.limit ? sorted.slice(offset, offset + options.limit) : sorted.slice(offset);
    },

    async getBarcode(barcode: string) {
      return barcodes.get(barcode.toUpperCase()) ?? null;
    },

    async putBarcodes(entries: readonly BarcodeIndexEntry[]) {
      for (const entry of entries) barcodes.set(entry.barcode.toUpperCase(), entry);
    },

    async deleteBarcode(barcode: string) {
      barcodes.delete(barcode.toUpperCase());
    },

    async searchBarcodes(prefix: string, limit = 20) {
      const needle = prefix.toUpperCase();
      const out: BarcodeIndexEntry[] = [];
      for (const [key, entry] of barcodes) {
        if (key.startsWith(needle)) {
          out.push(entry);
          if (out.length >= limit) break;
        }
      }
      return out;
    },

    async allBarcodes(limit = 100_000) {
      return [...barcodes.values()].slice(0, limit);
    },

    async countBarcodes() {
      return barcodes.size;
    },

    async findBarcodeOwner(barcode: string) {
      const entry = barcodes.get(barcode.toUpperCase());
      if (!entry) return null;
      return { productId: entry.productId, variantId: entry.variantId, productName: entry.productName };
    },

    async enqueue(events: readonly OutboxEvent[]) {
      for (const event of events) outbox.set(event.id, event);
    },

    async pendingEvents(limit: number, nowIso: string) {
      const due = [...outbox.values()].filter(
        (event) => event.ackedAt === null && event.nextAttemptAt <= nowIso,
      );
      return orderEvents(due).slice(0, limit);
    },

    async ackEvents(ids: readonly string[]) {
      for (const id of ids) {
        const event = outbox.get(id);
        if (event) outbox.set(id, { ...event, ackedAt: new Date().toISOString() });
      }
    },

    async markEventFailed(id: string, error: string, nextAttemptAt: string) {
      const event = outbox.get(id);
      if (event) outbox.set(id, { ...event, attempts: event.attempts + 1, lastError: error, nextAttemptAt });
    },

    async rescheduleEvent(id: string, nextAttemptAt: string) {
      const event = outbox.get(id);
      if (event) outbox.set(id, { ...event, nextAttemptAt });
    },

    async outboxStats(): Promise<OutboxStats> {
      const all = [...outbox.values()];
      const pending = all.filter((e) => e.ackedAt === null);
      return {
        pending: pending.length,
        failing: pending.filter((e) => e.attempts >= 5).length,
        total: all.length,
        oldestPendingAt: pending.length ? pending.reduce((min, e) => (e.createdAt < min ? e.createdAt : min), pending[0].createdAt) : null,
        maxAttempts: pending.reduce((max, e) => Math.max(max, e.attempts), 0),
      };
    },

    async allPendingEvents(limit = 200) {
      return orderEvents([...outbox.values()].filter((e) => e.ackedAt === null)).slice(0, limit);
    },

    async getMeta<T>(key: string) {
      return (meta.get(key) as T | undefined) ?? null;
    },

    async setMeta<T>(key: string, value: T) {
      meta.set(key, value);
    },

    async transaction<T>(fn: (tx: LocalStore) => Promise<T>) {
      // Snapshot every mutable structure so a throw rolls the whole unit back.
      const docsBackup: Snapshot = new Map(
        [...docs.entries()].map(([name, bucket]) => [name, new Map(bucket)]),
      );
      const barcodesBackup = new Map(barcodes);
      const outboxBackup = new Map(outbox);
      const metaBackup = new Map(meta);
      try {
        return await fn(store);
      } catch (error) {
        docs = docsBackup;
        barcodes = barcodesBackup;
        outbox = outboxBackup;
        meta = metaBackup;
        throw error;
      }
    },

    async wipe() {
      docs = new Map();
      barcodes = new Map();
      outbox = new Map();
      meta = new Map();
    },
  };

  return store;
}

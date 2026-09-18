/**
 * Web/PWA entry point — Metro picks this file for `platform = web`.
 *
 * Falls back to the in-memory adapter when IndexedDB is unavailable (private
 * browsing, sandboxed iframes, some embedded POS webviews). A till that cannot
 * persist is still better than a till that will not boot, as long as we TELL the
 * operator — see `ActiveStore.isEphemeral`, which the shell surfaces as a
 * warning banner.
 */

import { createDexieStore } from './dexie-store';
import { createMemoryStore } from './memory';
import type { LocalStore } from './types';

export type { CollectionName, LocalStore, OutboxStats, QueryOptions, StoreDoc } from './types';
export { COLLECTIONS, META_KEYS } from './types';
export { createMemoryStore } from './memory';

function indexedDbAvailable(): boolean {
  try {
    if (typeof globalThis === 'undefined') return false;
    return typeof (globalThis as { indexedDB?: unknown }).indexedDB !== 'undefined';
  } catch {
    return false;
  }
}

let cached: Promise<LocalStore> | null = null;

export function createLocalStore(): Promise<LocalStore> {
  if (!cached) {
    cached = (async () => {
      if (!indexedDbAvailable()) {
        console.warn('[posa] IndexedDB unavailable — falling back to in-memory storage. Sales will not survive a reload.');
        return createMemoryStore();
      }
      try {
        const store = createDexieStore();
        await store.init();
        return store;
      } catch (error) {
        console.warn('[posa] IndexedDB failed to open, falling back to memory.', error);
        return createMemoryStore();
      }
    })();
  }
  return cached;
}

export function resetLocalStoreCache(): void {
  cached = null;
}

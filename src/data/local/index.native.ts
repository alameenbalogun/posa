/**
 * Native/desktop entry point — Metro picks this file for ios/android (and for the
 * Tauri/Electron wrapper, which runs the same RN runtime).
 */

import { createSqliteStore } from './sqlite-store';
import type { LocalStore } from './types';

export type { CollectionName, LocalStore, OutboxStats, QueryOptions, StoreDoc } from './types';
export { COLLECTIONS, META_KEYS } from './types';
export { createMemoryStore } from './memory';

let cached: Promise<LocalStore> | null = null;

export function createLocalStore(): Promise<LocalStore> {
  if (!cached) cached = createSqliteStore();
  return cached;
}

export function resetLocalStoreCache(): void {
  cached = null;
}

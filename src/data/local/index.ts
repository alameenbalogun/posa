/**
 * Default (non-platform-specific) entry point.
 *
 * Metro resolves `index.web.ts` for the web bundle and `index.native.ts` for
 * iOS/Android/desktop BEFORE it ever considers this file, so this module only
 * runs in: Node (tests), type-checking, and any future runtime that is not
 * web or native. It deliberately points at SQLite rather than IndexedDB because
 * the desktop wrapper (Tauri/Electron) is the remaining real target.
 *
 * Keeping all three files exporting the identical `createLocalStore` signature
 * is what lets the rest of the application stay platform-agnostic.
 */

import type { LocalStore } from './types';

export type { CollectionName, LocalStore, OutboxStats, QueryOptions, StoreDoc } from './types';
export { COLLECTIONS, META_KEYS } from './types';
export { createMemoryStore } from './memory';

let cached: Promise<LocalStore> | null = null;

export function createLocalStore(): Promise<LocalStore> {
  if (!cached) {
    cached = import('./sqlite-store').then((module) => module.createSqliteStore());
  }
  return cached;
}

export function resetLocalStoreCache(): void {
  cached = null;
}

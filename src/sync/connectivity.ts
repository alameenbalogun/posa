/**
 * Connectivity monitoring (PRD §6, §21).
 *
 * One rule shapes this file: a terminal must never *depend* on knowing its
 * connectivity to keep selling. So this is an OPTIMISATION signal ("try syncing
 * now") and a UI signal ("you are offline"), never a gate. If the check is wrong
 * — and OS connectivity APIs are frequently wrong behind captive portals — the
 * worst outcome is a failed request that gets queued for retry.
 *
 * Platform specifics:
 *   - native: expo-network, which knows about wifi/cellular state.
 *   - web: `navigator.onLine` plus online/offline events. `navigator.onLine`
 *     only reports "a network interface exists", which is why we always confirm
 *     with a real request before declaring the cloud reachable.
 */

import { Platform } from 'react-native';

export type ConnectivityState = 'online' | 'offline' | 'unknown';

export interface ConnectivitySnapshot {
  state: ConnectivityState;
  /** Native network type where available (wifi, cellular, none). */
  type: string | null;
  /** True when the last real cloud request succeeded. */
  cloudReachable: boolean | null;
  checkedAt: string;
}

type Listener = (snapshot: ConnectivitySnapshot) => void;

export class ConnectivityMonitor {
  private snapshot: ConnectivitySnapshot = {
    state: 'unknown',
    type: null,
    cloudReachable: null,
    checkedAt: new Date().toISOString(),
  };

  private listeners = new Set<Listener>();
  private webHandlersAttached = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  get current(): ConnectivitySnapshot {
    return this.snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  private emit(next: Partial<ConnectivitySnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next, checkedAt: new Date().toISOString() };
    for (const listener of this.listeners) listener(this.snapshot);
  }

  /**
   * Begin observing. The poll keeps the indicator honest for terminals left
   * running all day behind a router that silently loses its uplink.
   */
  start(pollMs = 30_000): void {
    if (Platform.OS === 'web') this.attachWeb();
    else void this.attachNative();

    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      void this.refresh();
    }, pollMs);
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (Platform.OS === 'web' && this.webHandlersAttached) {
      globalThis.removeEventListener?.('online', this.onWebOnline);
      globalThis.removeEventListener?.('offline', this.onWebOffline);
      this.webHandlersAttached = false;
    }
  }

  private onWebOnline = () => {
    this.emit({ state: 'online', type: 'browser' });
  };

  private onWebOffline = () => {
    this.emit({ state: 'offline', type: 'none', cloudReachable: false });
  };

  private attachWeb(): void {
    if (typeof globalThis === 'undefined') return;
    const nav = globalThis.navigator as { onLine?: boolean } | undefined;
    this.emit({
      state: nav?.onLine === false ? 'offline' : 'online',
      type: 'browser',
    });
    if (!this.webHandlersAttached) {
      globalThis.addEventListener?.('online', this.onWebOnline);
      globalThis.addEventListener?.('offline', this.onWebOffline);
      this.webHandlersAttached = true;
    }
  }

  private async attachNative(): Promise<void> {
    try {
      const Network = await import('expo-network');
      const state = await Network.getNetworkStateAsync();
      this.emit({
        state: state.isInternetReachable === false || state.isConnected === false ? 'offline' : 'online',
        type: state.type ?? null,
      });
    } catch {
      // Module unavailable (e.g. a bare JS runtime). Assume online and let the
      // real request decide — failing open is correct for a till.
      this.emit({ state: 'unknown', type: null });
    }
  }

  /** Re-check and, on native, update the snapshot. Cheap and safe to call often. */
  async refresh(): Promise<ConnectivitySnapshot> {
    if (Platform.OS === 'web') this.attachWeb();
    else await this.attachNative();
    return this.snapshot;
  }

  /** Called by the sync engine after a real request, the only trustworthy signal. */
  reportCloudResult(reachable: boolean): void {
    this.emit({
      cloudReachable: reachable,
      state: reachable ? 'online' : this.snapshot.state === 'offline' ? 'offline' : 'unknown',
    });
  }
}

export const connectivity = new ConnectivityMonitor();

/** Convenience for UI: should we attempt a network operation right now? */
export function shouldAttemptNetwork(): boolean {
  const { state, cloudReachable } = connectivity.current;
  if (cloudReachable === false) return false;
  return state !== 'offline';
}

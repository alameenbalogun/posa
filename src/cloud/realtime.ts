/**
 * Supabase Realtime — cross-device push notifications (PRD §6, §21.2, §39).
 *
 * WHY THIS EXISTS
 * ----------------
 * Without Realtime, the sync engine polls every 20 seconds. That's fine for
 * background reconciliation, but it means Device B won't know about a sale on
 * Device A until the next tick. Realtime closes that gap: Supabase broadcasts
 * a lightweight notification whenever a row lands in `change_log`, and the
 * receiving device immediately pulls the new changes.
 *
 * The notification carries NO payload data — just "something changed". The
 * actual data arrives through the normal `sync_pull` path, which applies the
 * same idempotency, conflict, and tenant-safety checks as every other pull.
 * This keeps the Realtime layer thin, safe, and easy to test.
 *
 * DESIGN CONSTRAINT
 * -----------------
 * Realtime is an OPTIMISATION, not a requirement. If the WebSocket drops, the
 * polling loop catches up on the next interval. If Supabase Realtime is not
 * enabled on the table, the subscription silently fails and the app continues
 * with polling only. Nothing in the product depends on this working.
 */

import { getSupabaseClient } from './client';
import { isSupabaseConfigured } from './config';

export type RealtimeCallback = (payload: {
  entity: string;
  entityId: string;
  operation: string;
}) => void;

export interface RealtimeSubscription {
  unsubscribe: () => void;
  status: 'connected' | 'disconnected';
}

/**
 * Subscribe to `change_log` inserts for a specific business. Every insert
 * triggers the callback with entity metadata so the sync engine can pull
 * immediately instead of waiting for the next poll tick.
 *
 * Returns an unsubscribe handle. Safe to call even if the client is null
 * (local-only mode) — the returned handle is a no-op.
 */
export async function subscribeToChanges(
  businessId: string,
  callback: RealtimeCallback,
): Promise<RealtimeSubscription> {
  const noop: RealtimeSubscription = {
    unsubscribe: () => {},
    status: 'disconnected',
  };

  if (!isSupabaseConfigured()) return noop;

  const client = await getSupabaseClient();
  if (!client) return noop;

  // The real Supabase JS client has `.channel()` and `.removeChannel()` methods
  // that our narrow `SupabaseLike` interface does not expose. We reach through
  // an unsafe cast: if the client is anything other than the real Supabase JS
  // client, the channel call will throw and we catch it, returning the noop.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase: any = client;
    const channel = supabase.channel(`posa:changes:${businessId}`);

    channel.on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'change_log',
        filter: `business_id=eq.${businessId}`,
      },
      (payload: { new?: Record<string, unknown> }) => {
        const row = payload.new;
        if (!row) return;
        callback({
          entity: String(row.entity ?? ''),
          entityId: String(row.entity_id ?? ''),
          operation: String(row.op ?? 'insert'),
        });
      },
    );

    channel.subscribe();

    return {
      unsubscribe: () => {
        try {
          supabase.removeChannel(channel);
        } catch {
          // Channel may already be removed — safe to ignore.
        }
      },
      status: 'connected',
    };
  } catch {
    // Realtime unavailable on this client (e.g., test stub, or Supabase JS
    // version without channel support). Polling continues as the fallback.
    return noop;
  }
}

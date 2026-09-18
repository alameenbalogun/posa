/**
 * The client/server sync contract (PRD §21, §33).
 *
 * This file is the single source of truth for the wire format. It lives in the
 * domain layer, with no runtime dependencies, so that the same types are used by
 * the till, the reconciler and the edge function. A protocol that is only
 * described in prose drifts; a protocol described in types does not.
 *
 * THREE RULES encoded here:
 *
 *  1. Every mutation is an immutable EVENT with a globally unique id generated
 *     BEFORE the network is involved. Retrying is therefore always safe.
 *  2. Events carry their causal rank so the server can reject an out-of-order
 *     arrival instead of creating a sale with no stock movement (PRD §21.2
 *     "dependency-safe order").
 *  3. The server is the arbiter of conflicts, never the last writer to arrive.
 */

import type { Id } from './types';

export type EntityKind =
  | 'business'
  | 'branch'
  | 'user'
  | 'device'
  | 'category'
  | 'product'
  | 'variant'
  | 'barcode'
  | 'price_override'
  | 'price_history'
  | 'inventory_ledger'
  | 'stock_count_session'
  | 'stock_count_line'
  | 'stock_transfer'
  | 'sale'
  | 'sale_line'
  | 'payment'
  | 'held_sale'
  | 'return'
  | 'return_line'
  | 'customer'
  | 'supplier'
  | 'purchase'
  | 'purchase_line'
  | 'shift'
  | 'cash_movement'
  | 'expense'
  | 'expense_category'
  | 'audit_log'
  | 'settings';

export type MutationOp = 'insert' | 'update' | 'upsert' | 'delete';

/**
 * Causal ranks. An event may only be applied once every event of a lower rank
 * for the same aggregate has been applied. Concretely: a `sale_line` can never
 * land before its `sale`, and an `inventory_ledger` entry can never land before
 * the sale that caused it.
 */
export const ENTITY_RANK: Record<EntityKind, number> = {
  business: 0,
  settings: 0,
  branch: 1,
  user: 2,
  device: 2,
  category: 3,
  product: 3,
  variant: 4,
  barcode: 4,
  price_override: 4,
  price_history: 4,
  customer: 3,
  supplier: 3,
  expense_category: 3,
  inventory_ledger: 5,
  stock_count_session: 5,
  stock_count_line: 6,
  stock_transfer: 5,
  shift: 5,
  cash_movement: 6,
  expense: 6,
  purchase: 5,
  purchase_line: 6,
  sale: 5,
  sale_line: 6,
  payment: 6,
  held_sale: 6,
  return: 6,
  return_line: 7,
  audit_log: 9,
};

export function entityRank(kind: EntityKind): number {
  return ENTITY_RANK[kind] ?? 9;
}

export interface OutboxEvent<T = unknown> {
  /** ULID. This IS the idempotency key — retries reuse it verbatim. */
  id: Id;
  businessId: Id;
  branchId: Id | null;
  deviceId: Id;
  entity: EntityKind;
  entityId: Id;
  op: MutationOp;
  /** The full row (insert/upsert) or the patch (update). */
  payload: T;
  /** Per-row client revision at write time, for optimistic concurrency. */
  baseRevision: number;
  /** Dependent event ids that must be acknowledged first. */
  dependsOn: Id[];
  attempts: number;
  lastError: string | null;
  /** Exponential backoff target time. */
  nextAttemptAt: string;
  createdAt: string;
  /** Set once the server acknowledges. */
  ackedAt: string | null;
  /** Server-side applied revision, for the pull cursor. */
  serverRevision: number | null;
}

export interface SyncPushRequest {
  deviceId: Id;
  businessId: Id;
  /** Highest sequence this device has ever emitted, for gap detection. */
  clientSequence: number;
  events: OutboxEvent[];
  /** Server clock skew assistance (PRD §46 "device clock differs"). */
  clientTime: string;
}

export interface EventResult {
  eventId: Id;
  status: 'applied' | 'duplicate' | 'rejected' | 'conflict';
  /** Set when applied or duplicate: the authoritative revision. */
  revision: number | null;
  /** Set when rejected/conflict — a machine-readable code plus human text. */
  code?: SyncRejectionCode;
  message?: string;
  /** The server's version of the row, for the conflict UI. */
  serverRecord?: unknown;
}

export type SyncRejectionCode =
  | 'validation_failed'
  | 'unauthorized'
  | 'tenant_mismatch'
  | 'dependency_missing'
  | 'stale_revision'
  | 'immutable_record'
  | 'device_revoked'
  | 'rate_limited'
  | 'transient';

export interface SyncPushResponse {
  /** Server time, used to correct a drifting device clock. */
  serverTime: string;
  results: EventResult[];
  /** New cursor to pass to the next pull. */
  cursor: string;
  /** True when the device should stop pushing and re-authenticate. */
  reauthRequired: boolean;
}

export interface SyncPullRequest {
  deviceId: Id;
  businessId: Id;
  branchId: Id | null;
  /** Opaque cursor from the previous response. */
  cursor: string | null;
  /** Entities this device cares about, so we never pull another branch's data. */
  entities?: EntityKind[];
  limit?: number;
}

export interface SyncPullResponse {
  cursor: string;
  serverTime: string;
  /** False means "nothing new"; the client can idle longer. */
  hasMore: boolean;
  changes: Array<{
    entity: EntityKind;
    entityId: Id;
    op: MutationOp;
    revision: number;
    row: Record<string, unknown> | null;
  }>;
}

/* ------------------------------------------------------------------ */
/* Conflict policy (PRD §21.3)                                         */
/* ------------------------------------------------------------------ */

export type ConflictStrategy =
  /** Newest `updatedAt` wins. Only safe for soft, non-financial metadata. */
  | 'last_write_wins'
  /** Server value always wins; the client discards its local edit. */
  | 'server_wins'
  /** Client value wins only if the server row is unchanged since baseRevision. */
  | 'optimistic'
  /** Never auto-merge. Surfaced to an administrator (PRD §21.3, §46). */
  | 'manual_review'
  /** Rejected outright — financial history is immutable (PRD §47). */
  | 'immutable';

/**
 * Where each entity sits on the conflict spectrum.
 *
 * The asymmetry is the point: inventory ledger entries and completed sales are
 * facts that already happened in the physical world. They are append-only, so
 * there is nothing to merge — the only question is ordering, which the ULID
 * answers. Product metadata, by contrast, is a shared opinion and needs a policy.
 */
export const CONFLICT_STRATEGY: Record<EntityKind, ConflictStrategy> = {
  business: 'optimistic',
  settings: 'manual_review',
  branch: 'optimistic',
  user: 'server_wins',
  device: 'server_wins',
  category: 'last_write_wins',
  product: 'optimistic',
  variant: 'optimistic',
  barcode: 'manual_review',
  price_override: 'manual_review',
  price_history: 'immutable',
  inventory_ledger: 'immutable',
  stock_count_session: 'optimistic',
  stock_count_line: 'optimistic',
  stock_transfer: 'optimistic',
  sale: 'immutable',
  sale_line: 'immutable',
  payment: 'immutable',
  held_sale: 'last_write_wins',
  return: 'immutable',
  return_line: 'immutable',
  customer: 'last_write_wins',
  supplier: 'last_write_wins',
  purchase: 'optimistic',
  purchase_line: 'optimistic',
  shift: 'optimistic',
  cash_movement: 'immutable',
  expense: 'optimistic',
  expense_category: 'last_write_wins',
  audit_log: 'immutable',
};

export function conflictStrategyFor(kind: EntityKind): ConflictStrategy {
  return CONFLICT_STRATEGY[kind] ?? 'manual_review';
}

export interface SyncConflict {
  id: Id;
  businessId: Id;
  deviceId: Id;
  entity: EntityKind;
  entityId: Id;
  localPayload: unknown;
  localRevision: number;
  serverPayload: unknown;
  serverRevision: number;
  detectedAt: string;
  status: 'open' | 'resolved_local' | 'resolved_server' | 'resolved_merged';
  resolvedBy: Id | null;
  resolvedAt: string | null;
  note: string | null;
}

/**
 * Decide what to do with a conflict. Pure so the Sync Center UI and the engine
 * agree on the outcome (PRD §21.3, §34 "Sync center").
 */
export function resolveConflict(params: {
  entity: EntityKind;
  localPayload: Record<string, unknown>;
  serverPayload: Record<string, unknown>;
  baseRevision: number;
  serverRevision: number;
}): { outcome: 'local' | 'server' | 'manual'; merged?: Record<string, unknown>; reason: string } {
  const { entity, localPayload, serverPayload, baseRevision, serverRevision } = params;

  // A server row that has moved on since we read it means we cannot apply blindly.
  const serverMoved = serverRevision > baseRevision;
  const strategy = conflictStrategyFor(entity);

  switch (strategy) {
    case 'immutable':
      return {
        outcome: 'server',
        reason: 'Completed financial records cannot be rewritten; the local copy is stored as a correction request.',
      };
    case 'server_wins':
      return { outcome: 'server', reason: 'This record is owned by the cloud.' };
    case 'last_write_wins': {
      const localUpdated = String(localPayload.updatedAt ?? '');
      const serverUpdated = String(serverPayload.updatedAt ?? '');
      return localUpdated >= serverUpdated
        ? { outcome: 'local', reason: 'Local copy is newer.' }
        : { outcome: 'server', reason: 'Cloud copy is newer.' };
    }
    case 'optimistic':
      return serverMoved
        ? { outcome: 'manual', reason: 'Both the terminal and the cloud changed this record while offline.' }
        : { outcome: 'local', reason: 'Cloud copy was unchanged.' };
    case 'manual_review':
    default:
      return { outcome: 'manual', reason: 'This record needs an administrator to choose a version.' };
  }
}

/** Highest-rank event in a batch — a quick sanity check before pushing. */
export function batchRank(events: readonly OutboxEvent[]): number {
  return events.reduce((max, event) => Math.max(max, entityRank(event.entity)), 0);
}

/**
 * Sort a batch into dependency-safe order. Stable within a rank by ULID so two
 * devices agree on ordering, and by dependency so a child never precedes its
 * parent even inside the same rank.
 */
export function orderEvents(events: readonly OutboxEvent[]): OutboxEvent[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  const sorted = [...events].sort((a, b) => {
    const rankDelta = entityRank(a.entity) - entityRank(b.entity);
    if (rankDelta !== 0) return rankDelta;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // Topological pass for explicit dependencies within the batch. Events whose
  // dependency is not in this batch are already satisfied (it was acked earlier)
  // or genuinely missing — the server reports the latter as dependency_missing.
  const emitted = new Set<Id>();
  const out: OutboxEvent[] = [];
  const remaining = [...sorted];
  let guard = remaining.length * remaining.length + 1;

  while (remaining.length > 0 && guard > 0) {
    guard -= 1;
    let progressed = false;
    for (let i = 0; i < remaining.length; i += 1) {
      const event = remaining[i];
      const unmet = event.dependsOn.filter((dep) => byId.has(dep) && !emitted.has(dep));
      if (unmet.length === 0) {
        out.push(event);
        emitted.add(event.id);
        remaining.splice(i, 1);
        progressed = true;
        break;
      }
    }
    if (!progressed) {
      // Cycle or self-reference: emit the rest in rank order and let the server
      // reject with dependency_missing rather than looping forever.
      out.push(...remaining);
      break;
    }
  }
  return out;
}

/**
 * Exponential backoff with full jitter (PRD §21.3, §39 "retryable and
 * resource-aware"). Jitter prevents a hundred terminals from stampeding the API
 * the moment the shopping centre's internet comes back.
 */
export function backoffDelayMs(attempt: number, baseMs = 2000, maxMs = 15 * 60_000): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exponential * (0.5 + Math.random() * 0.5));
}

/** True when an error is worth retrying. A rejected payload should not loop. */
export function isRetryable(code: SyncRejectionCode | undefined): boolean {
  if (!code) return true;
  return code === 'transient' || code === 'rate_limited' || code === 'dependency_missing';
}

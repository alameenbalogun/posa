/**
 * Local mutations that are more than a single row write.
 *
 * Screens should not have to know how to build an outbox event, and they
 * certainly should not each invent their own ordering of "write the row, then
 * remember to queue it". Every function here does the whole job inside one
 * storage transaction: the domain row, any inventory ledger entries it implies,
 * the audit entry, and the outbound sync event. If the device dies halfway, the
 * transaction rolls back and nothing is half-recorded (PRD §21.2, §36).
 *
 * This is also where the offline-first promise is enforced concretely: NONE of
 * these functions touch the network. They are safe to call with the cable
 * unplugged, and the sync engine picks the events up whenever it can.
 */

import { ulid } from '@/domain/ulid';
import { ZERO, type Minor } from '@/domain/money';
import type {
  AuditAction,
  Expense,
  Id,
  InventoryLedgerEntry,
  Purchase,
  StockCountLine,
  StockCountSession,
} from '@/domain/types';
import { countCorrections, createMovement } from '@/domain/inventory';
import type { EntityKind, OutboxEvent } from '@/domain/sync-protocol';
import type { PosaData } from './repositories';

/** Everything a local mutation needs to stamp provenance on what it writes. */
export interface MutationContext {
  data: PosaData;
  businessId: Id;
  branchId: Id;
  deviceId: Id;
  actorId: Id | null;
  actorName: string;
}

/** Build the outbound event for a row we just wrote locally. */
export function outboxEvent(input: {
  businessId: Id;
  branchId: Id | null;
  deviceId: Id;
  entity: EntityKind;
  entityId: Id;
  payload: unknown;
  baseRevision?: number;
  dependsOn?: Id[];
}): OutboxEvent {
  const now = new Date().toISOString();
  return {
    id: ulid(),
    businessId: input.businessId,
    branchId: input.branchId,
    deviceId: input.deviceId,
    entity: input.entity,
    entityId: input.entityId,
    op: 'insert',
    payload: (input.payload ?? {}) as Record<string, unknown>,
    baseRevision: input.baseRevision ?? 0,
    dependsOn: [...(input.dependsOn ?? [])],
    attempts: 0,
    lastError: null,
    nextAttemptAt: now,
    createdAt: now,
    ackedAt: null,
    serverRevision: null,
  };
}

function auditEntry(
  ctx: MutationContext,
  action: AuditAction,
  entityType: string,
  entityId: Id,
  metadata: Record<string, unknown>,
) {
  return {
    id: ulid(),
    businessId: ctx.businessId,
    branchId: ctx.branchId,
    deviceId: ctx.deviceId,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    action,
    entityType,
    entityId,
    metadata,
    origin: 'local' as const,
    occurredAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Expenses (PRD §20)                                                  */
/* ------------------------------------------------------------------ */

export async function recordExpense(
  ctx: MutationContext,
  input: {
    amount: Minor;
    categoryId: Id | null;
    categoryName: string;
    source: Expense['source'];
    description: string | null;
    shiftId?: Id | null;
  },
): Promise<Expense> {
  const expense: Expense = {
    id: ulid(),
    businessId: ctx.businessId,
    branchId: ctx.branchId,
    categoryId: input.categoryId,
    categoryName: input.categoryName,
    amount: input.amount,
    source: input.source,
    shiftId: input.shiftId ?? null,
    reference: null,
    description: input.description,
    spentBy: ctx.actorId ?? ctx.deviceId,
    approvedBy: null,
    spentAt: new Date().toISOString(),
  };

  const event = outboxEvent({
    businessId: ctx.businessId,
    branchId: ctx.branchId,
    deviceId: ctx.deviceId,
    entity: 'expense',
    entityId: expense.id,
    payload: expense,
  });

  await ctx.data.store.transaction(async (tx) => {
    await tx.put('expenses', expense as never);
    await tx.enqueue([event]);
  });

  await ctx.data.writeAudit(
    auditEntry(ctx, 'expense.create', 'expense', expense.id, {
      amount: expense.amount,
      category: expense.categoryName,
      source: expense.source,
    }),
  );

  return expense;
}

/* ------------------------------------------------------------------ */
/* Purchasing (PRD §15)                                                */
/* ------------------------------------------------------------------ */

/**
 * Mark a purchase line as received and post the stock-in movements.
 *
 * Partial receiving is the normal case in real shops — a supplier delivers 8 of
 * the 10 cartons ordered — so this takes quantities per line rather than a single
 * "received" flag, and the purchase only closes when every line is complete.
 */
export async function receivePurchase(
  ctx: MutationContext,
  purchase: Purchase,
  received: Array<{ lineId: Id; quantity: number }>,
): Promise<{ purchase: Purchase; movements: InventoryLedgerEntry[] }> {
  const now = new Date().toISOString();
  const movements: InventoryLedgerEntry[] = [];

  const lines = purchase.lines.map((line) => {
    const entry = received.find((candidate) => candidate.lineId === line.id);
    if (!entry || entry.quantity <= 0) return line;

    const quantity = Math.min(entry.quantity, line.quantity - line.receivedQuantity);
    if (quantity <= 0) return line;

    movements.push(
      createMovement(
        {
          businessId: ctx.businessId,
          branchId: purchase.branchId,
          productId: line.productId,
          variantId: line.variantId,
          quantityDelta: quantity,
          reason: 'purchase_receipt',
          sourceType: 'purchase',
          sourceId: purchase.id,
          unitCost: line.unitCost,
          note: `Received against ${purchase.reference}`,
          actorId: ctx.actorId,
          deviceId: ctx.deviceId,
        },
        now,
      ),
    );

    return { ...line, receivedQuantity: line.receivedQuantity + quantity };
  });

  const complete = lines.every((line) => line.receivedQuantity >= line.quantity);
  const started = lines.some((line) => line.receivedQuantity > 0);
  const next: Purchase = {
    ...purchase,
    lines,
    status: complete ? 'received' : started ? 'partially_received' : purchase.status,
    receivedAt: complete ? now : purchase.receivedAt,
  };

  const events: OutboxEvent[] = [
    outboxEvent({
      businessId: ctx.businessId,
      branchId: purchase.branchId,
      deviceId: ctx.deviceId,
      entity: 'purchase',
      entityId: next.id,
      payload: next,
      baseRevision: 1,
    }),
    ...movements.map((movement) =>
      outboxEvent({
        businessId: ctx.businessId,
        branchId: purchase.branchId,
        deviceId: ctx.deviceId,
        entity: 'inventory_ledger',
        entityId: movement.id,
        payload: movement,
      }),
    ),
  ];

  await ctx.data.store.transaction(async (tx) => {
    await tx.put('purchases', next as never);
    if (movements.length > 0) await tx.putMany('inventoryLedger', movements as never[]);
    await tx.enqueue(events);
  });

  await ctx.data.refreshStockLevels();
  await ctx.data.writeAudit(
    auditEntry(ctx, 'inventory.receive', 'purchase', next.id, {
      reference: next.reference,
      lines: movements.length,
      units: movements.reduce((total, movement) => total + movement.quantityDelta, 0),
      status: next.status,
    }),
  );

  return { purchase: next, movements };
}

/* ------------------------------------------------------------------ */
/* Stock counts (PRD §14, §45)                                         */
/* ------------------------------------------------------------------ */

/**
 * Post a count: turn every variance into an `count_correction` ledger movement.
 *
 * The counted quantities were written to storage as each scan happened, so a
 * count survives the app being closed, the tablet losing power or the cashier
 * being called away mid-aisle. Posting is the only irreversible step, and it is
 * deliberately explicit.
 */
export async function postStockCount(
  ctx: MutationContext,
  session: StockCountSession,
  lines: readonly StockCountLine[],
): Promise<InventoryLedgerEntry[]> {
  const movements = countCorrections({
    session,
    lines,
    deviceId: ctx.deviceId,
    actorId: ctx.actorId ?? ctx.deviceId,
  });

  const posted: StockCountSession = {
    ...session,
    status: 'posted',
    closedAt: new Date().toISOString(),
  };

  const events: OutboxEvent[] = [
    outboxEvent({
      businessId: ctx.businessId,
      branchId: session.branchId,
      deviceId: ctx.deviceId,
      entity: 'stock_count_session',
      entityId: posted.id,
      payload: posted,
      baseRevision: 1,
    }),
    ...movements.map((movement) =>
      outboxEvent({
        businessId: ctx.businessId,
        branchId: session.branchId,
        deviceId: ctx.deviceId,
        entity: 'inventory_ledger',
        entityId: movement.id,
        payload: movement,
      }),
    ),
  ];

  await ctx.data.store.transaction(async (tx) => {
    await tx.put('stockCountSessions', posted as never);
    await tx.putMany('stockCountLines', lines as never[]);
    if (movements.length > 0) await tx.putMany('inventoryLedger', movements as never[]);
    await tx.enqueue(events);
  });

  await ctx.data.refreshStockLevels();
  await ctx.data.writeAudit(
    auditEntry(ctx, 'inventory.count_post', 'stock_count', posted.id, {
      session: posted.name,
      corrections: movements.length,
      netUnits: movements.reduce((total, movement) => total + movement.quantityDelta, 0),
    }),
  );

  return movements;
}

/** Convenience for callers that only need a zero total. */
export const ZERO_TOTAL: Minor = ZERO;

/**
 * Returns, refunds and voids (PRD §17).
 *
 * THE RULE THAT MATTERS: a refund is computed from the ORIGINAL sale's line
 * snapshots — never from today's price. Re-pricing a refund would let a shop
 * quietly refund the new (higher) price for something bought on promotion, and
 * would make the VAT reversal wrong. We reverse exactly what was charged.
 *
 * Partial returns are first-class. A line tracks how much has already gone back,
 * so a customer can return 1 of 3, then 1 more, and never 4 of 3.
 */

import { ulid } from './ulid';
import { scale, sub, sum, ZERO, type Minor } from './money';
import type { InventoryLedgerEntry, PaymentMethod, ReturnReason, SaleLine } from './types';
import { createMovement } from './inventory';
import type { EntityKind, OutboxEvent } from './sync-protocol';

/* ------------------------------------------------------------------ */
/* Eligibility                                                         */
/* ------------------------------------------------------------------ */

export interface ReturnableLine {
  saleLineId: string;
  productId: string;
  variantId: string | null;
  name: string;
  sku: string;
  quantitySold: number;
  alreadyReturned: number;
  /** What is still returnable right now. */
  returnable: number;
  unitPrice: Minor;
  lineTotal: Minor;
  taxAmount: Minor;
}

export interface ReturnEligibility {
  eligible: boolean;
  reason: string | null;
  lines: ReturnableLine[];
  /** True when the refund window has expired; a manager may override. */
  windowExpired: boolean;
  daysSinceSale: number;
}

export interface ReturnPolicy {
  /** 0 or null means "no limit". */
  windowDays: number | null;
  /** Allow returns against a sale whose sync status is unknown. */
  allowStaleOfflineReceipt: boolean;
  /** Goods returned without going back on the shelf (damaged/faulty). */
  defaultRestock: boolean;
}

export const DEFAULT_RETURN_POLICY: ReturnPolicy = {
  windowDays: 30,
  allowStaleOfflineReceipt: true,
  defaultRestock: true,
};

/**
 * Work out what can be returned.
 *
 * Note that we do not block a "stale offline receipt" — a receipt the terminal
 * has never been able to verify with the cloud. Blocking it would mean a shop
 * with flaky internet cannot accept returns at all, which is precisely the
 * failure mode POSA exists to avoid (PRD §46 "Return initiated from a stale
 * offline receipt"). Instead we allow it and flag it for review.
 */
export function evaluateReturn(params: {
  sale: { committedAt: string; status: string };
  lines: readonly SaleLine[];
  policy?: ReturnPolicy;
  now?: string;
}): ReturnEligibility {
  const policy = params.policy ?? DEFAULT_RETURN_POLICY;
  const now = params.now ?? new Date().toISOString();
  const daysSinceSale = Math.floor(
    (new Date(now).getTime() - new Date(params.sale.committedAt).getTime()) / 86_400_000,
  );

  const lines: ReturnableLine[] = params.lines.map((line) => {
    const alreadyReturned = line.returnedQuantity ?? 0;
    return {
      saleLineId: line.id,
      productId: line.productId,
      variantId: line.variantId,
      name: line.name,
      sku: line.sku,
      quantitySold: line.quantity,
      alreadyReturned,
      returnable: Math.max(0, line.quantity - alreadyReturned),
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
      taxAmount: line.taxAmount,
    };
  });

  const windowExpired = policy.windowDays != null && daysSinceSale > policy.windowDays;

  if (params.sale.status === 'voided') {
    return { eligible: false, reason: 'This sale was voided; there is nothing to return.', lines, windowExpired, daysSinceSale };
  }
  if (params.sale.status === 'returned') {
    return { eligible: false, reason: 'Everything on this receipt has already been returned.', lines, windowExpired, daysSinceSale };
  }
  if (lines.every((line) => line.returnable === 0)) {
    return { eligible: false, reason: 'No items remain returnable on this receipt.', lines, windowExpired, daysSinceSale };
  }

  return {
    eligible: true,
    reason: windowExpired ? `Outside the ${policy.windowDays}-day return window — manager approval required.` : null,
    lines,
    windowExpired,
    daysSinceSale,
  };
}

/* ------------------------------------------------------------------ */
/* Refund maths                                                        */
/* ------------------------------------------------------------------ */

export interface RefundLineInput {
  saleLineId: string;
  quantity: number;
}

export interface RefundLineResult {
  id: string;
  returnId: string;
  saleLineId: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  unitRefund: Minor;
  lineRefund: Minor;
  taxRefund: Minor;
}

export interface RefundComputation {
  lines: RefundLineResult[];
  refundSubtotal: Minor;
  refundTax: Minor;
  refundTotal: Minor;
  errors: string[];
}

/**
 * Compute the refund for a set of lines.
 *
 * We pro-rate from the sale line's stored totals rather than multiplying by a
 * per-unit price. Why: a line of 3 items with a ₦10 cart discount may have a
 * line total of ₦4,490 — that is not divisible by 3. Pro-rating keeps the
 * returned portions summing exactly to the sold line total, so "return
 * everything" refunds precisely what was paid (PRD §45 acceptance criterion).
 */
export function computeRefund(params: {
  returnId: string;
  saleLines: readonly SaleLine[];
  requested: readonly RefundLineInput[];
  /** When true, the last remaining unit absorbs any rounding residue. */
  allowResidueCapture?: boolean;
}): RefundComputation {
  const { returnId, saleLines, requested } = params;
  const errors: string[] = [];
  const byId = new Map(saleLines.map((line) => [line.id, line]));
  const results: RefundLineResult[] = [];

  for (const request of requested) {
    if (request.quantity <= 0) continue;
    const saleLine = byId.get(request.saleLineId);
    if (!saleLine) {
      errors.push('A selected item is not part of this sale.');
      continue;
    }
    const already = saleLine.returnedQuantity ?? 0;
    const remaining = saleLine.quantity - already;
    if (request.quantity > remaining + 1e-9) {
      errors.push(`${saleLine.name}: only ${remaining} left to return.`);
      continue;
    }

    const isFullRemainder =
      params.allowResidueCapture !== false && Math.abs(request.quantity - remaining) < 1e-9;
    const remainingLineTotal = sub(saleLine.lineTotal, scale(saleLine.lineTotal, already / saleLine.quantity));
    const remainingTax = sub(saleLine.taxAmount, scale(saleLine.taxAmount, already / saleLine.quantity));

    const lineRefund = isFullRemainder
      ? (Math.round(remainingLineTotal) as Minor)
      : (Math.round(scale(remainingLineTotal, request.quantity / remaining)) as Minor);
    const taxRefund = isFullRemainder
      ? (Math.round(remainingTax) as Minor)
      : (Math.round(scale(remainingTax, request.quantity / remaining)) as Minor);

    results.push({
      id: ulid(),
      returnId,
      saleLineId: saleLine.id,
      productId: saleLine.productId,
      variantId: saleLine.variantId,
      quantity: request.quantity,
      unitRefund: Math.round(scale(lineRefund, 1 / request.quantity)) as Minor,
      lineRefund,
      taxRefund,
    });
  }

  const refundTotal = sum(results.map((r) => r.lineRefund));
  const refundTax = sum(results.map((r) => r.taxRefund));

  return {
    lines: results,
    refundSubtotal: sub(refundTotal, refundTax),
    refundTax,
    refundTotal,
    errors,
  };
}

/** Is this the last of a line, i.e. will the sale be fully returned? */
export function isFullReturn(saleLines: readonly SaleLine[], requested: readonly RefundLineInput[]): boolean {
  const byId = new Map(saleLines.map((l) => [l.id, l]));
  return requested.every((request) => {
    const line = byId.get(request.saleLineId);
    if (!line) return false;
    return Math.abs((line.returnedQuantity ?? 0) + request.quantity - line.quantity) < 1e-9;
  });
}

/* ------------------------------------------------------------------ */
/* Commit                                                              */
/* ------------------------------------------------------------------ */

export interface ReturnContext {
  businessId: string;
  branchId: string;
  deviceId: string;
  cashierId: string;
  approvedBy: string | null;
  reason: ReturnReason;
  reasonNote: string | null;
  refundMethod: PaymentMethod;
  /** Per-line restock override; defaults to the policy value. */
  restockFor?: (saleLineId: string) => boolean;
  now?: string;
  returnId?: string;
}

export interface ReturnBundle {
  returnRecord: Record<string, unknown>;
  returnLines: Array<Record<string, unknown>>;
  /** Patch applied to the original sale to mark it returned/partially returned. */
  salePatch: Record<string, unknown>;
  /** Patches applied to sale lines to bump `returnedQuantity`. */
  saleLinePatches: Array<Record<string, unknown>>;
  inventory: InventoryLedgerEntry[];
  audit: Array<Record<string, unknown>>;
  events: OutboxEvent[];
  refundTotal: Minor;
  restockedValue: Minor;
}

export function buildReturn(params: {
  sale: {
    id: string;
    receiptNumber: string;
    businessId: string;
    branchId: string;
    deviceId: string;
    status: string;
    total: Minor;
    /** Needed to evaluate the return window. */
    committedAt: string;
  };
  saleLines: readonly SaleLine[];
  requested: readonly RefundLineInput[];
  context: ReturnContext;
  policy?: ReturnPolicy;
  /** Ledger entries produced by the original sale, used for restock cost. */
  originalLedger?: readonly InventoryLedgerEntry[];
}): ReturnBundle {
  const { sale, saleLines, requested, context } = params;
  const policy = params.policy ?? DEFAULT_RETURN_POLICY;
  const now = context.now ?? new Date().toISOString();
  const returnId = context.returnId ?? ulid();

  const eligibility = evaluateReturn({ sale, lines: saleLines, policy, now });
  if (!eligibility.eligible) {
    throw new Error(eligibility.reason ?? 'This sale cannot be returned.');
  }

  const computation = computeRefund({ returnId, saleLines, requested });
  if (computation.errors.length > 0) {
    throw new Error(computation.errors.join(' '));
  }
  if (computation.lines.length === 0) {
    throw new Error('Select at least one item to return.');
  }

  const fullReturn = isFullReturn(saleLines, computation.lines);
  const saleLineById = new Map(saleLines.map((l) => [l.id, l]));

  // --- Restock movements --------------------------------------------------
  // Only goods that physically go back on the shelf produce an inflow.
  const inventory: InventoryLedgerEntry[] = [];
  let restockedValue = ZERO;
  for (const line of computation.lines) {
    const restock = context.restockFor?.(line.saleLineId) ?? policy.defaultRestock;
    if (!restock) continue;
    const saleLine = saleLineById.get(line.saleLineId);
    const unitCost = saleLine?.unitCost ?? ZERO;
    restockedValue = (restockedValue + line.quantity * unitCost) as Minor;
    inventory.push(
      createMovement(
        {
          businessId: sale.businessId,
          branchId: sale.branchId,
          productId: line.productId,
          variantId: line.variantId,
          quantityDelta: Math.abs(line.quantity),
          reason: 'return',
          sourceType: 'return',
          sourceId: returnId,
          unitCost,
          note: context.reasonNote ?? `Return: ${context.reason}`,
          actorId: context.cashierId,
          deviceId: sale.deviceId,
        },
        now,
      ),
    );
  }

  const returnRecord = {
    id: returnId,
    businessId: context.businessId,
    branchId: context.branchId,
    deviceId: context.deviceId,
    saleId: sale.id,
    receiptNumber: sale.receiptNumber,
    cashierId: context.cashierId,
    approvedBy: context.approvedBy,
    reason: context.reason,
    reasonNote: context.reasonNote,
    refundSubtotal: computation.refundSubtotal,
    refundTax: computation.refundTax,
    refundTotal: computation.refundTotal,
    refundMethod: context.refundMethod,
    restock: inventory.length > 0,
    status: 'committed' as const,
    idempotencyKey: returnId,
    committedAt: now,
  };

  const saleLinePatches = computation.lines.map((line) => {
    const saleLine = saleLineById.get(line.saleLineId);
    return {
      id: line.saleLineId,
      returnedQuantity: (saleLine?.returnedQuantity ?? 0) + line.quantity,
      updatedAt: now,
    };
  });

  const salePatch = {
    id: sale.id,
    status: fullReturn ? 'returned' : 'partially_returned',
    updatedAt: now,
  };

  const audit = [
    {
      id: ulid(),
      businessId: context.businessId,
      branchId: context.branchId,
      deviceId: context.deviceId,
      actorId: context.cashierId,
      actorName: '',
      action: 'return.commit',
      entityType: 'return',
      entityId: returnId,
      metadata: {
        receiptNumber: sale.receiptNumber,
        reason: context.reason,
        refundTotal: computation.refundTotal,
        refundTax: computation.refundTax,
        restocked: inventory.length > 0,
        fullReturn,
        approvedBy: context.approvedBy,
      },
      origin: 'local' as const,
      occurredAt: now,
    },
  ];

  const returnEvent = makeEvent({
    entity: 'return',
    entityId: returnId,
    payload: returnRecord,
    businessId: context.businessId,
    branchId: context.branchId,
    deviceId: context.deviceId,
    now,
    dependsOn: [sale.id],
  });

  const events: OutboxEvent[] = [
    ...computation.lines.map((line) =>
      makeEvent({
        entity: 'return_line',
        entityId: line.id,
        payload: line as unknown as Record<string, unknown>,
        businessId: context.businessId,
        branchId: context.branchId,
        deviceId: context.deviceId,
        now,
        dependsOn: [returnEvent.id],
      }),
    ),
    ...inventory.map((entry) =>
      makeEvent({
        entity: 'inventory_ledger',
        entityId: entry.id,
        payload: entry as unknown as Record<string, unknown>,
        businessId: context.businessId,
        branchId: context.branchId,
        deviceId: context.deviceId,
        now,
        dependsOn: [returnEvent.id],
      }),
    ),
    ...audit.map((entry) =>
      makeEvent({
        entity: 'audit_log',
        entityId: String(entry.id),
        payload: entry,
        businessId: context.businessId,
        branchId: context.branchId,
        deviceId: context.deviceId,
        now,
        dependsOn: [returnEvent.id],
      }),
    ),
    ...saleLinePatches.map((patch) =>
      makeEvent({
        entity: 'sale_line',
        entityId: String(patch.id),
        op: 'update',
        payload: patch,
        businessId: context.businessId,
        branchId: context.branchId,
        deviceId: context.deviceId,
        now,
        dependsOn: [sale.id],
      }),
    ),
    makeEvent({
      entity: 'sale',
      entityId: sale.id,
      op: 'update',
      payload: salePatch,
      businessId: context.businessId,
      branchId: context.branchId,
      deviceId: context.deviceId,
      // The sale row already exists on the server, so there is nothing to wait for.
      dependsOn: [],
      now,
    }),
    returnEvent,
  ];

  return {
    returnRecord,
    returnLines: computation.lines as unknown as Array<Record<string, unknown>>,
    salePatch,
    saleLinePatches,
    inventory,
    audit,
    events,
    refundTotal: computation.refundTotal,
    restockedValue,
  };
}

function makeEvent(params: {
  entity: EntityKind;
  entityId: string;
  payload: unknown;
  op?: 'insert' | 'update' | 'upsert';
  businessId: string;
  branchId: string;
  deviceId: string;
  dependsOn: string[];
  now: string;
}): OutboxEvent {
  return {
    id: ulid(),
    businessId: params.businessId,
    branchId: params.branchId,
    deviceId: params.deviceId,
    entity: params.entity,
    entityId: params.entityId,
    op: params.op ?? 'insert',
    payload: params.payload,
    baseRevision: 0,
    dependsOn: params.dependsOn,
    attempts: 0,
    lastError: null,
    nextAttemptAt: params.now,
    createdAt: params.now,
    ackedAt: null,
    serverRevision: null,
  };
}

export const RETURN_REASON_LABELS: Record<ReturnReason, string> = {
  customer_changed_mind: 'Customer changed their mind',
  damaged: 'Damaged',
  expired: 'Expired',
  wrong_item: 'Wrong item sold',
  faulty: 'Faulty / does not work',
  overcharge: 'Overcharged',
  other: 'Other',
};

/** Receipt QR payload. Encodes enough to look a sale up without the cloud. */
export function receiptQrPayload(params: {
  receiptNumber: string;
  saleId: string;
  businessId: string;
  branchId: string;
  total: Minor;
  committedAt: string;
}): string {
  return JSON.stringify({
    v: 1,
    t: 'sale',
    r: params.receiptNumber,
    s: params.saleId,
    b: params.businessId,
    h: params.branchId,
    a: params.total,
    d: params.committedAt,
  });
}

export function parseReceiptQr(payload: string): {
  receiptNumber: string;
  saleId: string;
  businessId: string | null;
  branchId: string | null;
  total: Minor | null;
  committedAt: string | null;
} | null {
  try {
    const trimmed = payload.trim();
    // Accept a bare receipt number too — some shops print only that.
    if (!trimmed.startsWith('{')) {
      return { receiptNumber: trimmed, saleId: '', businessId: null, branchId: null, total: null, committedAt: null };
    }
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed.t !== 'sale' || typeof parsed.r !== 'string') return null;
    return {
      receiptNumber: parsed.r,
      saleId: typeof parsed.s === 'string' ? parsed.s : '',
      businessId: typeof parsed.b === 'string' ? parsed.b : null,
      branchId: typeof parsed.h === 'string' ? parsed.h : null,
      total: typeof parsed.a === 'number' ? (parsed.a as Minor) : null,
      committedAt: typeof parsed.d === 'string' ? parsed.d : null,
    };
  } catch {
    return null;
  }
}

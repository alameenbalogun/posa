/**
 * Sale lifecycle and the atomic commit (PRD §11.1, §21.2, §36).
 *
 * THE CENTRAL PROMISE OF POSA: when a cashier presses "Complete sale", we commit
 * in ONE local write — the sale, its lines, its payments, the inventory ledger
 * entries and the outbound sync events. Either all of it lands or none of it
 * does. Only then do we tell the cashier the sale succeeded.
 *
 * That ordering is what makes the acceptance criterion hold (PRD §45):
 *   "disconnect the terminal during checkout, complete the sale, restart the
 *    application, reconnect the network and verify exactly one sale, exactly one
 *    inventory deduction and exactly one cloud record."
 *
 * Connectivity never enters this function. It cannot fail because of the network.
 */

import { ulid, shortCode } from './ulid';
import { add, sum, ZERO, type Minor } from './money';
import type { PricedCart, PricedLine, PaymentIntent } from './pricing';
import { classifyPaymentStatus, grossProfit, planPayments } from './pricing';
import type { InventoryLedgerEntry, PaymentMethod, PaymentStatus } from './types';
import { createMovement, saleMovements } from './inventory';
import type { Cart } from './cart';
import type { EntityKind, OutboxEvent } from './sync-protocol';
import { entityRank } from './sync-protocol';

/* ------------------------------------------------------------------ */
/* State machine                                                       */
/* ------------------------------------------------------------------ */

export type SaleLifecycleState =
  | 'building'
  | 'priced'
  | 'awaiting_payment'
  | 'paid'
  | 'committed'
  | 'queued'
  | 'synced'
  | 'held'
  | 'voided'
  | 'abandoned';

export type SaleLifecycleEvent =
  | { type: 'price' }
  | { type: 'require_payment' }
  | { type: 'payment_satisfied' }
  | { type: 'commit' }
  | { type: 'queue' }
  | { type: 'ack' }
  | { type: 'hold' }
  | { type: 'resume' }
  | { type: 'void' }
  | { type: 'abandon' };

export interface TransitionContext {
  /** Priced cart, required to validate the payment gate. */
  priced?: PricedCart | null;
  paymentIntents?: readonly PaymentIntent[];
  /** Businesses that sell on credit may commit with an outstanding balance. */
  creditAllowed?: boolean;
  reason?: string;
}

const TRANSITIONS: Record<SaleLifecycleState, Partial<Record<SaleLifecycleEvent['type'], SaleLifecycleState>>> = {
  building: { price: 'priced', hold: 'held', abandon: 'abandoned' },
  priced: { require_payment: 'awaiting_payment', hold: 'held', abandon: 'abandoned' },
  awaiting_payment: { payment_satisfied: 'paid', hold: 'held', abandon: 'abandoned' },
  paid: { commit: 'committed', abandon: 'abandoned' },
  committed: { queue: 'queued', void: 'voided' },
  queued: { ack: 'synced', void: 'voided' },
  synced: { void: 'voided' },
  held: { resume: 'building', abandon: 'abandoned' },
  voided: {},
  abandoned: {},
};

export interface TransitionResult {
  ok: boolean;
  next: SaleLifecycleState;
  error: string | null;
}

/**
 * Advance the lifecycle, enforcing the gates that protect money and stock.
 *
 * Guards implemented here:
 *  - you cannot pay a cart that has not been priced,
 *  - you cannot commit while a balance is outstanding (unless credit sales are
 *    enabled and the customer has capacity),
 *  - you cannot a sale that was never committed,
 *  - you cannot reopen a voided sale.
 */
export function transition(
  current: SaleLifecycleState,
  event: SaleLifecycleEvent,
  context: TransitionContext = {},
): TransitionResult {
  const allowed = TRANSITIONS[current] ?? {};
  const next = allowed[event.type];

  if (!next) {
    return {
      ok: false,
      next: current,
      error: `Cannot ${event.type.replace(/_/g, ' ')} a sale that is ${current.replace(/_/g, ' ')}.`,
    };
  }

  if (event.type === 'require_payment') {
    const priced = context.priced;
    if (!priced) return { ok: false, next: current, error: 'Price the cart before taking payment.' };
    // A zero-total sale (100% discount, or a warranty line) skips straight to paid.
    if (priced.totals.total <= 0) return { ok: true, next: 'paid', error: null };
  }

  if (event.type === 'payment_satisfied') {
    const priced = context.priced;
    if (!priced) return { ok: false, next: current, error: 'Nothing to settle.' };
    const plan = planPayments(priced.totals.total, context.paymentIntents ?? []);
    const settled = plan.outstanding === 0 || (context.creditAllowed === true && plan.valid);
    if (!settled) {
      return { ok: false, next: current, error: 'The amount tendered does not cover the sale total.' };
    }
  }

  if (event.type === 'commit') {
    const priced = context.priced;
    if (!priced) return { ok: false, next: current, error: 'Nothing to commit.' };
    if (priced.lines.length === 0) return { ok: false, next: current, error: 'The cart is empty.' };
  }

  return { ok: true, next, error: null };
}

export const LIFECYCLE_LABELS: Record<SaleLifecycleState, string> = {
  building: 'Building cart',
  priced: 'Priced',
  awaiting_payment: 'Awaiting payment',
  paid: 'Paid',
  committed: 'Committed locally',
  queued: 'Queued for sync',
  synced: 'Synchronised',
  held: 'Held',
  voided: 'Voided',
  abandoned: 'Abandoned',
};

/** Which states are still "live" for a device that is about to be closed. */
export function isTerminalState(state: SaleLifecycleState): boolean {
  return state === 'synced' || state === 'voided' || state === 'abandoned';
}

/** States that MUST survive an application restart without data loss. */
export function requiresDurableStorage(state: SaleLifecycleState): boolean {
  return !isTerminalState(state) && state !== 'building';
}

/* ------------------------------------------------------------------ */
/* Receipt numbers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Human-readable receipt numbers that cannot collide across offline devices.
 *
 * `{BRANCH}-{DEVICE}-{SEQ}` e.g. `LAG-4K9T-000128`.
 *  - Branch code makes it locatable by a person on the phone.
 *  - Device code makes it unique even when two tills share a branch and neither
 *    has seen the cloud for a week.
 *  - Sequence is per-device and monotonic, so gaps are meaningful (a gap means a
 *    sale was abandoned or a device was wiped) and the server can detect them.
 */
export function formatReceiptNumber(params: {
  branchCode: string;
  deviceCode: string;
  sequence: number;
  width?: number;
}): string {
  const width = params.width ?? 6;
  const branch = (params.branchCode || 'BR').toUpperCase().slice(0, 4);
  const device = (params.deviceCode || 'DEV').toUpperCase().slice(0, 4);
  return `${branch}-${device}-${String(params.sequence).padStart(width, '0')}`;
}

export interface ReceiptNumberParts {
  branchCode: string;
  deviceCode: string;
  sequence: number;
}

export function parseReceiptNumber(value: string): ReceiptNumberParts | null {
  const match = /^([A-Z0-9]{1,4})-([A-Z0-9]{1,4})-(\d{1,10})$/i.exec(value.trim());
  if (!match) return null;
  return {
    branchCode: match[1].toUpperCase(),
    deviceCode: match[2].toUpperCase(),
    sequence: Number(match[3]),
  };
}

/** Derive the stable short device code used in receipt numbers. */
export function deviceCodeFromId(deviceId: string): string {
  return shortCode(deviceId, 4);
}

/* ------------------------------------------------------------------ */
/* Commit                                                              */
/* ------------------------------------------------------------------ */

export interface PaymentDraft extends PaymentIntent {
  method: PaymentMethod | string;
  /** Provider reference/RRN. Its absence is what keeps an auth-required payment pending. */
  reference?: string | null;
  provider?: string | null;
  tenderedAmount?: Minor;
  failureReason?: string | null;
}

export interface CommitContext {
  businessId: string;
  branchId: string;
  deviceId: string;
  cashierId: string;
  shiftId: string | null;
  customerId: string | null;
  branchCode: string;
  deviceCode: string;
  /** Per-device monotonic counter, supplied by the local sequence store. */
  sequence: number;
  currency: string;
  /** Whether this terminal currently has reachable network. Informational only. */
  isOnline: boolean;
  /** A second user's id when a sensitive action was approved (PRD §8). */
  approvedBy?: string | null;
  note?: string | null;
  now?: string;
  /** Override for tests and replays; defaults to a fresh ULID. */
  saleId?: string;
}

export interface CommitBundle {
  sale: {
    id: string;
    receiptNumber: string;
    businessId: string;
    branchId: string;
    deviceId: string;
    cashierId: string;
    customerId: string | null;
    shiftId: string | null;
    channel: 'pos';
    status: 'committed';
    currency: string;
    subtotal: Minor;
    lineDiscountTotal: Minor;
    cartDiscountTotal: Minor;
    discountTotal: Minor;
    taxTotal: Minor;
    roundingAdjustment: Minor;
    total: Minor;
    amountPaid: Minor;
    changeDue: Minor;
    itemCount: number;
    note: string | null;
    approvedBy: string | null;
    idempotencyKey: string;
    committedAt: string;
    voidedAt: null;
    voidReason: null;
  };
  lines: Array<Record<string, unknown>>;
  payments: Array<Record<string, unknown>>;
  inventory: InventoryLedgerEntry[];
  audit: Array<Record<string, unknown>>;
  /** Fully-formed outbox events, ready to be written in the same transaction. */
  events: OutboxEvent[];
  /** Cash actually collected — used to update the open shift. */
  cashCollected: Minor;
  /** Smallest sale-level status summary for the receipt. */
  paymentStatus: PaymentStatus;
  grossProfit: Minor;
  /** Non-blocking problems worth showing the cashier (e.g. an unconfirmed card). */
  warnings: string[];
}

export class SaleCommitError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SaleCommitError';
    this.code = code;
  }
}

function lineToRecord(line: PricedLine, saleId: string): Record<string, unknown> {
  return {
    id: ulid(),
    saleId,
    productId: line.productId,
    variantId: line.variantId,
    name: line.name,
    sku: line.sku,
    barcode: line.barcode,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    lineDiscount: line.lineDiscount,
    allocatedDiscount: line.cartDiscountShare,
    taxRateBasisPoints: line.taxRateBasisPoints,
    taxableBase: line.taxableBase,
    taxAmount: line.taxAmount,
    lineTotal: line.lineTotal,
    unitCost: line.unitCost,
    returnableQuantity: line.quantity,
    returnedQuantity: 0,
  };
}

/**
 * Build every artefact of a completed sale in memory.
 *
 * Pure and synchronous: it validates, then produces the write set. Persisting
 * that set atomically is the job of the local repository. Keeping the two apart
 * means we can unit-test the whole financial commit without a database, and it
 * means the same builder can replay a queue after a crash.
 */
export function buildCommittedSale(
  cart: Cart,
  priced: PricedCart,
  paymentDrafts: readonly PaymentDraft[],
  context: CommitContext,
): CommitBundle {
  const now = context.now ?? new Date().toISOString();

  if (priced.lines.length === 0) {
    throw new SaleCommitError('empty_cart', 'A sale must contain at least one item.');
  }

  const warnings: string[] = [];

  // --- Payment validation -------------------------------------------------
  const plan = planPayments(priced.totals.total, paymentDrafts);
  if (!plan.valid) {
    throw new SaleCommitError('invalid_payment', plan.errors[0] ?? 'Payment is not valid.');
  }
  if (plan.outstanding > 0) {
    const creditDraft = paymentDrafts.find((d) => d.method === 'credit');
    if (!creditDraft) {
      throw new SaleCommitError(
        'underpaid',
        'The payments do not cover the sale total. Add a payment method or attach the balance to the customer.',
      );
    }
  }

  const saleId = context.saleId ?? ulid();
  const receiptNumber = formatReceiptNumber({
    branchCode: context.branchCode,
    deviceCode: context.deviceCode,
    sequence: context.sequence,
  });

  // --- Lines --------------------------------------------------------------
  const lines = priced.lines.map((line) => lineToRecord(line, saleId));

  // --- Inventory ----------------------------------------------------------
  const inventory = saleMovements({
    businessId: context.businessId,
    branchId: context.branchId,
    deviceId: context.deviceId,
    actorId: context.cashierId,
    saleId,
    lines: priced.lines.map((line) => ({
      productId: line.productId,
      variantId: line.variantId,
      quantity: line.quantity,
      unitCost: line.unitCost,
    })),
    occurredAt: now,
  });

  // --- Payments -----------------------------------------------------------
  let outstandingCursor = priced.totals.total;
  const payments: Array<Record<string, unknown>> = [];
  let cashCollected = ZERO;
  let anyPending = false;

  for (const draft of paymentDrafts) {
    // Cash, bank transfer and store credit are self-authorising: the terminal can
    // record them offline and settle later. Everything else (card, wallet, a
    // provider terminal) needs a real authorisation before it counts as paid.
    const selfAuthorising = draft.method === 'cash' || draft.method === 'transfer' || draft.method === 'credit';
    const requiresAuthorization = draft.requiresAuthorization ?? !selfAuthorising;
    const status = classifyPaymentStatus({
      method: draft.method,
      requiresAuthorization,
      isOnline: context.isOnline,
      providerReference: draft.reference ?? null,
    });

    if (status === 'pending') {
      anyPending = true;
      warnings.push(
        `${String(draft.method).replace(/_/g, ' ')} payment was recorded as pending. Confirm it once the provider responds.`,
      );
    }

    // Change can only come out of cash actually tendered.
    const appliedToSale = Math.min(draft.amount, Math.max(0, outstandingCursor));
    const changeGiven = draft.method === 'cash' ? draft.amount - appliedToSale : 0;
    outstandingCursor = Math.max(0, outstandingCursor - appliedToSale);

    if (draft.method === 'cash' && status === 'successful') {
      cashCollected = add(cashCollected, appliedToSale);
    }

    payments.push({
      id: ulid(),
      saleId,
      method: draft.method,
      amount: draft.amount,
      reference: draft.reference ?? null,
      status,
      requiresAuthorization,
      provider: draft.provider ?? null,
      tenderedAmount: draft.tenderedAmount ?? draft.amount,
      changeGiven: changeGiven > 0 ? (changeGiven as Minor) : null,
      capturedAt: status === 'successful' ? now : null,
      failureReason: draft.failureReason ?? null,
      deviceId: context.deviceId,
    });
  }

  // Any shortfall becomes an explicit receivable rather than a rounding ghost.
  if (outstandingCursor > 0) {
    const credit = paymentDrafts.find((d) => d.method === 'credit');
    if (credit) {
      warnings.push('The unpaid balance has been added to the customer account.');
    }
  }

  const amountPaid = sum(payments.filter((p) => p.status === 'successful').map((p) => p.amount as Minor));
  const paymentStatus: PaymentStatus = anyPending
    ? 'pending'
    : amountPaid >= priced.totals.total
      ? 'successful'
      : 'partially_paid';

  // --- Sale header --------------------------------------------------------
  const sale = {
    id: saleId,
    receiptNumber,
    businessId: context.businessId,
    branchId: context.branchId,
    deviceId: context.deviceId,
    cashierId: context.cashierId,
    customerId: context.customerId,
    shiftId: context.shiftId,
    channel: 'pos' as const,
    status: 'committed' as const,
    currency: context.currency,
    subtotal: priced.totals.subtotal,
    lineDiscountTotal: priced.totals.lineDiscountTotal,
    cartDiscountTotal: priced.totals.cartDiscountTotal,
    discountTotal: priced.totals.discountTotal,
    taxTotal: priced.totals.taxTotal,
    roundingAdjustment: priced.totals.roundingAdjustment,
    total: priced.totals.total,
    amountPaid,
    changeDue: plan.change,
    itemCount: priced.totals.itemCount,
    note: context.note ?? null,
    approvedBy: context.approvedBy ?? null,
    idempotencyKey: saleId,
    committedAt: now,
    voidedAt: null,
    voidReason: null,
  };

  if (priced.totals.roundingAdjustment !== 0) {
    warnings.push(
      `A cash rounding adjustment of ${priced.totals.roundingAdjustment} was applied to reach a payable total.`,
    );
  }

  // --- Audit --------------------------------------------------------------
  const audit: Array<Record<string, unknown>> = [
    {
      id: ulid(),
      businessId: context.businessId,
      branchId: context.branchId,
      deviceId: context.deviceId,
      actorId: context.cashierId,
      actorName: '',
      action: 'sale.commit',
      entityType: 'sale',
      entityId: saleId,
      metadata: {
        receiptNumber,
        total: priced.totals.total,
        discountTotal: priced.totals.discountTotal,
        itemCount: priced.totals.itemCount,
        payments: paymentDrafts.map((p) => ({ method: p.method, amount: p.amount, status: 'recorded' })),
        sequence: context.sequence,
      },
      origin: 'local' as const,
      occurredAt: now,
    },
  ];

  if (priced.totals.discountTotal > 0) {
    audit.push({
      id: ulid(),
      businessId: context.businessId,
      branchId: context.branchId,
      deviceId: context.deviceId,
      actorId: context.cashierId,
      actorName: '',
      action: 'sale.discount_override',
      entityType: 'sale',
      entityId: saleId,
      metadata: { discountTotal: priced.totals.discountTotal, approvedBy: context.approvedBy ?? null },
      origin: 'local' as const,
      occurredAt: now,
    });
  }

  // --- Outbox -------------------------------------------------------------
  const events = buildSaleEvents({
    sale,
    lines,
    payments,
    inventory,
    audit,
    businessId: context.businessId,
    branchId: context.branchId,
    deviceId: context.deviceId,
    now,
  });

  return {
    sale,
    lines,
    payments,
    inventory,
    audit,
    events,
    cashCollected,
    paymentStatus,
    grossProfit: grossProfit(priced.lines),
    warnings,
  };
}

function eventFor(params: {
  entity: EntityKind;
  entityId: string;
  payload: unknown;
  businessId: string;
  branchId: string | null;
  deviceId: string;
  dependsOn?: string[];
  op?: 'insert' | 'update' | 'upsert';
  now: string;
  rank?: number;
}): OutboxEvent {
  void entityRank(params.entity);
  void params.rank;
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
    dependsOn: params.dependsOn ?? [],
    attempts: 0,
    lastError: null,
    nextAttemptAt: params.now,
    createdAt: params.now,
    ackedAt: null,
    serverRevision: null,
  };
}

/**
 * Assemble the outbound queue for a sale.
 *
 * Ordering is explicit rather than incidental: the sale must exist before its
 * lines, and the inventory ledger must reference a sale the server already has.
 * Each child event records the id of its parent event so `orderEvents` can
 * sequence a batch that was restored from disk in any order.
 */
export function buildSaleEvents(params: {
  sale: { id: string; receiptNumber: string };
  lines: Array<Record<string, unknown>>;
  payments: Array<Record<string, unknown>>;
  inventory: InventoryLedgerEntry[];
  audit: Array<Record<string, unknown>>;
  businessId: string;
  branchId: string;
  deviceId: string;
  now: string;
  /** Skip queueing audit rows when the business syncs them separately. */
  includeAudit?: boolean;
}): OutboxEvent[] {
  const { sale, lines, payments, inventory, audit, businessId, branchId, deviceId, now } = params;

  const saleEvent = eventFor({
    entity: 'sale',
    entityId: sale.id,
    payload: sale as unknown as Record<string, unknown>,
    businessId,
    branchId,
    deviceId,
    now,
  });

  const lineEvents = lines.map((line) =>
    eventFor({
      entity: 'sale_line',
      entityId: String(line.id),
      payload: line,
      businessId,
      branchId,
      deviceId,
      dependsOn: [saleEvent.id],
      now,
    }),
  );

  const paymentEvents = payments.map((payment) =>
    eventFor({
      entity: 'payment',
      entityId: String(payment.id),
      payload: payment,
      businessId,
      branchId,
      deviceId,
      dependsOn: [saleEvent.id],
      now,
    }),
  );

  const inventoryEvents = inventory.map((entry) =>
    eventFor({
      entity: 'inventory_ledger',
      entityId: entry.id,
      payload: entry as unknown as Record<string, unknown>,
      businessId,
      branchId,
      deviceId,
      dependsOn: [saleEvent.id],
      now,
    }),
  );

  const auditEvents =
    params.includeAudit === false
      ? []
      : audit.map((entry) =>
          eventFor({
            entity: 'audit_log',
            entityId: String(entry.id),
            payload: entry,
            businessId,
            branchId,
            deviceId,
            dependsOn: [saleEvent.id],
            now,
          }),
        );

  return [...lineEvents, ...paymentEvents, ...inventoryEvents, ...auditEvents, saleEvent];
}

/* ------------------------------------------------------------------ */
/* Void                                                                */
/* ------------------------------------------------------------------ */

export interface VoidResult {
  salePatch: Record<string, unknown>;
  inventory: InventoryLedgerEntry[];
  audit: Array<Record<string, unknown>>;
  events: OutboxEvent[];
}

/**
 * Void a completed sale. A void does NOT delete history — it appends reversing
 * ledger entries and flips the sale's status, and it demands a reason and (per
 * business policy) an approver (PRD §17, §47).
 */
export function voidSale(params: {
  sale: {
    id: string;
    businessId: string;
    branchId: string;
    deviceId: string;
    cashierId: string;
    receiptNumber: string;
    total: Minor;
  };
  originalLedger: readonly InventoryLedgerEntry[];
  reason: string;
  actorId: string;
  approvedBy: string | null;
  now?: string;
}): VoidResult {
  const now = params.now ?? new Date().toISOString();
  const trimmedReason = params.reason.trim();
  if (trimmedReason.length < 3) {
    throw new SaleCommitError('void_reason_required', 'A void requires a reason of at least 3 characters.');
  }

  const salePatch = {
    id: params.sale.id,
    status: 'voided',
    voidedAt: now,
    voidReason: trimmedReason,
    approvedBy: params.approvedBy,
    updatedAt: now,
  };

  const inventory = params.originalLedger.map((entry) =>
    createMovement(
      {
        businessId: entry.businessId,
        branchId: entry.branchId,
        productId: entry.productId,
        variantId: entry.variantId,
        quantityDelta: Math.abs(entry.quantityDelta),
        reason: 'sale_void',
        sourceType: 'sale',
        sourceId: params.sale.id,
        unitCost: entry.unitCost,
        note: `Void: ${trimmedReason}`,
        actorId: params.actorId,
        deviceId: params.sale.deviceId,
      },
      now,
    ),
  );

  const audit = [
    {
      id: ulid(),
      businessId: params.sale.businessId,
      branchId: params.sale.branchId,
      deviceId: params.sale.deviceId,
      actorId: params.actorId,
      actorName: '',
      action: 'sale.void',
      entityType: 'sale',
      entityId: params.sale.id,
      metadata: { receiptNumber: params.sale.receiptNumber, reason: trimmedReason, total: params.sale.total, approvedBy: params.approvedBy },
      origin: 'local' as const,
      occurredAt: now,
    },
  ];

  const events = [
    ...inventory.map((entry) =>
      eventFor({
        entity: 'inventory_ledger',
        entityId: entry.id,
        payload: entry,
        businessId: params.sale.businessId,
        branchId: params.sale.branchId,
        deviceId: params.sale.deviceId,
        dependsOn: [params.sale.id],
        now,
      }),
    ),
    ...audit.map((entry) =>
      eventFor({
        entity: 'audit_log',
        entityId: String(entry.id),
        payload: entry,
        businessId: params.sale.businessId,
        branchId: params.sale.branchId,
        deviceId: params.sale.deviceId,
        dependsOn: [params.sale.id],
        now,
      }),
    ),
    eventFor({
      entity: 'sale',
      entityId: params.sale.id,
      op: 'update',
      payload: salePatch,
      businessId: params.sale.businessId,
      branchId: params.sale.branchId,
      deviceId: params.sale.deviceId,
      now,
    }),
  ];

  return { salePatch, inventory, audit, events };
}

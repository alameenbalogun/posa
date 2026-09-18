/**
 * Inventory ledger (PRD §14, §36).
 *
 * THE INVARIANT: stock is never stored as a mutable number. It is derived by
 * folding an ordered, append-only log of movements. That single decision is what
 * makes POSA's inventory auditable, restart-safe, conflict-tolerant and
 * reconcilable — the properties the PRD demands under "Inventory accuracy" and
 * "Never rely exclusively on client-side inventory quantities" (PRD §47).
 *
 * Quantity is a float by necessity (0.75kg of rice, 2.5m of cable) but every
 * movement is an explicit signed delta with a reason, an actor and a source, so
 * "why is stock 3?" always has a traceable answer.
 */

import type {
  Id,
  InventoryLedgerEntry,
  StockCountLine,
  StockCountSession,
  StockLevel,
  StockMovementReason,
  StockTransfer,
  StockTransferLine,
} from './types';
import { ulid } from './ulid';
import { scale, ZERO, type Minor } from './money';

/* ------------------------------------------------------------------ */
/* Movements                                                           */
/* ------------------------------------------------------------------ */

export interface MovementInput {
  businessId: Id;
  branchId: Id;
  productId: Id;
  variantId?: Id | null;
  quantityDelta: number;
  reason: StockMovementReason;
  sourceType?: InventoryLedgerEntry['sourceType'];
  sourceId?: Id | null;
  unitCost?: Minor | null;
  note?: string | null;
  actorId?: Id | null;
  deviceId: Id;
  location?: InventoryLedgerEntry['location'];
  occurredAt?: string;
}

export function createMovement(input: MovementInput, now: string = new Date().toISOString()): InventoryLedgerEntry {
  if (!Number.isFinite(input.quantityDelta) || input.quantityDelta === 0) {
    throw new Error('Inventory movement must have a non-zero, finite quantity delta.');
  }
  return {
    id: ulid(),
    businessId: input.businessId,
    branchId: input.branchId,
    productId: input.productId,
    variantId: input.variantId ?? null,
    quantityDelta: input.quantityDelta,
    reason: input.reason,
    sourceType: input.sourceType ?? null,
    sourceId: input.sourceId ?? null,
    unitCost: input.unitCost ?? null,
    note: input.note ?? null,
    actorId: input.actorId ?? null,
    deviceId: input.deviceId,
    occurredAt: input.occurredAt ?? now,
    location: input.location ?? null,
  };
}

/** Movements caused by committing a sale (always outflows). */
export function saleMovements(
  params: {
    businessId: Id;
    branchId: Id;
    deviceId: Id;
    actorId: Id;
    saleId: Id;
    lines: Array<{ productId: Id; variantId: Id | null; quantity: number; unitCost: Minor }>;
    occurredAt?: string;
  },
  now: string = new Date().toISOString(),
): InventoryLedgerEntry[] {
  return params.lines.map((line) =>
    createMovement(
      {
        businessId: params.businessId,
        branchId: params.branchId,
        productId: line.productId,
        variantId: line.variantId,
        quantityDelta: -Math.abs(line.quantity),
        reason: 'sale',
        sourceType: 'sale',
        sourceId: params.saleId,
        unitCost: line.unitCost,
        actorId: params.actorId,
        deviceId: params.deviceId,
        occurredAt: params.occurredAt ?? now,
      },
      now,
    ),
  );
}

/**
 * Movements that reverse a sale — used by voids and, for the restock portion,
 * by returns. We deliberately emit a NEW entry referencing the original sale
 * rather than deleting the sale's entries: history is append-only.
 */
export function reverseSaleMovements(
  params: {
    original: readonly InventoryLedgerEntry[];
    reason: Extract<StockMovementReason, 'sale_void' | 'return'>;
    sourceId: Id;
    restockQuantityFor?: (entry: InventoryLedgerEntry) => number;
    actorId: Id;
    deviceId: Id;
    note?: string;
  },
  now: string = new Date().toISOString(),
): InventoryLedgerEntry[] {
  return params.original.map((entry) =>
    createMovement(
      {
        businessId: entry.businessId,
        branchId: entry.branchId,
        productId: entry.productId,
        variantId: entry.variantId,
        quantityDelta:
          params.restockQuantityFor?.(entry) ?? Math.abs(entry.quantityDelta),
        reason: params.reason,
        sourceType: params.reason === 'return' ? 'return' : 'sale',
        sourceId: params.sourceId,
        unitCost: entry.unitCost,
        actorId: params.actorId,
        deviceId: params.deviceId,
        note: params.note ?? null,
      },
      now,
    ),
  );
}

/* ------------------------------------------------------------------ */
/* Derivation                                                          */
/* ------------------------------------------------------------------ */

export interface StockKey {
  productId: Id;
  variantId: Id | null;
  branchId: Id;
}

export function stockKeyOf(entry: { productId: Id; variantId: Id | null; branchId: Id }): string {
  return `${entry.branchId}::${entry.productId}::${entry.variantId ?? '-'}`;
}

export function movementKey(productId: Id, variantId: Id | null, branchId: Id): string {
  return stockKeyOf({ productId, variantId, branchId });
}

/**
 * Fold the ledger into current levels. The ledger arrives in arrival order; we
 * only need the sum, so ordering is irrelevant to the result but preserving it
 * lets us report `lastMovementAt`.
 */
export function deriveStockLevels(entries: readonly InventoryLedgerEntry[]): Map<string, StockLevel> {
  const levels = new Map<string, StockLevel>();
  for (const entry of entries) {
    const key = stockKeyOf(entry);
    const existing = levels.get(key);
    if (existing) {
      existing.quantity += entry.quantityDelta;
      if (!existing.lastMovementAt || entry.occurredAt > existing.lastMovementAt) {
        existing.lastMovementAt = entry.occurredAt;
      }
    } else {
      levels.set(key, {
        productId: entry.productId,
        variantId: entry.variantId,
        branchId: entry.branchId,
        quantity: entry.quantityDelta,
        lastMovementAt: entry.occurredAt,
      });
    }
  }
  return levels;
}

export function stockOnHand(
  entries: readonly InventoryLedgerEntry[],
  productId: Id,
  variantId: Id | null,
  branchId: Id,
): number {
  const key = movementKey(productId, variantId, branchId);
  return entries.reduce((total, entry) => (stockKeyOf(entry) === key ? total + entry.quantityDelta : total), 0);
}

export interface StockCheckResult {
  allowed: boolean;
  available: number;
  shortfall: number;
  /** True when the business forbids negative stock and this would breach it. */
  blockedByPolicy: boolean;
}

/**
 * Guard a sale against the stock policy (PRD §37 "Insufficient stock",
 * PRD §46 "Stock becomes negative under a business policy that disallows it").
 *
 * Note the deliberate asymmetry: offline terminals may all believe stock is 1.
 * We therefore treat this as a *soft* guard — it blocks locally, but the
 * reconciler resolves the race later rather than voiding a receipt the customer
 * has already walked away with.
 */
export function checkAvailability(params: {
  levels: Map<string, StockLevel>;
  productId: Id;
  variantId: Id | null;
  branchId: Id;
  requestedQuantity: number;
  allowNegativeStock: boolean;
}): StockCheckResult {
  const key = movementKey(params.productId, params.variantId, params.branchId);
  const available = params.levels.get(key)?.quantity ?? 0;
  const projected = available - params.requestedQuantity;

  if (params.allowNegativeStock) {
    return { allowed: true, available, shortfall: 0, blockedByPolicy: false };
  }
  if (projected >= 0) {
    return { allowed: true, available, shortfall: 0, blockedByPolicy: false };
  }
  return {
    allowed: false,
    available,
    shortfall: Math.abs(projected),
    blockedByPolicy: true,
  };
}

/** Weighted-average cost from receipts, used for valuation and COGS fallback. */
export function weightedAverageCost(entries: readonly InventoryLedgerEntry[]): Minor {
  let quantity = 0;
  let value = 0;
  for (const entry of entries) {
    if (entry.quantityDelta <= 0 || entry.unitCost == null) continue;
    quantity += entry.quantityDelta;
    value += entry.unitCost * entry.quantityDelta;
  }
  if (quantity <= 0) return ZERO;
  return Math.round(value / quantity) as Minor;
}

/**
 * Stock valuation at cost. Negative stock is valued as zero so a mis-count
 * cannot produce a negative balance-sheet figure.
 */
export function valueStock(
  entries: readonly InventoryLedgerEntry[],
  costFor: (entry: { productId: Id; variantId: Id | null }) => Minor,
): Minor {
  return entries.reduce<number>((total, entry) => {
    const cost = entry.unitCost ?? costFor(entry);
    const running = total + entry.quantityDelta * cost;
    return running;
  }, 0) as Minor;
}

/* ------------------------------------------------------------------ */
/* Count sessions (PRD §14, §10.3 scan-to-count)                       */
/* ------------------------------------------------------------------ */

export function startCountSession(params: {
  businessId: Id;
  branchId: Id;
  name: string;
  startedBy: Id;
  lines: Array<{ productId: Id; variantId: Id | null; expectedQuantity: number }>;
  now?: string;
}): { session: StockCountSession; lines: StockCountLine[] } {
  const now = params.now ?? new Date().toISOString();
  const sessionId = ulid();
  const session: StockCountSession = {
    id: sessionId,
    businessId: params.businessId,
    branchId: params.branchId,
    name: params.name,
    status: 'counting',
    startedBy: params.startedBy,
    startedAt: now,
    closedAt: null,
    snapshotAt: now,
  };
  const lines: StockCountLine[] = params.lines.map((line) => ({
    id: ulid(),
    sessionId,
    productId: line.productId,
    variantId: line.variantId,
    expectedQuantity: line.expectedQuantity,
    countedQuantity: 0,
    varianceReason: null,
    countedBy: null,
    countedAt: null,
  }));
  return { session, lines };
}

/**
 * Apply a scan to a count line. Restart-safe: the counted quantity is stored,
 * not held in memory, so closing the app mid-count loses nothing (PRD §45).
 */
export function applyCount(
  lines: readonly StockCountLine[],
  productId: Id,
  variantId: Id | null,
  quantity: number,
  counterId: Id,
  mode: 'set' | 'increment' = 'increment',
  now: string = new Date().toISOString(),
): { lines: StockCountLine[]; matched: boolean; line: StockCountLine | null } {
  let matched = false;
  let updated: StockCountLine | null = null;
  const next = lines.map((line) => {
    if (line.productId !== productId || line.variantId !== variantId) return line;
    matched = true;
    updated = {
      ...line,
      countedQuantity: mode === 'set' ? quantity : line.countedQuantity + quantity,
      countedBy: counterId,
      countedAt: now,
    };
    return updated;
  });
  return { lines: next, matched, line: updated };
}

/** Turn a posted count into ledger corrections. Only variances produce entries. */
export function countCorrections(params: {
  session: StockCountSession;
  lines: readonly StockCountLine[];
  deviceId: Id;
  actorId: Id;
  now?: string;
}): InventoryLedgerEntry[] {
  const now = params.now ?? new Date().toISOString();
  return params.lines
    .map((line) => {
      const variance = line.countedQuantity - line.expectedQuantity;
      if (variance === 0) return null;
      return createMovement(
        {
          businessId: params.session.businessId,
          branchId: params.session.branchId,
          productId: line.productId,
          variantId: line.variantId,
          quantityDelta: variance,
          reason: 'count_correction',
          sourceType: 'count',
          sourceId: params.session.id,
          note: line.varianceReason,
          actorId: params.actorId,
          deviceId: params.deviceId,
        },
        now,
      );
    })
    .filter((entry): entry is InventoryLedgerEntry => entry !== null);
}

export interface CountVarianceSummary {
  counted: number;
  expected: number;
  variance: number;
  /** Variance as a share of expected, for the shrink report. */
  varianceRate: number;
  linesWithVariance: number;
  /** Value of the variance at cost — the money number that gets attention. */
  varianceValue: Minor;
  worstLines: Array<{ productId: Id; variance: number; varianceValue: Minor }>;
}

export function summariseCount(
  lines: readonly StockCountLine[],
  costFor: (productId: Id, variantId: Id | null) => Minor,
): CountVarianceSummary {
  let counted = 0;
  let expected = 0;
  let linesWithVariance = 0;
  let varianceValue = 0;
  const perLine: Array<{ productId: Id; variance: number; varianceValue: Minor }> = [];

  for (const line of lines) {
    counted += line.countedQuantity;
    expected += line.expectedQuantity;
    const variance = line.countedQuantity - line.expectedQuantity;
    if (variance !== 0) {
      linesWithVariance += 1;
      const value = scale(costFor(line.productId, line.variantId), variance);
      varianceValue += value;
      perLine.push({ productId: line.productId, variance, varianceValue: value });
    }
  }

  return {
    counted,
    expected,
    variance: counted - expected,
    varianceRate: expected === 0 ? 0 : (counted - expected) / expected,
    linesWithVariance,
    varianceValue: varianceValue as Minor,
    worstLines: perLine.sort((a, b) => Math.abs(b.varianceValue) - Math.abs(a.varianceValue)).slice(0, 10),
  };
}

/* ------------------------------------------------------------------ */
/* Transfers (PRD §23)                                                 */
/* ------------------------------------------------------------------ */

/**
 * A transfer produces a PAIRED movement: one outflow at the source, one inflow
 * at the destination. Writing both at the same time keeps them impossible to
 * desynchronise, and the pair shares a transfer id so the reconciler can spot a
 * half-applied transfer.
 */
export function transferMovements(params: {
  transfer: Pick<StockTransfer, 'id' | 'businessId' | 'fromBranchId' | 'toBranchId'>;
  lines: readonly StockTransferLine[];
  deviceId: Id;
  actorId: Id;
  direction: 'dispatch' | 'receive';
  now?: string;
}): InventoryLedgerEntry[] {
  const now = params.now ?? new Date().toISOString();
  const out: InventoryLedgerEntry[] = [];
  for (const line of params.lines) {
    if (params.direction === 'dispatch') {
      out.push(
        createMovement({
          businessId: params.transfer.businessId,
          branchId: params.transfer.fromBranchId,
          productId: line.productId,
          variantId: line.variantId,
          quantityDelta: -Math.abs(line.quantity),
          reason: 'transfer_out',
          sourceType: 'transfer',
          sourceId: params.transfer.id,
          actorId: params.actorId,
          deviceId: params.deviceId,
        }, now),
      );
    } else {
      out.push(
        createMovement({
          businessId: params.transfer.businessId,
          branchId: params.transfer.toBranchId,
          productId: line.productId,
          variantId: line.variantId,
          quantityDelta: Math.abs(line.receivedQuantity || line.quantity),
          reason: 'transfer_in',
          sourceType: 'transfer',
          sourceId: params.transfer.id,
          actorId: params.actorId,
          deviceId: params.deviceId,
        }, now),
      );
    }
  }
  return out;
}

export const MOVEMENT_LABELS: Record<StockMovementReason, string> = {
  opening_balance: 'Opening balance',
  sale: 'Sale',
  sale_void: 'Sale voided',
  return: 'Returned to stock',
  purchase_receipt: 'Stock received',
  adjustment: 'Adjustment',
  count_correction: 'Count correction',
  transfer_out: 'Transfer out',
  transfer_in: 'Transfer in',
  damage: 'Damaged',
  theft: 'Theft',
  expiry: 'Expired',
};

/** Reasons a human may pick from a manual stock adjustment UI. */
export const MANUAL_ADJUSTMENT_REASONS: readonly StockMovementReason[] = [
  'adjustment',
  'damage',
  'theft',
  'expiry',
  'opening_balance',
];

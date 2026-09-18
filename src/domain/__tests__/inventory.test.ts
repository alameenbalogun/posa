import { describe, expect, it } from 'vitest';
import type { Minor } from '../money';
import {
  applyCount,
  checkAvailability,
  countCorrections,
  createMovement,
  deriveStockLevels,
  saleMovements,
  stockOnHand,
  summariseCount,
  transferMovements,
  valueStock,
  weightedAverageCost,
} from '../inventory';
import type { InventoryLedgerEntry, StockCountLine, StockCountSession } from '../types';

const m = (value: number): Minor => value as Minor;

const base = {
  businessId: 'biz1',
  branchId: 'br1',
  deviceId: 'dev1',
};

describe('movements', () => {
  it('refuses a zero-quantity movement so the ledger has no no-op rows', () => {
    expect(() => createMovement({ ...base, productId: 'p1', quantityDelta: 0, reason: 'adjustment' })).toThrow();
    expect(() => createMovement({ ...base, productId: 'p1', quantityDelta: Number.NaN, reason: 'adjustment' })).toThrow();
  });

  it('produces one outflow per sold line, signed negative', () => {
    const entries = saleMovements({
      ...base,
      actorId: 'u1',
      saleId: 'sale1',
      lines: [
        { productId: 'p1', variantId: null, quantity: 2, unitCost: m(700) },
        { productId: 'p2', variantId: 'v1', quantity: 0.5, unitCost: m(1200) },
      ],
    });
    expect(entries).toHaveLength(2);
    expect(entries[0].quantityDelta).toBe(-2);
    expect(entries[1].quantityDelta).toBe(-0.5);
    expect(entries[0].reason).toBe('sale');
    expect(entries[0].sourceId).toBe('sale1');
  });
});

describe('derivation', () => {
  it('folds an ordered ledger into current levels', () => {
    const entries: InventoryLedgerEntry[] = [
      createMovement({ ...base, productId: 'p1', quantityDelta: 10, reason: 'opening_balance' }),
      createMovement({ ...base, productId: 'p1', quantityDelta: -3, reason: 'sale' }),
      createMovement({ ...base, productId: 'p1', quantityDelta: 5, reason: 'purchase_receipt' }),
    ];
    const levels = deriveStockLevels(entries);
    const key = 'br1::p1::-';
    expect(levels.get(key)?.quantity).toBe(12);
  });

  it('isolates stock per branch and per variant', () => {
    const entries = [
      createMovement({ ...base, productId: 'p1', quantityDelta: 10, reason: 'opening_balance' }),
      createMovement({ ...base, branchId: 'br2', productId: 'p1', quantityDelta: 4, reason: 'opening_balance' }),
      createMovement({ ...base, productId: 'p1', variantId: 'v1', quantityDelta: 2, reason: 'opening_balance' }),
    ];
    const levels = deriveStockLevels(entries);
    expect(levels.get('br1::p1::-')?.quantity).toBe(10);
    expect(levels.get('br2::p1::-')?.quantity).toBe(4);
    expect(levels.get('br1::p1::v1')?.quantity).toBe(2);
    expect(stockOnHand(entries, 'p1', null, 'br1')).toBe(10);
  });

  it('tracks the most recent movement time', () => {
    const entries = [
      createMovement({ ...base, productId: 'p1', quantityDelta: 1, reason: 'adjustment', occurredAt: '2026-01-01T00:00:00.000Z' }),
      createMovement({ ...base, productId: 'p1', quantityDelta: 1, reason: 'adjustment', occurredAt: '2026-05-01T00:00:00.000Z' }),
    ];
    expect(deriveStockLevels(entries).get('br1::p1::-')?.lastMovementAt).toBe('2026-05-01T00:00:00.000Z');
  });
});

describe('stock policy', () => {
  const entries = [createMovement({ ...base, productId: 'p1', quantityDelta: 3, reason: 'opening_balance' })];
  const levels = deriveStockLevels(entries);

  it('allows a sale that stays at or above zero', () => {
    const check = checkAvailability({ levels, productId: 'p1', variantId: null, branchId: 'br1', requestedQuantity: 3, allowNegativeStock: false });
    expect(check.allowed).toBe(true);
  });

  it('blocks a sale that would go negative when policy forbids it', () => {
    const check = checkAvailability({ levels, productId: 'p1', variantId: null, branchId: 'br1', requestedQuantity: 5, allowNegativeStock: false });
    expect(check.allowed).toBe(false);
    expect(check.shortfall).toBe(2);
    expect(check.blockedByPolicy).toBe(true);
  });

  it('permits negative stock when the business allows it', () => {
    const check = checkAvailability({ levels, productId: 'p1', variantId: null, branchId: 'br1', requestedQuantity: 99, allowNegativeStock: true });
    expect(check.allowed).toBe(true);
  });

  it('blocks an unknown product outright when negative stock is disallowed', () => {
    const check = checkAvailability({ levels, productId: 'unknown', variantId: null, branchId: 'br1', requestedQuantity: 1, allowNegativeStock: false });
    expect(check.allowed).toBe(false);
    expect(check.available).toBe(0);
  });
});

describe('valuation', () => {
  it('computes a weighted average cost from receipts', () => {
    const entries = [
      createMovement({ ...base, productId: 'p1', quantityDelta: 10, reason: 'purchase_receipt', unitCost: m(1000) }),
      createMovement({ ...base, productId: 'p1', quantityDelta: 10, reason: 'purchase_receipt', unitCost: m(1200) }),
    ];
    expect(weightedAverageCost(entries)).toBe(1100);
  });

  it('returns zero when there are no costed receipts', () => {
    expect(weightedAverageCost([])).toBe(0);
  });

  it('values running stock using captured unit costs', () => {
    const entries = [
      createMovement({ ...base, productId: 'p1', quantityDelta: 10, reason: 'purchase_receipt', unitCost: m(1000) }),
      createMovement({ ...base, productId: 'p1', quantityDelta: -4, reason: 'sale', unitCost: m(1000) }),
    ];
    expect(valueStock(entries, () => m(0))).toBe(6000);
  });
});

describe('count sessions', () => {
  const lines: StockCountLine[] = [
    { id: 'l1', sessionId: 'sc1', productId: 'p1', variantId: null, expectedQuantity: 10, countedQuantity: 0, varianceReason: null, countedBy: null, countedAt: null },
    { id: 'l2', sessionId: 'sc1', productId: 'p2', variantId: null, expectedQuantity: 5, countedQuantity: 0, varianceReason: null, countedBy: null, countedAt: null },
  ];

  it('increments on each scan so rapid repeated scans accumulate', () => {
    let current = lines;
    current = applyCount(current, 'p1', null, 1, 'u1').lines;
    current = applyCount(current, 'p1', null, 1, 'u1').lines;
    const result = applyCount(current, 'p1', null, 1, 'u1');
    expect(result.line?.countedQuantity).toBe(3);
    expect(result.matched).toBe(true);
  });

  it('can set an absolute quantity instead of incrementing', () => {
    const result = applyCount(lines, 'p2', null, 7, 'u1', 'set');
    expect(result.line?.countedQuantity).toBe(7);
  });

  it('reports an unmatched scan rather than creating a phantom line', () => {
    const result = applyCount(lines, 'nope', null, 1, 'u1');
    expect(result.matched).toBe(false);
    expect(result.line).toBeNull();
  });

  it('produces corrections only for lines with a variance', () => {
    const session: StockCountSession = {
      id: 'sc1', businessId: 'biz1', branchId: 'br1', name: 'Monthly', status: 'review',
      startedBy: 'u1', startedAt: '2026-09-01T00:00:00.000Z', closedAt: null, snapshotAt: '2026-09-01T00:00:00.000Z',
    };
    const counted = [
      { ...lines[0], countedQuantity: 8 },
      { ...lines[1], countedQuantity: 5 },
    ];
    const corrections = countCorrections({ session, lines: counted, deviceId: 'dev1', actorId: 'u1' });
    expect(corrections).toHaveLength(1);
    expect(corrections[0].quantityDelta).toBe(-2);
    expect(corrections[0].reason).toBe('count_correction');
    expect(corrections[0].sourceId).toBe('sc1');
  });

  it('summarises the money at risk in a count', () => {
    const counted = [
      { ...lines[0], countedQuantity: 8 },
      { ...lines[1], countedQuantity: 5 },
    ];
    const summary = summariseCount(counted, () => m(500));
    expect(summary.variance).toBe(-2);
    expect(summary.varianceValue).toBe(-1000);
    expect(summary.linesWithVariance).toBe(1);
  });
});

describe('transfers', () => {
  const transfer = { id: 't1', businessId: 'biz1', fromBranchId: 'br1', toBranchId: 'br2' };
  const lines = [{ productId: 'p1', variantId: null, quantity: 5, receivedQuantity: 4 }];

  it('creates a matching outflow at the source and inflow at the destination', () => {
    const out = transferMovements({ transfer, lines, deviceId: 'dev1', actorId: 'u1', direction: 'dispatch' });
    const back = transferMovements({ transfer, lines, deviceId: 'dev1', actorId: 'u1', direction: 'receive' });
    expect(out[0].quantityDelta).toBe(-5);
    expect(out[0].branchId).toBe('br1');
    expect(back[0].quantityDelta).toBe(4); // partial receipt is respected
    expect(back[0].branchId).toBe('br2');
    // The pair shares the transfer id so a half-applied transfer is detectable.
    expect(out[0].sourceId).toBe(back[0].sourceId);
  });
});

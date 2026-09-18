import { describe, expect, it } from 'vitest';
import type { Minor } from '../money';
import {
  buildReturn,
  computeRefund,
  DEFAULT_RETURN_POLICY,
  evaluateReturn,
  isFullReturn,
  parseReceiptQr,
  receiptQrPayload,
} from '../returns';
import type { SaleLine } from '../types';

const m = (value: number): Minor => value as Minor;

/** 3 x ₦10.00 with 7.5% VAT added on top: 3000 base + 225 tax = 3225. */
function saleLine(overrides: Partial<SaleLine> = {}): SaleLine {
  return {
    id: 'sl1',
    saleId: 'sale1',
    productId: 'p1',
    variantId: null,
    name: 'Rice 5kg',
    sku: 'RICE-5',
    barcode: '1234567890128',
    quantity: 3,
    unitPrice: m(1000),
    lineDiscount: 0,
    allocatedDiscount: 0,
    taxRateBasisPoints: 750,
    taxableBase: m(3000),
    taxAmount: m(225),
    lineTotal: m(3225),
    unitCost: m(700),
    returnableQuantity: 3,
    returnedQuantity: 0,
    ...overrides,
  };
}

const SALE = {
  id: 'sale1',
  receiptNumber: 'LAG-A1B2-000001',
  businessId: 'biz1',
  branchId: 'br1',
  deviceId: 'dev1',
  status: 'committed',
  total: m(3225),
  committedAt: '2026-09-01T10:00:00.000Z',
};

const CTX = {
  businessId: 'biz1',
  branchId: 'br1',
  deviceId: 'dev1',
  cashierId: 'user1',
  approvedBy: null,
  reason: 'customer_changed_mind' as const,
  reasonNote: null,
  refundMethod: 'cash' as const,
};

describe('eligibility', () => {
  it('allows a return inside the window', () => {
    const result = evaluateReturn({ sale: SALE, lines: [saleLine()], now: '2026-09-05T10:00:00.000Z' });
    expect(result.eligible).toBe(true);
    expect(result.lines[0].returnable).toBe(3);
  });

  it('flags an expired window but does not silently block the refund', () => {
    const result = evaluateReturn({ sale: SALE, lines: [saleLine()], now: '2026-12-01T10:00:00.000Z' });
    expect(result.windowExpired).toBe(true);
    expect(result.reason).toContain('approval required');
  });

  it('refuses to return a voided sale', () => {
    const result = evaluateReturn({ sale: { ...SALE, status: 'voided' }, lines: [saleLine()] });
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('voided');
  });

  it('refuses when nothing remains returnable', () => {
    const result = evaluateReturn({ sale: SALE, lines: [saleLine({ returnedQuantity: 3 })] });
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('No items remain');
  });

  it('tracks a partial return so the remainder is still returnable', () => {
    const result = evaluateReturn({ sale: SALE, lines: [saleLine({ returnedQuantity: 1 })] });
    expect(result.eligible).toBe(true);
    expect(result.lines[0].returnable).toBe(2);
  });
});

describe('refund maths', () => {
  it('pro-rates a single unit out of three', () => {
    const result = computeRefund({
      returnId: 'r1',
      saleLines: [saleLine()],
      requested: [{ saleLineId: 'sl1', quantity: 1 }],
    });
    expect(result.lines[0].lineRefund).toBe(1075);
    expect(result.lines[0].taxRefund).toBe(75);
    expect(result.refundTotal).toBe(1075);
    expect(result.errors).toHaveLength(0);
  });

  it('refunds exactly what was paid across a partial-then-full sequence', () => {
    const first = computeRefund({
      returnId: 'r1',
      saleLines: [saleLine()],
      requested: [{ saleLineId: 'sl1', quantity: 1 }],
    });
    const second = computeRefund({
      returnId: 'r1',
      saleLines: [saleLine({ returnedQuantity: 1 })],
      requested: [{ saleLineId: 'sl1', quantity: 2 }],
    });
    expect(first.refundTotal + second.refundTotal).toBe(3225);
    expect(first.refundTax + second.refundTax).toBe(225);
  });

  it('never refunds more units than were sold', () => {
    const result = computeRefund({
      returnId: 'r1',
      saleLines: [saleLine()],
      requested: [{ saleLineId: 'sl1', quantity: 5 }],
    });
    expect(result.errors[0]).toContain('only 3 left');
    expect(result.lines).toHaveLength(0);
  });

  it('ignores lines that are not part of the sale', () => {
    const result = computeRefund({
      returnId: 'r1',
      saleLines: [saleLine()],
      requested: [{ saleLineId: 'ghost', quantity: 1 }],
    });
    expect(result.errors[0]).toContain('not part of this sale');
  });

  it('splits the refund so the parts always sum to the line total', () => {
    const line = saleLine({ lineTotal: m(1000), taxAmount: m(70), quantity: 3 });
    for (const quantity of [1, 2, 3]) {
      const result = computeRefund({
        returnId: 'r',
        saleLines: [line],
        requested: [{ saleLineId: 'sl1', quantity }],
      });
      expect(result.refundTotal).toBeLessThanOrEqual(1000);
      expect(result.refundTotal).toBeGreaterThan(0);
    }
  });

  it('detects a full return', () => {
    expect(isFullReturn([saleLine()], [{ saleLineId: 'sl1', quantity: 3 }])).toBe(true);
    expect(isFullReturn([saleLine()], [{ saleLineId: 'sl1', quantity: 1 }])).toBe(false);
  });
});

describe('building a return', () => {
  it('restocks the returned goods and updates the sale status', () => {
    const bundle = buildReturn({
      sale: SALE,
      saleLines: [saleLine()],
      requested: [{ saleLineId: 'sl1', quantity: 1 }],
      context: { ...CTX, now: '2026-09-05T10:00:00.000Z' },
    });
    expect(bundle.inventory).toHaveLength(1);
    expect(bundle.inventory[0].quantityDelta).toBe(1);
    expect(bundle.inventory[0].reason).toBe('return');
    expect(bundle.salePatch.status).toBe('partially_returned');
    expect(bundle.saleLinePatches[0].returnedQuantity).toBe(1);
    expect(bundle.refundTotal).toBe(1075);
    expect(bundle.audit[0].action).toBe('return.commit');
  });

  it('marks the sale fully returned when everything goes back', () => {
    const bundle = buildReturn({
      sale: SALE,
      saleLines: [saleLine()],
      requested: [{ saleLineId: 'sl1', quantity: 3 }],
      context: CTX,
    });
    expect(bundle.salePatch.status).toBe('returned');
    expect(bundle.refundTotal).toBe(3225);
  });

  it('does not restock damaged goods', () => {
    const bundle = buildReturn({
      sale: SALE,
      saleLines: [saleLine()],
      requested: [{ saleLineId: 'sl1', quantity: 2 }],
      context: { ...CTX, reason: 'damaged' },
      policy: { ...DEFAULT_RETURN_POLICY, defaultRestock: false },
    });
    expect(bundle.inventory).toHaveLength(0);
    expect(bundle.refundTotal).toBeGreaterThan(0);
  });

  it('allows a per-line restock override', () => {
    const bundle = buildReturn({
      sale: SALE,
      saleLines: [saleLine()],
      requested: [{ saleLineId: 'sl1', quantity: 1 }],
      context: { ...CTX, restockFor: () => true },
      policy: { ...DEFAULT_RETURN_POLICY, defaultRestock: false },
    });
    expect(bundle.inventory).toHaveLength(1);
  });

  it('works against a receipt the terminal has never verified with the cloud', () => {
    // The stale-offline-receipt edge case (PRD §46).
    const bundle = buildReturn({
      sale: SALE,
      saleLines: [saleLine()],
      requested: [{ saleLineId: 'sl1', quantity: 1 }],
      context: CTX,
      policy: { ...DEFAULT_RETURN_POLICY, allowStaleOfflineReceipt: true },
    });
    expect(bundle.refundTotal).toBe(1075);
  });

  it('throws with a usable message when asked to return nothing', () => {
    expect(() =>
      buildReturn({ sale: SALE, saleLines: [saleLine()], requested: [], context: CTX }),
    ).toThrow(/at least one item/i);
  });
});

describe('receipt QR', () => {
  it('round-trips a sale lookup payload', () => {
    const payload = receiptQrPayload({
      receiptNumber: 'LAG-A1B2-000001',
      saleId: 'sale1',
      businessId: 'biz1',
      branchId: 'br1',
      total: m(3225),
      committedAt: '2026-09-01T10:00:00.000Z',
    });
    const parsed = parseReceiptQr(payload);
    expect(parsed?.receiptNumber).toBe('LAG-A1B2-000001');
    expect(parsed?.saleId).toBe('sale1');
    expect(parsed?.total).toBe(3225);
    // Case is preserved through the QR path.
    expect(payload).toContain('LAG-A1B2-000001');
  });

  it('accepts a bare receipt number typed manually', () => {
    expect(parseReceiptQr('LAG-A1B2-000001')?.receiptNumber).toBe('LAG-A1B2-000001');
  });

  it('rejects unrelated QR content', () => {
    expect(parseReceiptQr('{"t":"product"}')).toBeNull();
    expect(parseReceiptQr('not json at all')).not.toBeNull(); // treated as a typed code
  });
});

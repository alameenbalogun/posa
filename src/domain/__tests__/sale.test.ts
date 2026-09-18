import { describe, expect, it } from 'vitest';
import type { Minor } from '../money';
import {
  buildCommittedSale,
  deviceCodeFromId,
  formatReceiptNumber,
  parseReceiptNumber,
  SaleCommitError,
  transition,
  voidSale,
  type CommitContext,
} from '../sale';
import { addLine, createCart, setQuantity } from '../cart';
import { fixedDiscount, percentDiscount, priceCart } from '../pricing';
import { orderEvents } from '../sync-protocol';

const m = (value: number): Minor => value as Minor;

const CONFIG = { currency: 'NGN', taxInclusive: false, rounding: { cashRoundingTo: 0, cashRoundingMode: 'nearest' as const } };

function buildCart() {
  let cart = createCart({
    businessId: 'biz1',
    branchId: 'br1',
    deviceId: 'device-01H8XYZABCDEFGHJKMNPQRSTV',
    cashierId: 'user1',
    currency: 'NGN',
  });
  cart = addLine(cart, {
    productId: 'p1',
    variantId: null,
    name: 'Rice 5kg',
    sku: 'RICE-5',
    barcode: '1234567890128',
    unitPrice: m(1000),
    unitCost: m(700),
    taxRateBasisPoints: 750,
    unit: 'unit',
    quantity: 2,
  });
  return cart;
}

function context(overrides: Partial<CommitContext> = {}): CommitContext {
  return {
    businessId: 'biz1',
    branchId: 'br1',
    deviceId: 'device-01H8XYZABCDEFGHJKMNPQRSTV',
    cashierId: 'user1',
    shiftId: 'shift1',
    customerId: null,
    branchCode: 'LAG',
    deviceCode: 'A1B2',
    sequence: 5,
    currency: 'NGN',
    isOnline: true,
    now: '2026-09-15T10:00:00.000Z',
    ...overrides,
  };
}

describe('receipt numbers', () => {
  it('pads the sequence and upper-cases the codes', () => {
    expect(formatReceiptNumber({ branchCode: 'lag', deviceCode: 'a1b2', sequence: 5 })).toBe('LAG-A1B2-000005');
  });

  it('round-trips', () => {
    expect(parseReceiptNumber('LAG-A1B2-000005')).toEqual({ branchCode: 'LAG', deviceCode: 'A1B2', sequence: 5 });
    expect(parseReceiptNumber('nonsense')).toBeNull();
  });

  it('derives a stable short device code', () => {
    const code = deviceCodeFromId('device-01H8XYZABCDEFGHJKMNPQRSTV');
    expect(code).toHaveLength(4);
    expect(deviceCodeFromId('device-01H8XYZABCDEFGHJKMNPQRSTV')).toBe(code);
  });

  it('keeps two offline devices from colliding on the same sequence', () => {
    const a = formatReceiptNumber({ branchCode: 'LAG', deviceCode: 'A1B2', sequence: 7 });
    const b = formatReceiptNumber({ branchCode: 'LAG', deviceCode: 'C3D4', sequence: 7 });
    expect(a).not.toBe(b);
  });
});

describe('lifecycle', () => {
  const pricedCart = () => priceCart({ lines: buildCart().lines, config: CONFIG });

  it('walks the happy path from building to synced', () => {
    const priced = pricedCart();
    let state = transition('building', { type: 'price' });
    expect(state.next).toBe('priced');

    state = transition(state.next, { type: 'require_payment' }, { priced });
    expect(state.next).toBe('awaiting_payment');

    // Cannot commit straight out of awaiting_payment.
    state = transition(state.next, { type: 'commit' }, { priced });
    expect(state.ok).toBe(false);

    state = transition('awaiting_payment', { type: 'payment_satisfied' }, {
      priced,
      paymentIntents: [{ method: 'cash', amount: priced.totals.total }],
    });
    expect(state.next).toBe('paid');

    state = transition(state.next, { type: 'commit' }, { priced });
    expect(state.next).toBe('committed');
    state = transition(state.next, { type: 'queue' });
    expect(state.next).toBe('queued');
    state = transition(state.next, { type: 'ack' });
    expect(state.next).toBe('synced');
  });

  it('refuses to move to payment before the cart has been priced', () => {
    const result = transition('priced', { type: 'require_payment' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Price the cart');
  });

  it('refuses to commit an empty cart', () => {
    const empty = priceCart({ lines: [], config: CONFIG });
    const result = transition('paid', { type: 'commit' }, { priced: empty });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('empty');
  });

  it('refuses to settle a payment that does not cover the total', () => {
    const priced = priceCart({ lines: buildCart().lines, config: CONFIG });
    const result = transition('awaiting_payment', { type: 'payment_satisfied' }, {
      priced,
      paymentIntents: [{ method: 'cash', amount: m(100) }],
    });
    expect(result.ok).toBe(false);
  });

  it('allows a credit sale to settle with a balance outstanding', () => {
    const priced = priceCart({ lines: buildCart().lines, config: CONFIG });
    const result = transition('awaiting_payment', { type: 'payment_satisfied' }, {
      priced,
      paymentIntents: [{ method: 'cash', amount: m(100) }],
      creditAllowed: true,
    });
    expect(result.ok).toBe(true);
  });

  it('skips payment entirely for a zero-total sale', () => {
    const priced = priceCart({
      lines: buildCart().lines.map((l) => ({ ...l, discount: percentDiscount(10000) })),
      config: CONFIG,
    });
    expect(priced.totals.total).toBe(0);
    const result = transition('priced', { type: 'require_payment' }, { priced });
    expect(result.next).toBe('paid');
  });

  it('cannot reopen a voided sale', () => {
    const result = transition('voided', { type: 'queue' });
    expect(result.ok).toBe(false);
  });
});

describe('atomic commit', () => {
  it('produces exactly one sale, one ledger outflow per line and one outbox event', () => {
    const cart = buildCart();
    const priced = priceCart({ lines: cart.lines, config: CONFIG });
    const bundle = buildCommittedSale(cart, priced, [{ method: 'cash', amount: m(2150) }], context());

    expect(bundle.sale.receiptNumber).toBe('LAG-A1B2-000005');
    expect(bundle.sale.total).toBe(2150);
    expect(bundle.sale.amountPaid).toBe(2150);
    expect(bundle.sale.idempotencyKey).toBe(bundle.sale.id);

    expect(bundle.lines).toHaveLength(1);
    expect(bundle.inventory).toHaveLength(1);
    expect(bundle.inventory[0].quantityDelta).toBe(-2);
    expect(bundle.inventory[0].sourceId).toBe(bundle.sale.id);

    const saleEvents = bundle.events.filter((e) => e.entity === 'sale');
    expect(saleEvents).toHaveLength(1);
    expect(bundle.events.filter((e) => e.entity === 'sale_line')).toHaveLength(1);
    expect(bundle.events.filter((e) => e.entity === 'inventory_ledger')).toHaveLength(1);
    expect(bundle.events.filter((e) => e.entity === 'payment')).toHaveLength(1);
  });

  it('records change given from a cash overpayment', () => {
    const cart = buildCart();
    const priced = priceCart({ lines: cart.lines, config: CONFIG });
    const bundle = buildCommittedSale(cart, priced, [{ method: 'cash', amount: m(5000) }], context());
    expect(bundle.sale.changeDue).toBe(2850);
    expect(bundle.payments[0].changeGiven).toBe(2850);
    expect(bundle.cashCollected).toBe(2150);
  });

  it('records an offline card payment as pending and never as successful', () => {
    const cart = buildCart();
    const priced = priceCart({ lines: cart.lines, config: CONFIG });
    const bundle = buildCommittedSale(
      cart,
      priced,
      [{ method: 'card', amount: m(2150), requiresAuthorization: true, reference: null }],
      context({ isOnline: false }),
    );
    expect(bundle.payments[0].status).toBe('pending');
    expect(bundle.paymentStatus).toBe('pending');
    expect(bundle.sale.amountPaid).toBe(0);
    expect(bundle.warnings.join(' ')).toContain('pending');
  });

  it('marks a card payment successful once a provider reference exists', () => {
    const cart = buildCart();
    const priced = priceCart({ lines: cart.lines, config: CONFIG });
    const bundle = buildCommittedSale(
      cart,
      priced,
      [{ method: 'card', amount: m(2150), requiresAuthorization: true, reference: 'RRN-9001' }],
      context(),
    );
    expect(bundle.payments[0].status).toBe('successful');
    expect(bundle.sale.amountPaid).toBe(2150);
  });

  it('refuses to commit an underpaid sale with no credit line', () => {
    const cart = buildCart();
    const priced = priceCart({ lines: cart.lines, config: CONFIG });
    expect(() =>
      buildCommittedSale(cart, priced, [{ method: 'cash', amount: m(500) }], context()),
    ).toThrow(SaleCommitError);
  });

  it('supports a split payment', () => {
    const cart = buildCart();
    const priced = priceCart({ lines: cart.lines, config: CONFIG });
    const bundle = buildCommittedSale(
      cart,
      priced,
      [
        { method: 'cash', amount: m(1150) },
        { method: 'card', amount: m(1000), requiresAuthorization: true, reference: 'RRN-1' },
      ],
      context(),
    );
    expect(bundle.payments).toHaveLength(2);
    expect(bundle.sale.amountPaid).toBe(2150);
    expect(bundle.cashCollected).toBe(1150);
  });

  it('flags a discount in the audit trail', () => {
    let cart = buildCart();
    cart = { ...cart, cartDiscount: fixedDiscount(m(150)) };
    const priced = priceCart({ lines: cart.lines, cartDiscount: cart.cartDiscount, config: CONFIG });
    const bundle = buildCommittedSale(cart, priced, [{ method: 'cash', amount: priced.totals.total }], context());
    expect(bundle.audit.some((a) => a.action === 'sale.discount_override')).toBe(true);
  });

  it('orders the outbox so a sale always precedes its children', () => {
    const cart = buildCart();
    const priced = priceCart({ lines: cart.lines, config: CONFIG });
    const bundle = buildCommittedSale(cart, priced, [{ method: 'cash', amount: m(2150) }], context());
    // Deliberately shuffle: this is what a restored queue looks like.
    const shuffled = [...bundle.events].reverse();
    const ordered = orderEvents(shuffled);
    const saleIndex = ordered.findIndex((e) => e.entity === 'sale');
    const lineIndex = ordered.findIndex((e) => e.entity === 'sale_line');
    const ledgerIndex = ordered.findIndex((e) => e.entity === 'inventory_ledger');
    expect(saleIndex).toBeLessThan(lineIndex);
    expect(saleIndex).toBeLessThan(ledgerIndex);
  });

  it('snapshots line names and prices so a later catalog edit cannot rewrite history', () => {
    let cart = buildCart();
    cart = addLine(cart, {
      productId: 'p2', variantId: null, name: 'Milk 1L', sku: 'MILK-1', barcode: null,
      unitPrice: m(900), unitCost: m(600), taxRateBasisPoints: 750, unit: 'unit',
    });
    const priced = priceCart({ lines: cart.lines, config: CONFIG });
    const bundle = buildCommittedSale(cart, priced, [{ method: 'cash', amount: priced.totals.total }], context());
    expect(bundle.lines.map((l) => l.name)).toEqual(['Rice 5kg', 'Milk 1L']);
    expect(bundle.lines.map((l) => l.unitPrice)).toEqual([1000, 900]);
  });

  it('carries an approver through for a sensitive action', () => {
    const cart = buildCart();
    const priced = priceCart({ lines: cart.lines, config: CONFIG });
    const bundle = buildCommittedSale(cart, priced, [{ method: 'cash', amount: m(2150) }], context({ approvedBy: 'manager1' }));
    expect(bundle.sale.approvedBy).toBe('manager1');
  });
});

describe('void', () => {
  it('appends reversing ledger entries instead of deleting history', () => {
    const cart = buildCart();
    const priced = priceCart({ lines: cart.lines, config: CONFIG });
    const bundle = buildCommittedSale(cart, priced, [{ method: 'cash', amount: m(2150) }], context());

    const result = voidSale({
      sale: {
        id: bundle.sale.id, businessId: 'biz1', branchId: 'br1',
        deviceId: cart.deviceId, cashierId: 'user1',
        receiptNumber: bundle.sale.receiptNumber, total: bundle.sale.total,
      },
      originalLedger: bundle.inventory,
      reason: 'Customer walked away before paying',
      actorId: 'user1',
      approvedBy: 'manager1',
    });

    expect(result.inventory).toHaveLength(1);
    expect(result.inventory[0].quantityDelta).toBe(2); // reverses the -2
    expect(result.inventory[0].reason).toBe('sale_void');
    expect(result.inventory[0].id).not.toBe(bundle.inventory[0].id); // a new row, not an edit
    expect(result.salePatch.status).toBe('voided');
    expect(result.audit[0].action).toBe('sale.void');
  });

  it('demands a reason', () => {
    expect(() =>
      voidSale({
        sale: { id: 's1', businessId: 'b', branchId: 'br', deviceId: 'd', cashierId: 'u', receiptNumber: 'R', total: m(100) },
        originalLedger: [],
        reason: 'x',
        actorId: 'u',
        approvedBy: null,
      }),
    ).toThrow(/reason/);
  });
});

describe('cart integration', () => {
  it('merges repeated scans into one line with an aggregated quantity', () => {
    let cart = buildCart();
    cart = addLine(cart, {
      productId: 'p1', variantId: null, name: 'Rice 5kg', sku: 'RICE-5', barcode: '1234567890128',
      unitPrice: m(1000), unitCost: m(700), taxRateBasisPoints: 750, unit: 'unit', scanned: true,
    });
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0].quantity).toBe(3);
  });

  it('removes a line when its quantity drops to zero', () => {
    let cart = buildCart();
    cart = setQuantity(cart, cart.lines[0].id, 0);
    expect(cart.lines).toHaveLength(0);
  });

  it('bumps the revision on every mutation so the UI can invalidate caches', () => {
    const cart = buildCart();
    const before = cart.revision;
    const after = setQuantity(cart, cart.lines[0].id, 9);
    expect(after.revision).toBeGreaterThan(before);
  });
});

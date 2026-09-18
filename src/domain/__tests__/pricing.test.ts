import { describe, expect, it } from 'vitest';
import type { Minor } from '../money';
import {
  addExclusiveTax,
  classifyPaymentStatus,
  discountBasisPoints,
  extractInclusiveTax,
  fixedDiscount,
  grossProfit,
  NO_DISCOUNT,
  percentDiscount,
  planPayments,
  priceCart,
  resolveDiscount,
  type PriceableLine,
  type PricingConfig,
} from '../pricing';
import { sum } from '../money';

const m = (value: number): Minor => value as Minor;

const EXCLUSIVE: PricingConfig = { currency: 'NGN', taxInclusive: false, rounding: { cashRoundingTo: 0, cashRoundingMode: 'nearest' } };
const INCLUSIVE: PricingConfig = { currency: 'NGN', taxInclusive: true, rounding: { cashRoundingTo: 0, cashRoundingMode: 'nearest' } };

function line(overrides: Partial<PriceableLine> = {}): PriceableLine {
  return {
    id: overrides.id ?? 'line-1',
    productId: 'p1',
    variantId: null,
    name: 'Rice 5kg',
    sku: 'RICE-5',
    barcode: '1234567890128',
    quantity: 1,
    unitPrice: m(1000),
    unitCost: m(700),
    taxRateBasisPoints: 0,
    discount: NO_DISCOUNT,
    ...overrides,
  };
}

describe('tax', () => {
  it('adds tax on top of an exclusive amount', () => {
    expect(addExclusiveTax(m(2000), 750)).toBe(150);
  });

  it('extracts inclusive tax so that net + tax === gross exactly', () => {
    const { net, tax } = extractInclusiveTax(m(1075), 750);
    expect(net).toBe(1000);
    expect(tax).toBe(75);
    expect(net + tax).toBe(1075);
  });

  it('is lossless for every inclusive amount at 7.5%', () => {
    for (let amount = 1; amount <= 5000; amount += 7) {
      const { net, tax } = extractInclusiveTax(m(amount), 750);
      expect(net + tax, `amount=${amount}`).toBe(amount);
    }
  });

  it('is a no-op at a zero rate', () => {
    expect(extractInclusiveTax(m(999), 0)).toEqual({ net: 999, tax: 0 });
  });
});

describe('discounts', () => {
  it('resolves a percentage discount against a base', () => {
    expect(resolveDiscount(percentDiscount(1000), m(2000))).toBe(200);
  });

  it('never lets a discount exceed the base', () => {
    expect(resolveDiscount(fixedDiscount(m(5000)), m(2000))).toBe(2000);
    expect(resolveDiscount(percentDiscount(20000), m(2000))).toBe(2000);
  });

  it('treats a missing discount as zero', () => {
    expect(resolveDiscount(undefined, m(2000))).toBe(0);
  });

  it('expresses a fixed discount in basis points for approval rules', () => {
    expect(discountBasisPoints(fixedDiscount(m(500)), m(2000))).toBe(2500);
    expect(discountBasisPoints(percentDiscount(750), m(2000))).toBe(750);
  });
});

describe('priceCart: tax-exclusive', () => {
  it('prices a two-unit line at 7.5% VAT', () => {
    const cart = priceCart({
      lines: [line({ quantity: 2, unitPrice: m(1000), taxRateBasisPoints: 750 })],
      config: EXCLUSIVE,
    });
    expect(cart.totals.subtotal).toBe(2000);
    expect(cart.totals.taxTotal).toBe(150);
    expect(cart.totals.total).toBe(2150);
    expect(cart.totals.itemCount).toBe(2);
  });

  it('reduces the taxable base when a line is discounted', () => {
    const cart = priceCart({
      lines: [line({ unitPrice: m(2000), taxRateBasisPoints: 750, discount: percentDiscount(1000) })],
      config: EXCLUSIVE,
    });
    expect(cart.lines[0].lineDiscount).toBe(200);
    expect(cart.lines[0].taxableBase).toBe(1800);
    expect(cart.lines[0].taxAmount).toBe(135);
    expect(cart.totals.total).toBe(1935);
  });

  it('is idempotent for identical inputs', () => {
    const build = () =>
      priceCart({ lines: [line({ quantity: 3, unitPrice: m(333) })], config: EXCLUSIVE });
    expect(build().totals).toEqual(build().totals);
  });
});

describe('priceCart: tax-inclusive', () => {
  it('treats the shelf price as the final price', () => {
    const cart = priceCart({ lines: [line({ unitPrice: m(1075), taxRateBasisPoints: 750 })], config: INCLUSIVE });
    expect(cart.totals.total).toBe(1075);
    expect(cart.totals.taxTotal).toBe(75);
    expect(cart.totals.taxableTotal).toBe(1000);
  });

  it('keeps totals whole when many odd-priced lines are taxed', () => {
    const lines = Array.from({ length: 7 }, (_, i) =>
      line({ id: `l${i}`, unitPrice: m(333 + i), quantity: 3, taxRateBasisPoints: 750 }),
    );
    const cart = priceCart({ lines, config: INCLUSIVE });
    const lineSum = sum(cart.lines.map((l) => l.lineTotal));
    expect(cart.totals.total).toBe(lineSum);
    expect(cart.totals.taxableTotal + cart.totals.taxTotal).toBe(lineSum);
  });
});

describe('priceCart: cart-level discount allocation', () => {
  it('spreads a cart discount without losing a kobo', () => {
    const cart = priceCart({
      lines: [
        line({ id: 'a', unitPrice: m(1000), taxRateBasisPoints: 750 }),
        line({ id: 'b', unitPrice: m(1000), taxRateBasisPoints: 750 }),
        line({ id: 'c', unitPrice: m(1000), taxRateBasisPoints: 750 }),
      ],
      cartDiscount: fixedDiscount(m(1000)),
      config: EXCLUSIVE,
    });

    const allocated = cart.lines.reduce((total, l) => total + l.cartDiscountShare, 0);
    expect(allocated).toBe(1000);
    expect(cart.totals.cartDiscountTotal).toBe(1000);
    // 3000 gross - 1000 discount = 2000 taxable; 7.5% of 2000 = 150.
    expect(cart.totals.taxableTotal).toBe(2000);
    expect(cart.totals.taxTotal).toBe(150);
    expect(cart.totals.total).toBe(2150);
  });

  it('discounts the taxable base before tax, not after', () => {
    const cart = priceCart({
      lines: [line({ unitPrice: m(10_000), taxRateBasisPoints: 750 })],
      cartDiscount: percentDiscount(5000),
      config: EXCLUSIVE,
    });
    // Taxing 10,000 then discounting would give 10,750 - 5,000 = 5,750 (over-taxing).
    expect(cart.totals.taxTotal).toBe(375);
    expect(cart.totals.total).toBe(5375);
  });

  it('cannot discount an order below zero', () => {
    const cart = priceCart({
      lines: [line({ unitPrice: m(500) })],
      cartDiscount: fixedDiscount(m(99_999)),
      config: EXCLUSIVE,
    });
    expect(cart.totals.total).toBe(0);
    expect(cart.lines[0].taxableBase).toBe(0);
  });
});

describe('priceCart: cash rounding', () => {
  it('rounds to the nearest payable increment and records the adjustment', () => {
    const cart = priceCart({
      lines: [line({ unitPrice: m(1033) })],
      config: { ...EXCLUSIVE, rounding: { cashRoundingTo: 5, cashRoundingMode: 'nearest' } },
    });
    expect(cart.totals.totalBeforeRounding).toBe(1033);
    expect(cart.totals.total).toBe(1035);
    expect(cart.totals.roundingAdjustment).toBe(2);
  });

  it('can always round in the customer\u2019s favour', () => {
    const cart = priceCart({
      lines: [line({ unitPrice: m(1033) })],
      config: { ...EXCLUSIVE, rounding: { cashRoundingTo: 25, cashRoundingMode: 'up' } },
    });
    expect(cart.totals.total).toBe(1050);
  });
});

describe('priceCart: tax breakdown', () => {
  it('groups tax by rate for a compliant receipt', () => {
    const cart = priceCart({
      lines: [
        line({ id: 'a', unitPrice: m(1000), taxRateBasisPoints: 750 }),
        line({ id: 'b', unitPrice: m(1000), taxRateBasisPoints: 0 }),
        line({ id: 'c', unitPrice: m(1000), taxRateBasisPoints: 750 }),
      ],
      config: EXCLUSIVE,
    });
    expect(cart.totals.taxByRate).toHaveLength(2);
    expect(cart.totals.taxByRate[0]).toEqual({ rateBasisPoints: 0, taxableBase: 1000, taxAmount: 0 });
    expect(cart.totals.taxByRate[1]).toEqual({ rateBasisPoints: 750, taxableBase: 2000, taxAmount: 150 });
  });
});

describe('grossProfit', () => {
  it('computes revenue minus cost snapshot', () => {
    const cart = priceCart({ lines: [line({ quantity: 2, unitPrice: m(1000), unitCost: m(700) })], config: EXCLUSIVE });
    expect(grossProfit(cart.lines)).toBe(600);
  });

  it('handles fractional quantities for weighed goods', () => {
    const cart = priceCart({ lines: [line({ quantity: 0.75, unitPrice: m(1000), unitCost: m(700) })], config: EXCLUSIVE });
    expect(cart.totals.subtotal).toBe(750);
    expect(grossProfit(cart.lines)).toBe(225);
  });
});

describe('payment planning', () => {
  it('gives change when cash exceeds the total', () => {
    const plan = planPayments(m(2150), [{ method: 'cash', amount: m(2500) }]);
    expect(plan.valid).toBe(true);
    expect(plan.change).toBe(350);
    expect(plan.outstanding).toBe(0);
  });

  it('reports an outstanding balance for a short cash payment', () => {
    const plan = planPayments(m(2150), [{ method: 'cash', amount: m(1000) }]);
    expect(plan.valid).toBe(true);
    expect(plan.outstanding).toBe(1150);
    expect(plan.change).toBe(0);
  });

  it('refuses a non-cash overpayment because change cannot be given on a card', () => {
    const plan = planPayments(m(2150), [{ method: 'card', amount: m(2500) }]);
    expect(plan.valid).toBe(false);
    expect(plan.overpayOnNonCash).toBe(350);
  });

  it('accepts a split payment that settles exactly', () => {
    const plan = planPayments(m(2150), [
      { method: 'cash', amount: m(1150) },
      { method: 'card', amount: m(1000) },
    ]);
    expect(plan.valid).toBe(true);
    expect(plan.outstanding).toBe(0);
    expect(plan.change).toBe(0);
  });

  it('rejects zero and negative tenders', () => {
    expect(planPayments(m(100), [{ method: 'cash', amount: m(0) }]).valid).toBe(false);
  });
});

describe('payment status classification', () => {
  it('never marks an unconfirmed authorisation as successful', () => {
    expect(
      classifyPaymentStatus({ method: 'card', requiresAuthorization: true, isOnline: false, providerReference: null }),
    ).toBe('pending');
  });

  it('marks a provider-confirmed payment successful', () => {
    expect(
      classifyPaymentStatus({ method: 'card', requiresAuthorization: true, isOnline: true, providerReference: 'RRN-1' }),
    ).toBe('successful');
  });

  it('marks cash successful with no authorisation at all', () => {
    expect(
      classifyPaymentStatus({ method: 'cash', requiresAuthorization: false, isOnline: false, providerReference: null }),
    ).toBe('successful');
  });
});

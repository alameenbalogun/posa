/**
 * Pricing, discount and tax engine (PRD §11, §18).
 *
 * This is the most correctness-critical code in POSA: it decides what the
 * customer pays, what the tax authority is owed, and what the business earned.
 * It is a pure function of (cart, configuration) with no I/O, so it can be
 * exhaustively tested and can run in the sync reconciler as well as the till.
 *
 * ORDER OF OPERATIONS (fixed, and mirrored server-side — this order is a
 * business rule, not an implementation detail):
 *
 *   1. gross      = unitPrice x quantity                (integer kobo)
 *   2. lineNet    = gross - lineDiscount                (clamped to >= 0)
 *   3. cartShare  = cartDiscount distributed by lineNet (largest remainder)
 *   4. base       = lineNet - cartShare
 *   5. tax        = extracted from, or added to, base
 *   6. lineTotal  = base + tax      [tax-exclusive]
 *                   base            [tax-inclusive]
 *
 * Discounts therefore reduce the TAXABLE BASE, which is what tax law requires.
 * Discounting after tax would under-declare VAT — a real compliance bug.
 */

import {
  add,
  clamp,
  distribute,
  isZero,
  percentOf,
  scale,
  sub,
  sum,
  ZERO,
  type Minor,
} from './money';
import type { CurrencyCode } from './types';

/* ------------------------------------------------------------------ */
/* Discounts                                                           */
/* ------------------------------------------------------------------ */

export type DiscountSpec =
  | { kind: 'none' }
  | { kind: 'percent'; basisPoints: number; label?: string; approvedBy?: string | null }
  | { kind: 'fixed'; amount: Minor; label?: string; approvedBy?: string | null };

export const NO_DISCOUNT: DiscountSpec = { kind: 'none' };

/** Basis points (1/100th of a percent) keep discount config integer-safe. */
export function percentDiscount(basisPoints: number, label?: string): DiscountSpec {
  return { kind: 'percent', basisPoints: Math.max(0, Math.round(basisPoints)), label };
}

export function fixedDiscount(amount: Minor, label?: string): DiscountSpec {
  return { kind: 'fixed', amount, label };
}

/** Resolve a discount spec into an absolute amount against a base. */
export function resolveDiscount(spec: DiscountSpec | undefined, base: Minor): Minor {
  if (!spec || spec.kind === 'none' || base <= 0) return ZERO;
  if (spec.kind === 'percent') {
    const raw = percentOf(base, spec.basisPoints / 100);
    // A line can never go below zero — that would be a payout, not a discount.
    return clamp(raw, ZERO, base);
  }
  return clamp(spec.amount, ZERO, base);
}

/** The discount expressed as basis points of the base — used for approval rules. */
export function discountBasisPoints(spec: DiscountSpec | undefined, base: Minor): number {
  if (!spec || spec.kind === 'none' || base <= 0) return 0;
  if (spec.kind === 'percent') return spec.basisPoints;
  return Math.round((spec.amount / base) * 10000);
}

export function describeDiscount(spec: DiscountSpec | undefined): string | null {
  if (!spec || spec.kind === 'none') return null;
  if (spec.kind === 'percent') return `${(spec.basisPoints / 100).toFixed(spec.basisPoints % 100 === 0 ? 0 : 2)}%`;
  return 'Fixed amount';
}

/* ------------------------------------------------------------------ */
/* Tax                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Extract the tax already contained in a tax-inclusive amount.
 *
 * We deliberately compute `tax = gross - net` (rather than rounding the tax
 * directly) so that `net + tax === gross` holds exactly, in integers, for every
 * rate. Receipts that don't add up are the fastest way to lose a customer's
 * trust at the counter.
 *
 * @param amount tax-inclusive amount
 * @param rateBasisPoints e.g. 750 = 7.5% VAT
 */
export function extractInclusiveTax(amount: Minor, rateBasisPoints: number): { net: Minor; tax: Minor } {
  if (rateBasisPoints <= 0 || amount === 0) return { net: amount, tax: ZERO };
  const divisor = 1 + rateBasisPoints / 10000;
  const rawNet = amount / divisor;
  const net = Math.round(rawNet + Math.sign(rawNet) * Number.EPSILON * Math.abs(rawNet)) as Minor;
  return { net, tax: sub(amount, net) };
}

/** Add tax on top of a tax-exclusive amount. */
export function addExclusiveTax(amount: Minor, rateBasisPoints: number): Minor {
  return percentOf(amount, rateBasisPoints / 100);
}

/* ------------------------------------------------------------------ */
/* Rounding                                                            */
/* ------------------------------------------------------------------ */

export interface RoundingConfig {
  /** Cash rounding increment in minor units. 0 disables. Nigeria uses 0. */
  cashRoundingTo: number;
  /**
   * 'nearest' | 'up' | 'down'. Shops that never want to shortchange the
   * customer choose 'up'.
   */
  cashRoundingMode: 'nearest' | 'up' | 'down';
}

export const NO_ROUNDING: RoundingConfig = { cashRoundingTo: 0, cashRoundingMode: 'nearest' };

export function applyCashRounding(value: Minor, config: RoundingConfig): Minor {
  const step = config.cashRoundingTo;
  if (step <= 1) return value;
  const negative = value < 0;
  const magnitude = Math.abs(value);
  let rounded: number;
  switch (config.cashRoundingMode) {
    case 'up':
      rounded = Math.ceil(magnitude / step) * step;
      break;
    case 'down':
      rounded = Math.floor(magnitude / step) * step;
      break;
    default:
      rounded = Math.round(magnitude / step) * step;
  }
  return (negative ? -rounded : rounded) as Minor;
}

/* ------------------------------------------------------------------ */
/* Cart shapes the engine prices                                       */
/* ------------------------------------------------------------------ */

export interface PriceableLine {
  id: string;
  productId: string;
  variantId: string | null;
  name: string;
  sku: string;
  barcode: string | null;
  /** Fractional for weighed goods (0.75 kg of rice). */
  quantity: number;
  /** Already resolved: branch override, promotional price or base price. */
  unitPrice: Minor;
  unitCost: Minor;
  taxRateBasisPoints: number;
  discount?: DiscountSpec;
}

export interface PricedLine extends PriceableLine {
  /** unitPrice x quantity, before any discount. */
  gross: Minor;
  lineDiscount: Minor;
  cartDiscountShare: Minor;
  /** Taxable base after all discounts. */
  taxableBase: Minor;
  taxAmount: Minor;
  /** What this line contributes to the sale total. */
  lineTotal: Minor;
  /** Effective per-unit price after all discounts — what a return refunds. */
  effectiveUnitPrice: Minor;
  discountBasisPoints: number;
}

export interface PricingTotals {
  subtotal: Minor;
  lineDiscountTotal: Minor;
  cartDiscountTotal: Minor;
  discountTotal: Minor;
  taxableTotal: Minor;
  taxTotal: Minor;
  /** Rounding delta applied to reach a cash-friendly total. */
  roundingAdjustment: Minor;
  /** Sum of line totals, before cash rounding. */
  totalBeforeRounding: Minor;
  /** What the customer actually owes. */
  total: Minor;
  itemCount: number;
  /** Tax broken down by rate, for compliant receipts (VAT schedule). */
  taxByRate: Array<{ rateBasisPoints: number; taxableBase: Minor; taxAmount: Minor }>;
}

export interface PricingConfig {
  currency: CurrencyCode;
  /** When true, catalog prices already include tax. */
  taxInclusive: boolean;
  rounding: RoundingConfig;
}

export interface PricedCart {
  lines: PricedLine[];
  totals: PricingTotals;
}

export interface PriceCartInput {
  lines: readonly PriceableLine[];
  cartDiscount?: DiscountSpec;
  config: PricingConfig;
}

/**
 * Price a cart. Deterministic: identical inputs on two devices — one online,
 * one offline for three days — produce byte-identical totals.
 */
export function priceCart(input: PriceCartInput): PricedCart {
  const { lines, cartDiscount = NO_DISCOUNT, config } = input;

  // --- Pass 1: gross and line-level discounts -----------------------------
  const grosses: Minor[] = [];
  const lineDiscounts: Minor[] = [];

  for (const line of lines) {
    const gross = scale(line.unitPrice, line.quantity);
    grosses.push(gross);
    lineDiscounts.push(resolveDiscount(line.discount, gross));
  }

  const subtotal = sum(grosses);
  const lineDiscountTotal = sum(lineDiscounts);

  // --- Pass 2: allocate the cart discount across lines --------------------
  const nets: Minor[] = lines.map((_, i) => sub(grosses[i], lineDiscounts[i]));
  const netTotal = sum(nets);

  // Guard against a cart-level discount that exceeds the order (would create a
  // negative taxable base, i.e. free money).
  const cartDiscountResolved = resolveDiscount(cartDiscount, netTotal);
  const cartShares = distribute(cartDiscountResolved, nets);
  const cartDiscountTotal = sum(cartShares);

  // --- Pass 3: tax and totals --------------------------------------------
  const pricedLines: PricedLine[] = [];
  const rateBuckets = new Map<number, { taxableBase: Minor; taxAmount: Minor }>();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const net = nets[i];
    const cartShare = cartShares[i];
    const baseBeforeTax = clamp(sub(net, cartShare), ZERO, net);

    let taxableBase: Minor;
    let taxAmount: Minor;
    let lineTotal: Minor;

    if (config.taxInclusive) {
      const split = extractInclusiveTax(baseBeforeTax, line.taxRateBasisPoints);
      taxableBase = split.net;
      taxAmount = split.tax;
      lineTotal = add(taxableBase, taxAmount); // === baseBeforeTax, by construction
    } else {
      taxableBase = baseBeforeTax;
      taxAmount = addExclusiveTax(baseBeforeTax, line.taxRateBasisPoints);
      lineTotal = add(taxableBase, taxAmount);
    }

    const bucket = rateBuckets.get(line.taxRateBasisPoints) ?? { taxableBase: ZERO, taxAmount: ZERO };
    bucket.taxableBase = add(bucket.taxableBase, taxableBase);
    bucket.taxAmount = add(bucket.taxAmount, taxAmount);
    rateBuckets.set(line.taxRateBasisPoints, bucket);

    const totalDiscount = add(lineDiscounts[i], cartShare);
    const effectiveUnitPrice =
      line.quantity > 0 ? (scale(sub(grosses[i], totalDiscount), 1 / line.quantity) as Minor) : line.unitPrice;

    pricedLines.push({
      ...line,
      gross: grosses[i],
      lineDiscount: lineDiscounts[i],
      cartDiscountShare: cartShare,
      taxableBase,
      taxAmount,
      lineTotal,
      effectiveUnitPrice,
      discountBasisPoints: discountBasisPoints(line.discount, grosses[i]),
    });
  }

  const lineTotals = pricedLines.map((l) => l.lineTotal);
  const totalBeforeRounding = sum(lineTotals);
  const total = applyCashRounding(totalBeforeRounding, config.rounding);

  const taxByRate = [...rateBuckets.entries()]
    .map(([rateBasisPoints, bucket]) => ({ rateBasisPoints, ...bucket }))
    .sort((a, b) => a.rateBasisPoints - b.rateBasisPoints);

  return {
    lines: pricedLines,
    totals: {
      subtotal,
      lineDiscountTotal,
      cartDiscountTotal,
      discountTotal: add(lineDiscountTotal, cartDiscountTotal),
      taxableTotal: sum(pricedLines.map((l) => l.taxableBase)),
      taxTotal: sum(pricedLines.map((l) => l.taxAmount)),
      roundingAdjustment: sub(total, totalBeforeRounding),
      totalBeforeRounding,
      total,
      itemCount: pricedLines.reduce((count, l) => count + l.quantity, 0),
      taxByRate,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Payments                                                            */
/* ------------------------------------------------------------------ */

export interface PaymentIntent {
  method: string;
  amount: Minor;
  reference?: string | null;
  requiresAuthorization?: boolean;
}

export interface PaymentPlanResult {
  valid: boolean;
  errors: string[];
  /** Amount still unpaid after applying the tenders. */
  outstanding: Minor;
  /** Overpayment when the tender is cash (change due) or card (refund risk). */
  change: Minor;
  /** Cash tendered above the total that would need a refund, not change. */
  overpayOnNonCash: Minor;
}

/**
 * Validate a split-payment plan (PRD §11, §12).
 *
 * Two rules matter here:
 *  - Cash may exceed the total; the excess is change.
 *  - A card/digital tender that exceeds the total is NOT change. You cannot give
 *    change on a card without a reversing transaction, so we flag it instead of
 *    silently accepting it.
 */
export function planPayments(total: Minor, intents: readonly PaymentIntent[]): PaymentPlanResult {
  const errors: string[] = [];
  let allocated = ZERO;
  let cashAllocated = ZERO;
  let nonCashOverpay = ZERO;

  for (const intent of intents) {
    if (intent.amount <= 0) {
      errors.push('Payment amounts must be greater than zero.');
      continue;
    }
    allocated = add(allocated, intent.amount);
    if (intent.method === 'cash') {
      cashAllocated = add(cashAllocated, intent.amount);
    }
  }

  const outstanding = sub(total, allocated);
  let change = ZERO;

  if (outstanding <= 0) {
    change = Math.abs(outstanding) as Minor;
    // Change can only be handed back from cash actually received.
    if (change > cashAllocated) {
      nonCashOverpay = sub(change, cashAllocated);
      errors.push('A non-cash tender cannot exceed the sale total.');
    }
    if (total > 0 && cashAllocated === 0 && change > 0) {
      errors.push('Change due but no cash was tendered.');
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, outstanding: outstanding > 0 ? outstanding : ZERO, change: ZERO, overpayOnNonCash: nonCashOverpay };
  }

  return {
    valid: true,
    errors,
    outstanding: outstanding > 0 ? outstanding : ZERO,
    change,
    overpayOnNonCash: ZERO,
  };
}

/**
 * Classify a sale's payment status.
 *
 * CRITICAL (PRD §12, §47): an offline terminal must never mark a card or wallet
 * payment as successful just because it cannot reach the provider. Those stay
 * `pending` until a provider reference confirms them.
 */
export function classifyPaymentStatus(params: {
  method: string;
  requiresAuthorization: boolean;
  isOnline: boolean;
  providerReference: string | null;
}): 'successful' | 'pending' | 'failed' {
  const { requiresAuthorization, providerReference } = params;
  if (!requiresAuthorization) return 'successful';
  if (providerReference) return 'successful';
  return 'pending';
}

/** Gross profit for a sale, using the cost snapshot captured at sale time. */
export function grossProfit(lines: readonly PricedLine[]): Minor {
  const revenue = sum(lines.map((l) => l.lineTotal));
  const cost = sum(lines.map((l) => scale(l.unitCost, l.quantity)));
  return sub(revenue, cost);
}

/** Average order value across a set of sale totals. */
export function averageOrderValue(totals: readonly Minor[]): Minor {
  if (totals.length === 0) return ZERO;
  return Math.round(sum(totals) / totals.length) as Minor;
}

export function isFreeCart(cart: PricedCart): boolean {
  return isZero(cart.totals.total);
}

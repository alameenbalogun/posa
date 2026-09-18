/**
 * Money handling.
 *
 * RULE (non-negotiable, PRD §35 "protect financial integrity"):
 * every monetary value in POSA is an INTEGER in the currency's minor unit
 * (kobo for NGN, cents for USD). Floating point money is a bug waiting to
 * happen at 3am in a busy store.
 *
 * This module owns:
 *  - the `Money` shape (integer minor + currency),
 *  - safe arithmetic with explicit rounding,
 *  - percentage maths that cannot drift,
 *  - display formatting.
 */

export type CurrencyCode = string; // ISO-4217, e.g. "NGN"

export interface Currency {
  code: CurrencyCode;
  symbol: string;
  /** Number of decimal places in the minor unit. NGN = 2 (kobo). */
  exponent: number;
  /** Where the symbol sits relative to the amount. */
  symbolPosition: 'prefix' | 'suffix';
}

export const NGN: Currency = { code: 'NGN', symbol: '\u20a6', exponent: 2, symbolPosition: 'prefix' };
export const USD: Currency = { code: 'USD', symbol: '$', exponent: 2, symbolPosition: 'prefix' };
export const GBP: Currency = { code: 'GBP', symbol: '\u00a3', exponent: 2, symbolPosition: 'prefix' };
export const GHS: Currency = { code: 'GHS', symbol: 'GH\u20b5', exponent: 2, symbolPosition: 'prefix' };
export const KES: Currency = { code: 'KES', symbol: 'KSh', exponent: 2, symbolPosition: 'suffix' };
export const XOF: Currency = { code: 'XOF', symbol: 'CFA', exponent: 0, symbolPosition: 'suffix' };
export const JPY: Currency = { code: 'JPY', symbol: '\u00a5', exponent: 0, symbolPosition: 'prefix' };

export const CURRENCIES: Record<CurrencyCode, Currency> = {
  NGN,
  USD,
  GBP,
  GHS,
  KES,
  XOF,
  JPY,
};

const FALLBACK: Currency = NGN;

export function currencyOf(code: CurrencyCode | undefined): Currency {
  if (!code) return FALLBACK;
  return CURRENCIES[code.toUpperCase()] ?? { ...FALLBACK, code: code.toUpperCase() };
}

/** An integer amount of minor units. Brand it so raw numbers can't sneak in. */
export type Minor = number & { readonly __minor?: unique symbol };

export const ZERO = 0 as Minor;

export function minor(value: number): Minor {
  return Math.round(value) as Minor;
}

/** Convert a major-unit amount (what a human types: 1500.50) to minor units. */
export function fromMajor(major: number, currency: CurrencyCode = 'NGN'): Minor {
  const exp = currencyOf(currency).exponent;
  // Use string-free scaling with a corrective epsilon to defeat 1.005 -> 1.00.
  const scaled = major * 10 ** exp;
  return Math.round(scaled + Math.sign(scaled) * Number.EPSILON * Math.abs(scaled)) as Minor;
}

/** Convert minor units back to a major-unit number (for display maths only). */
export function toMajor(value: Minor, currency: CurrencyCode = 'NGN'): number {
  return value / 10 ** currencyOf(currency).exponent;
}

/**
 * Multiply a money amount by a rational factor and round half-away-from-zero.
 * This is the ONLY sanctioned way to scale money.
 */
export function scale(value: Minor, factor: number): Minor {
  const raw = value * factor;
  return Math.round(raw + Math.sign(raw) * Number.EPSILON * Math.abs(raw)) as Minor;
}

/** Apply a percentage (0-100, may be fractional) to a money amount. */
export function percentOf(value: Minor, percent: number): Minor {
  return scale(value, percent / 100);
}

export function add(...values: Minor[]): Minor {
  return values.reduce<number>((sum, v) => sum + v, 0) as Minor;
}

export function sub(a: Minor, b: Minor): Minor {
  return (a - b) as Minor;
}

export function abs(value: Minor): Minor {
  return Math.abs(value) as Minor;
}

/** Clamp a value into [min, max]. Used to stop discounts exceeding a line total. */
export function clamp(value: Minor, min: Minor, max: Minor): Minor {
  return Math.min(Math.max(value, min), max) as Minor;
}

export function isZero(value: Minor): boolean {
  return value === 0;
}

export function isNegative(value: Minor): boolean {
  return value < 0;
}

/**
 * Distribute a total across weighted parts without losing or inventing a cent.
 *
 * The classic POS bug: a ₦100 cart discount spread over 3 lines gives
 * 33.33 / 33.33 / 33.33 and the receipt stops adding up. We use the
 * largest-remainder method so the parts always sum back to exactly `total`,
 * and the leftover kobo land on the biggest lines.
 */
export function distribute(total: Minor, weights: number[]): Minor[] {
  const count = weights.length;
  if (count === 0) return [];
  const positive = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const weightSum = positive.reduce((s, w) => s + w, 0);

  // Degenerate case: no weights (all zero-value lines) — split as evenly as possible.
  if (weightSum <= 0) {
    const base = Math.floor(total / count);
    const out = new Array<Minor>(count).fill(base as Minor);
    for (let i = 0; i < total - base * count; i += 1) out[i] = (out[i] + 1) as Minor;
    return out;
  }

  const exact = positive.map((w) => (total * w) / weightSum);
  const floored = exact.map((v) => Math.floor(v));
  let remainder = total - floored.reduce((s, v) => s + v, 0);

  // Order indices by fractional part desc, then by weight desc, then by index
  // — fully deterministic so two devices compute identical receipts.
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value), weight: positive[index] }))
    .sort((a, b) => b.fraction - a.fraction || b.weight - a.weight || a.index - b.index);

  const result = floored.map((v) => v as Minor);
  let cursor = 0;
  while (remainder > 0 && order.length > 0) {
    result[order[cursor % order.length].index] += 1 as Minor;
    remainder -= 1;
    cursor += 1;
  }
  // Negative totals (refunds) carry a negative remainder: pull from the smallest.
  while (remainder < 0 && order.length > 0) {
    result[order[order.length - 1 - (cursor % order.length)].index] -= 1 as Minor;
    remainder += 1;
    cursor += 1;
  }
  return result;
}

export interface FormatOptions {
  currency?: CurrencyCode;
  /** Hide the symbol (useful in tight table columns). */
  bare?: boolean;
  /** Always render a + or - sign. */
  signed?: boolean;
  /** Render the smallest unit, e.g. ₦1,500.00 -> ₦1,500 */
  compact?: boolean;
  locale?: string;
}

export function formatMoney(value: Minor, options: FormatOptions = {}): string {
  const currency = currencyOf(options.currency);
  const negative = value < 0;
  const magnitude = Math.abs(value);
  const major = magnitude / 10 ** currency.exponent;

  const digits = options.compact && magnitude % 10 ** currency.exponent === 0 ? 0 : currency.exponent;

  const body = major.toLocaleString('en-NG', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

  if (options.bare) {
    return `${negative ? '-' : options.signed ? '+' : ''}${body}`;
  }
  const signed = negative ? '-' : options.signed ? '+' : '';
  return currency.symbolPosition === 'prefix'
    ? `${signed}${currency.symbol}${body}`
    : `${signed}${body}\u00a0${currency.symbol}`;
}

/**
 * Parse a human-typed amount ("1,500.50", "1500", "₦2,000") into minor units.
 * Returns null when the input isn't a number, so callers can show a validation
 * error rather than silently booking ₦0 (PRD §37, "clear error messages").
 */
export function parseMoney(input: string, currency: CurrencyCode = 'NGN'): Minor | null {
  if (typeof input !== 'string') return null;
  const cleaned = input.replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return fromMajor(parsed, currency);
}

/** Sum a collection of amounts (quantities, totals) as integer minor units. */
export function sum(values: readonly Minor[]): Minor {
  return values.reduce<number>((s, v) => s + v, 0) as Minor;
}

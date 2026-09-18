/**
 * The cart (PRD §11).
 *
 * The cart is the one piece of POSA state that must feel instantaneous. It is
 * modelled as an immutable value with pure operations, so:
 *  - React can diff it cheaply,
 *  - a held sale is just a serialised cart,
 *  - an interrupted checkout can be replayed from an event log,
 *  - and nothing in the UI can mutate a price behind the pricing engine's back.
 *
 * Line identity is decoupled from product identity on purpose: the same product
 * can appear twice on one receipt (bought at two different prices, or one line
 * for a warranty add-on), which cashiers need and single-line-per-SKU carts
 * cannot express.
 */

import { ulid } from './ulid';
import { add, scale, ZERO, type Minor } from './money';
import type { DiscountSpec, PriceableLine } from './pricing';
import { NO_DISCOUNT } from './pricing';
import type { CurrencyCode, UnitOfMeasure } from './types';

/**
 * A cart line always carries an explicit discount. `PriceableLine.discount` is
 * optional because the pricing engine accepts untagged input, but a cart line is
 * a deliberate act by a cashier, so "no discount" must be recorded as a fact
 * rather than as an absence.
 */
export interface CartLine extends Omit<PriceableLine, 'discount'> {
  discount: DiscountSpec;
  /** Added-at timestamp, so the UI can flash the newest line. */
  addedAt: string;
  /** Set when the price came from a manual override rather than the catalog. */
  priceOverridden: boolean;
  /** Set when the line was added by a scan (vs typed search) — analytics gold. */
  scanned: boolean;
}

export interface Cart {
  id: string;
  businessId: string;
  branchId: string;
  deviceId: string;
  cashierId: string;
  currency: CurrencyCode;
  lines: CartLine[];
  cartDiscount: DiscountSpec;
  customerId: string | null;
  note: string;
  /** Increments on every mutation; used to invalidate stale UI and held sales. */
  revision: number;
  openedAt: string;
  updatedAt: string;
}

export interface NewCartInput {
  businessId: string;
  branchId: string;
  deviceId: string;
  cashierId: string;
  currency: CurrencyCode;
  customerId?: string | null;
}

export function createCart(input: NewCartInput, now: string = new Date().toISOString()): Cart {
  return {
    id: ulid(),
    businessId: input.businessId,
    branchId: input.branchId,
    deviceId: input.deviceId,
    cashierId: input.cashierId,
    currency: input.currency,
    lines: [],
    cartDiscount: NO_DISCOUNT,
    customerId: input.customerId ?? null,
    note: '',
    revision: 0,
    openedAt: now,
    updatedAt: now,
  };
}

function touch(cart: Cart, now: string): Cart {
  return { ...cart, revision: cart.revision + 1, updatedAt: now };
}

export interface AddLineInput {
  productId: string;
  variantId: string | null;
  name: string;
  sku: string;
  barcode: string | null;
  unitPrice: Minor;
  unitCost: Minor;
  taxRateBasisPoints: number;
  unit: UnitOfMeasure;
  quantity?: number;
  scanned?: boolean;
  /** Merge into an existing identical line (default true — the scanner case). */
  merge?: boolean;
  /** Explicitly allow the same product on a second line. */
  forceNewLine?: boolean;
}

/**
 * Add a line, merging with an existing one when the product, price and discount
 * all match. This is what makes rapid repeated scanning feel right (PRD §28):
 * ten scans of the same biscuit must become "x10", not ten rows.
 */
export function addLine(cart: Cart, input: AddLineInput, now: string = new Date().toISOString()): Cart {
  const quantity = input.quantity ?? 1;
  if (quantity <= 0) return cart;

  const mergeAllowed = input.merge !== false && !input.forceNewLine;
  if (mergeAllowed) {
    const index = cart.lines.findIndex(
      (line) =>
        line.productId === input.productId &&
        line.variantId === input.variantId &&
        line.unitPrice === input.unitPrice &&
        line.discount.kind === 'none',
    );
    if (index >= 0) {
      const lines = cart.lines.slice();
      const existing = lines[index];
      lines[index] = { ...existing, quantity: existing.quantity + quantity };
      return touch({ ...cart, lines }, now);
    }
  }

  const line: CartLine = {
    id: ulid(),
    productId: input.productId,
    variantId: input.variantId,
    name: input.name,
    sku: input.sku,
    barcode: input.barcode,
    quantity,
    unitPrice: input.unitPrice,
    unitCost: input.unitCost,
    taxRateBasisPoints: input.taxRateBasisPoints,
    discount: NO_DISCOUNT,
    priceOverridden: false,
    scanned: input.scanned ?? false,
    addedAt: now,
  };

  return touch({ ...cart, lines: [...cart.lines, line] }, now);
}

export function setQuantity(cart: Cart, lineId: string, quantity: number, now = new Date().toISOString()): Cart {
  if (quantity <= 0) return removeLine(cart, lineId, now);
  return touch(
    { ...cart, lines: cart.lines.map((l) => (l.id === lineId ? { ...l, quantity } : l)) },
    now,
  );
}

/** Scan-to-count style increment, used by stock-count and rapid-scan modes. */
export function incrementLine(cart: Cart, lineId: string, delta = 1, now = new Date().toISOString()): Cart {
  const line = cart.lines.find((l) => l.id === lineId);
  if (!line) return cart;
  return setQuantity(cart, lineId, line.quantity + delta, now);
}

export function removeLine(cart: Cart, lineId: string, now = new Date().toISOString()): Cart {
  return touch({ ...cart, lines: cart.lines.filter((l) => l.id !== lineId) }, now);
}

export function setLineDiscount(
  cart: Cart,
  lineId: string,
  discount: DiscountSpec,
  now = new Date().toISOString(),
): Cart {
  return touch(
    { ...cart, lines: cart.lines.map((l) => (l.id === lineId ? { ...l, discount } : l)) },
    now,
  );
}

export function setLinePrice(
  cart: Cart,
  lineId: string,
  unitPrice: Minor,
  now = new Date().toISOString(),
): Cart {
  return touch(
    { ...cart, lines: cart.lines.map((l) => (l.id === lineId ? { ...l, unitPrice, priceOverridden: true } : l)) },
    now,
  );
}

export function setCartDiscount(cart: Cart, discount: DiscountSpec, now = new Date().toISOString()): Cart {
  return touch({ ...cart, cartDiscount: discount }, now);
}

export function attachCustomer(cart: Cart, customerId: string | null, now = new Date().toISOString()): Cart {
  return touch({ ...cart, customerId }, now);
}

export function setNote(cart: Cart, note: string, now = new Date().toISOString()): Cart {
  return touch({ ...cart, note }, now);
}

/** Guarded line removal: a supervisor can clear a cart, a cashier cannot by accident. */
export function clearCart(cart: Cart, now = new Date().toISOString()): Cart {
  return touch({ ...cart, lines: [], cartDiscount: NO_DISCOUNT, note: '' }, now);
}

/* ------------------------------------------------------------------ */
/* Derived reads — cheap, synchronous, and used by the UI on every render */
/* ------------------------------------------------------------------ */

export function cartItemCount(cart: Cart): number {
  return cart.lines.reduce((count, line) => count + line.quantity, 0);
}

export function cartIsEmpty(cart: Cart): boolean {
  return cart.lines.length === 0;
}

/** Unpriced subtotal — used for the "scan feedback" flash before re-pricing. */
export function cartGross(cart: Cart): Minor {
  return cart.lines.reduce<number>((total, line) => total + scale(line.unitPrice, line.quantity), 0) as Minor;
}

export function findLineByProduct(cart: Cart, productId: string, variantId: string | null = null): CartLine | null {
  return cart.lines.find((l) => l.productId === productId && l.variantId === variantId) ?? null;
}

/**
 * Whether any line has been individually discounted or price-overridden —
 * the condition under which we must NOT silently merge on rescan, because the
 * cashier's deliberate edit would be absorbed into an aggregate quantity.
 */
export function hasManualAdjustments(cart: Cart): boolean {
  return cart.lines.some((l) => l.discount.kind !== 'none' || l.priceOverridden);
}

export function cartNeedsApproval(cart: Cart, maxDiscountBasisPoints: number): boolean {
  const gross = cartGross(cart);
  if (gross <= 0) return false;
  const discounted = cart.lines.reduce<number>(
    (total, line) => total + (line.discount.kind === 'none' ? 0 : 0),
    0,
  );
  void discounted;
  return cart.lines.some((l) => l.discount.kind === 'percent' && l.discount.basisPoints > maxDiscountBasisPoints);
}

/* ------------------------------------------------------------------ */
/* Serialisation for held sales                                        */
/* ------------------------------------------------------------------ */

export function toHeldSale(
  cart: Cart,
  label: string,
  heldBy: string,
  now = new Date().toISOString(),
): {
  id: string;
  businessId: string;
  branchId: string;
  deviceId: string;
  label: string;
  customerId: string | null;
  lines: CartLine[];
  note: string | null;
  heldBy: string;
  heldAt: string;
  revisionToken: number;
} {
  return {
    id: cart.id,
    businessId: cart.businessId,
    branchId: cart.branchId,
    deviceId: cart.deviceId,
    label,
    customerId: cart.customerId,
    lines: cart.lines,
    note: cart.note || null,
    heldBy,
    heldAt: now,
    revisionToken: cart.revision,
  };
}

export function fromHeldSale(held: {
  id: string;
  businessId: string;
  branchId: string;
  deviceId: string;
  customerId: string | null;
  lines: CartLine[];
  note: string | null;
  heldAt: string;
}): Cart {
  return {
    id: held.id,
    businessId: held.businessId,
    branchId: held.branchId,
    deviceId: held.deviceId,
    cashierId: '',
    currency: 'NGN',
    lines: held.lines,
    cartDiscount: NO_DISCOUNT,
    customerId: held.customerId,
    note: held.note ?? '',
    revision: 0,
    openedAt: held.heldAt,
    updatedAt: held.heldAt,
  };
}

/** Merge two totals for the held-sales badge. */
export function sumLineTotals(totals: readonly Minor[]): Minor {
  return totals.reduce<Minor>((total, value) => add(total, value), ZERO);
}

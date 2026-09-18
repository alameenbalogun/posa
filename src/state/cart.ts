/**
 * The cart store — the beating heart of the till.
 *
 * It owns the live cart, the priced view of it, the payment drafts, and the
 * commit. Everything a cashier does flows through here, and every operation is
 * synchronous from the UI's point of view except the commit itself.
 *
 * Two decisions worth noting:
 *
 * 1. PRICING IS DERIVED, NEVER STORED. `priced` is recomputed from `cart` on
 *    every mutation by the pure pricing engine. There is exactly one source of
 *    truth for what the customer owes, and it is the same function the server
 *    would run.
 *
 * 2. A SCAN RESOLVES FROM MEMORY FIRST. The barcode index lives in process
 *    memory, so `addScannedItem` is a Map lookup — no await before the line
 *    appears. The async path only engages for a code we have never seen, which
 *    is the rare case (PRD §39 "cart addition should feel immediate").
 */

import { create } from 'zustand';
import type { Minor } from '@/domain/money';
import type { BarcodeIndexEntry, Product } from '@/domain/types';
import {
  addLine,
  attachCustomer,
  clearCart,
  createCart,
  fromHeldSale,
  removeLine,
  setCartDiscount,
  setLineDiscount,
  setLinePrice,
  setQuantity,
  toHeldSale,
  type Cart,
} from '@/domain/cart';
import {
  NO_DISCOUNT,
  planPayments,
  priceCart,
  type DiscountSpec,
  type PaymentPlanResult,
  type PricedCart,
  type PricingConfig,
} from '@/domain/pricing';
import { buildCommittedSale, deviceCodeFromId, type PaymentDraft } from '@/domain/sale';
import { normaliseScan } from '@/domain/barcode';
import { META_KEYS } from '@/data/local';
import { useApp } from './app';
import type { ScanFeedback, ScanPhase } from '@/ui/patterns';

export interface CartPaymentDraft extends PaymentDraft {
  /** Local-only id so the UI can key and remove draft rows. */
  draftId: string;
}

interface CartState {
  cart: Cart | null;
  priced: PricedCart | null;
  paymentDrafts: CartPaymentDraft[];
  holdLabel: string;
  /** Set while the commit is in flight, to prevent a double-tap creating two sales. */
  committing: boolean;
  /** Most recent completed sale, for the receipt screen. */
  lastReceipt: { saleId: string; receiptNumber: string; total: Minor } | null;

  beginSale: () => void;
  discardSale: () => void;
  addProduct: (product: Product | BarcodeIndexEntry, quantity?: number, scanned?: boolean) => void;
  scanBarcode: (raw: string, source?: 'hid' | 'camera' | 'manual') => Promise<ScanFeedback>;
  addUnknownBarcode: (barcode: string, product: Product) => Promise<void>;
  setQuantity: (lineId: string, quantity: number) => void;
  removeLine: (lineId: string) => void;
  setLineDiscount: (lineId: string, discount: DiscountSpec) => void;
  setLinePrice: (lineId: string, price: Minor) => void;
  setCartDiscount: (discount: DiscountSpec) => void;
  setCustomer: (customerId: string | null) => void;
  setNote: (note: string) => void;
  addPayment: (draft: Omit<CartPaymentDraft, 'draftId'>) => void;
  removePayment: (draftId: string) => void;
  clearPayments: () => void;
  holdSale: (label: string) => Promise<void>;
  resumeHeld: (id: string) => Promise<boolean>;
  plan: () => PaymentPlanResult | null;
  completeSale: () => Promise<{ ok: boolean; receiptNumber: string | null; error: string | null; warnings: string[] }>;
}

function pricingConfig(): PricingConfig {
  const business = useApp.getState().business;
  return {
    currency: business?.settings.currency ?? 'NGN',
    taxInclusive: business?.settings.taxInclusive ?? true,
    // Nigerian cash transactions do not round, but the engine supports markets
    // that do (e.g. rounding to 5 kobo), so the config is read, not hard-coded.
    rounding: { cashRoundingTo: 0, cashRoundingMode: 'nearest' },
  };
}

/** Recompute the priced view whenever the cart changes. */
function reprice(cart: Cart | null): PricedCart | null {
  if (!cart) return null;
  return priceCart({ lines: cart.lines, cartDiscount: cart.cartDiscount, config: pricingConfig() });
}

let draftCounter = 0;

export const useCart = create<CartState>()((set, get) => ({
  cart: null,
  priced: null,
  paymentDrafts: [],
  holdLabel: '',
  committing: false,
  lastReceipt: null,

  beginSale() {
    const app = useApp.getState();
    if (!app.business || !app.branch || !app.device || !app.session) return;
    if (get().cart) return;
    const cart = createCart({
      businessId: app.business.id,
      branchId: app.branch.id,
      deviceId: app.device.id,
      cashierId: app.session.userId,
      currency: app.business.settings.currency,
    });
    set({ cart, priced: reprice(cart) });
  },

  discardSale() {
    set({ cart: null, priced: null, paymentDrafts: [], holdLabel: '' });
  },

  addProduct(product, quantity = 1, scanned = false) {
    const cart = get().cart ?? (beginAndReturn(), get().cart);
    if (!cart) return;
    const entry = toIndexShape(product);
    const next = addLine(
      cart,
      {
        productId: entry.productId,
        variantId: entry.variantId,
        name: entry.name,
        sku: entry.sku,
        barcode: entry.barcode,
        unitPrice: entry.price,
        unitCost: entry.costPrice,
        taxRateBasisPoints: entry.taxRateBasisPoints,
        unit: entry.unit,
        quantity,
        scanned,
      },
    );
    set({ cart: next, priced: reprice(next) });
  },

  /**
   * The scan path. Resolves from the in-memory index first so the common case has
   * no await before the cart updates; only an unseen code touches storage.
   */
  async scanBarcode(raw, source = 'hid') {
    const app = useApp.getState();
    if (!app.data || !app.branch) {
      return feedback('error', 'Terminal not ready', raw);
    }
    if (!get().cart) get().beginSale();

    const code = normaliseScan(raw);
    if (!code) return feedback('error', 'Empty scan', null);

    const cached = app.data.peekBarcode(code);
    if (cached) {
      if (cached.status !== 'active') {
        return feedback('blocked', `${cached.productName} cannot be sold`, code);
      }
      get().addProduct(cached, 1, true);
      return feedback('success', cached.productName, code);
    }

    const resolved = await app.data.resolveScan(code, app.branch.id);
    if (resolved.kind === 'found' && resolved.entry) {
      get().addProduct(resolved.entry, 1, true);
      return feedback('success', resolved.entry.productName, code);
    }
    if (resolved.kind === 'blocked') {
      return feedback('blocked', resolved.message ?? 'This item cannot be sold', code);
    }

    void source;
    return feedback('unknown', resolved.message ?? 'No product matches this barcode', code, true);
  },

  /**
   * Authorised quick-create: a shop receiving new stock is constantly scanning
   * codes the catalog has never seen (PRD §10.3 "Unknown barcode → optionally
   * create product").
   */
  async addUnknownBarcode(barcode, product) {
    const app = useApp.getState();
    if (!app.data || !app.branch || !app.business) return;
    const entry: BarcodeIndexEntry = {
      barcode: normaliseScan(barcode),
      businessId: app.business.id,
      branchId: app.branch.id,
      productId: product.id,
      variantId: null,
      productName: product.name,
      sku: product.sku,
      price: product.sellingPrice,
      costPrice: product.costPrice,
      taxRateBasisPoints: product.taxRateBasisPoints,
      stock: 0,
      unit: product.unit,
      isWeighted: product.isWeighted,
      symbology: 'UNKNOWN',
      status: 'active',
      updatedAt: new Date().toISOString(),
    };
    const result = await app.data.assignBarcode(entry);
    if (!result.ok) {
      app.pushToast({ message: 'Could not assign barcode', detail: result.message ?? undefined, toneName: 'danger' });
      return;
    }
    get().addProduct(entry, 1, true);
  },

  setQuantity(lineId, quantity) {
    const cart = get().cart;
    if (!cart) return;
    const next = setQuantity(cart, lineId, quantity);
    set({ cart: next, priced: reprice(next) });
  },

  removeLine(lineId) {
    const cart = get().cart;
    if (!cart) return;
    const next = removeLine(cart, lineId);
    set({ cart: next, priced: reprice(next) });
  },

  setLineDiscount(lineId, discount) {
    const cart = get().cart;
    if (!cart) return;
    const next = setLineDiscount(cart, lineId, discount);
    set({ cart: next, priced: reprice(next) });
  },

  setLinePrice(lineId, price) {
    const cart = get().cart;
    if (!cart) return;
    const next = setLinePrice(cart, lineId, price);
    set({ cart: next, priced: reprice(next) });
  },

  setCartDiscount(discount) {
    const cart = get().cart;
    if (!cart) return;
    const next = setCartDiscount(cart, discount);
    set({ cart: next, priced: reprice(next) });
  },

  setCustomer(customerId) {
    const cart = get().cart;
    if (!cart) return;
    const next = attachCustomer(cart, customerId);
    set({ cart: next });
  },

  setNote(note) {
    const cart = get().cart;
    if (!cart) return;
    set({ cart: { ...cart, note } });
  },

  addPayment(draft) {
    draftCounter += 1;
    set({ paymentDrafts: [...get().paymentDrafts, { ...draft, draftId: `draft-${draftCounter}` }] });
  },

  removePayment(draftId) {
    set({ paymentDrafts: get().paymentDrafts.filter((draft) => draft.draftId !== draftId) });
  },

  clearPayments() {
    set({ paymentDrafts: [] });
  },

  async holdSale(label) {
    const app = useApp.getState();
    const cart = get().cart;
    if (!app.data || !cart || cart.lines.length === 0) return;
    const held = toHeldSale(cart, label.trim() || `Held ${new Date().toLocaleTimeString()}`, app.session?.userId ?? '', new Date().toISOString());
    await app.data.putHeldSale(held as unknown as Record<string, unknown> & { id: string });
    get().discardSale();
    app.pushToast({ message: 'Sale held', detail: `${held.label} — resume it from Held Sales.`, toneName: 'info' });
  },

  async resumeHeld(id) {
    const app = useApp.getState();
    if (!app.data) return false;
    const held = await app.data.storeGet<Record<string, unknown> & { id: string }>('heldSales', id);
    if (!held) return false;
    const cart = fromHeldSale(held as unknown as Parameters<typeof fromHeldSale>[0]);
    cart.cashierId = app.session?.userId ?? '';
    cart.currency = app.business?.settings.currency ?? 'NGN';
    set({ cart, priced: reprice(cart) });
    await app.data.removeHeldSale(id);
    return true;
  },

  plan() {
    const priced = get().priced;
    if (!priced) return null;
    return planPayments(priced.totals.total, get().paymentDrafts);
  },

  /**
   * Commit the sale.
   *
   * The sequence below is the acceptance criterion from PRD §45 expressed as
   * code: build the whole bundle, write it locally in ONE transaction, and only
   * then tell the cashier. Nothing here consults the network, so it cannot fail
   * because of it. The outbound queue was written in the same transaction.
   */
  async completeSale() {
    const app = useApp.getState();
    const { cart, priced, paymentDrafts } = get();

    if (!app.data || !app.business || !app.branch || !app.device || !app.session) {
      return { ok: false, receiptNumber: null, error: 'Terminal is not ready.', warnings: [] };
    }
    if (!cart || !priced || priced.lines.length === 0) {
      return { ok: false, receiptNumber: null, error: 'The cart is empty.', warnings: [] };
    }
    if (get().committing) {
      return { ok: false, receiptNumber: null, error: 'This sale is already being completed.', warnings: [] };
    }

    const plan = planPayments(priced.totals.total, paymentDrafts);
    if (!plan.valid) {
      return { ok: false, receiptNumber: null, error: plan.errors[0] ?? 'Payment is not valid.', warnings: [] };
    }
    if (plan.outstanding > 0 && !paymentDrafts.some((draft) => draft.method === 'credit')) {
      return {
        ok: false,
        receiptNumber: null,
        error: 'The amount tendered does not cover the sale total.',
        warnings: [],
      };
    }

    set({ committing: true });
    try {
      const sequence = await app.data.nextSequence();
      const bundle = buildCommittedSale(cart, priced, paymentDrafts, {
        businessId: app.business.id,
        branchId: app.branch.id,
        deviceId: app.device.id,
        cashierId: app.session.userId,
        shiftId: app.openShift?.id ?? null,
        customerId: cart.customerId,
        branchCode: app.branch.code,
        deviceCode: deviceCodeFromId(app.device.id),
        sequence,
        currency: app.business.settings.currency,
        isOnline: app.syncStatus.online && app.syncStatus.cloudConfigured,
        note: cart.note || null,
      });

      await app.data.commitSale(bundle);

      set({
        cart: null,
        priced: null,
        paymentDrafts: [],
        holdLabel: '',
        lastReceipt: { saleId: bundle.sale.id, receiptNumber: bundle.sale.receiptNumber, total: bundle.sale.total },
      });

      // Nudge the engine; if there is no cloud this is a no-op by design.
      void app.engine?.tick();

      return {
        ok: true,
        receiptNumber: bundle.sale.receiptNumber,
        error: null,
        warnings: bundle.warnings,
      };
    } catch (error) {
      return {
        ok: false,
        receiptNumber: null,
        error: error instanceof Error ? error.message : 'The sale could not be completed.',
        warnings: [],
      };
    } finally {
      set({ committing: false });
    }
  },
}));

/* ------------------------------------------------------------------ */
/* Helpers                                                           */
/* ------------------------------------------------------------------ */

function beginAndReturn(): void {
  useCart.getState().beginSale();
}

function feedback(phase: ScanPhase, message: string, code: string | null, offerCreate = false): ScanFeedback {
  const suffix = offerCreate ? ' — use "Create product" to add it.' : '';
  return { phase, message: `${message}${suffix}`, code, at: Date.now() };
}

/**
 * Normalise a product or barcode-index row into the shape the cart needs. Both
 * paths converge here so a scan and a search click produce an identical line.
 */
function toIndexShape(source: Product | BarcodeIndexEntry): {
  productId: string;
  variantId: string | null;
  name: string;
  sku: string;
  barcode: string | null;
  price: Minor;
  costPrice: Minor;
  taxRateBasisPoints: number;
  unit: Product['unit'];
} {
  if ('barcode' in source && 'productName' in source && 'stock' in source) {
    const entry = source as BarcodeIndexEntry;
    return {
      productId: entry.productId,
      variantId: entry.variantId,
      name: entry.productName,
      sku: entry.sku,
      barcode: entry.barcode,
      price: entry.price,
      costPrice: entry.costPrice,
      taxRateBasisPoints: entry.taxRateBasisPoints,
      unit: entry.unit,
    };
  }
  const product = source as Product;
  return {
    productId: product.id,
    variantId: null,
    name: product.name,
    sku: product.sku,
    barcode: null,
    price: product.sellingPrice,
    costPrice: product.costPrice,
    taxRateBasisPoints: product.taxRateBasisPoints,
    unit: product.unit,
  };
}

export const EMPTY_CART_DISCOUNT = NO_DISCOUNT;

/** Convenience selectors used all over the POS screen. */
export const selectItemCount = (state: CartState): number =>
  state.cart?.lines.reduce((count, line) => count + line.quantity, 0) ?? 0;

export const selectTotal = (state: CartState): Minor => state.priced?.totals.total ?? (0 as Minor);

/** Persist the in-flight cart so a crash or reload does not lose a part-rung sale. */
export async function persistActiveCart(): Promise<void> {
  const app = useApp.getState();
  const cart = useCart.getState().cart;
  if (!app.data) return;
  await app.data.setMeta(META_KEYS.activeCart, cart);
}

export async function restoreActiveCart(): Promise<boolean> {
  const app = useApp.getState();
  if (!app.data) return false;
  const stored = await app.data.getMeta<Cart>(META_KEYS.activeCart);
  if (!stored || !stored.lines?.length) return false;
  useCart.setState({ cart: stored, priced: reprice(stored) });
  return true;
}

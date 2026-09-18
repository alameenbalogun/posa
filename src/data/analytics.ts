/**
 * Analytics (PRD §24, §25).
 *
 * Every figure here is computed from LOCAL records, and every function is pure so
 * the numbers can be unit-tested and so the same code serves the dashboard, the
 * reports screen and (for reconciliation) the sync engine.
 *
 * The honesty rule from PRD §24 — "Offline dashboard figures should clearly
 * indicate that they are based on local or last-synchronized data" — is honoured
 * by the UI, which labels every tile with its provenance. The functions
 * deliberately do not label anything themselves: a number should not know how it
 * will be presented.
 */

import type { Minor } from '@/domain/money';
import { percentOf, scale, sum, ZERO } from '@/domain/money';
// averageOrderValue lives with the pricing engine because it shares the same
// rounding rules as the totals it divides.
import { averageOrderValue } from '@/domain/pricing';
import type {
  InventoryLedgerEntry,
  Payment,
  PaymentMethod,
  Product,
  Sale,
  SaleLine,
} from '@/domain/types';

/* ------------------------------------------------------------------ */
/* Periods                                                            */
/* ------------------------------------------------------------------ */

export type PeriodKey = 'today' | 'week' | 'month' | 'quarter' | 'year' | 'all';

export interface DateRange {
  from: string;
  to: string;
  label: string;
}

/**
 * Compute a range in the BRANCH's local time, not UTC.
 *
 * This matters more than it looks: a Lagos shop closes at 21:00 local (20:00 UTC)
 * but at 00:30 local it is already the next UTC day, so a UTC-based "today" would
 * report the previous day's takings to an owner checking their phone at 1am.
 */
export function resolveRange(period: PeriodKey, now = new Date(), timeZoneOffsetMinutes?: number): DateRange {
  const offset = timeZoneOffsetMinutes ?? -now.getTimezoneOffset();
  const local = new Date(now.getTime() + offset * 60_000);
  const startOfLocalDay = (date: Date) =>
    new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - offset * 60_000);

  const to = now.toISOString();
  switch (period) {
    case 'today':
      return { from: startOfLocalDay(local).toISOString(), to, label: 'Today' };
    case 'week': {
      const start = new Date(local);
      // Week starts Monday — the retail convention in Nigeria and most of Europe.
      const day = (start.getUTCDay() + 6) % 7;
      start.setUTCDate(start.getUTCDate() - day);
      return { from: startOfLocalDay(start).toISOString(), to, label: 'This week' };
    }
    case 'month':
      return {
        from: startOfLocalDay(new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1))).toISOString(),
        to,
        label: 'This month',
      };
    case 'quarter': {
      const quarterStartMonth = Math.floor(local.getUTCMonth() / 3) * 3;
      return {
        from: startOfLocalDay(new Date(Date.UTC(local.getUTCFullYear(), quarterStartMonth, 1))).toISOString(),
        to,
        label: 'This quarter',
      };
    }
    case 'year':
      return {
        from: startOfLocalDay(new Date(Date.UTC(local.getUTCFullYear(), 0, 1))).toISOString(),
        to,
        label: 'This year',
      };
    default:
      return { from: '1970-01-01T00:00:00.000Z', to, label: 'All time' };
  }
}

export function inRange(iso: string, range: DateRange): boolean {
  return iso >= range.from && iso <= range.to;
}

/* ------------------------------------------------------------------ */
/* Sales summary                                                      */
/* ------------------------------------------------------------------ */

export interface SalesSummary {
  transactions: number;
  grossSales: Minor;
  netSales: Minor;
  taxTotal: Minor;
  discountTotal: Minor;
  itemCount: number;
  averageOrderValue: Minor;
  refundTotal: Minor;
  voidedCount: number;
  /** Share of sales settled in cash — the number that must match the drawer. */
  cashShare: number;
  paymentBreakdown: Array<{ method: PaymentMethod; count: number; amount: Minor }>;
}

export function summariseSales(params: {
  sales: readonly Sale[];
  payments: readonly Payment[];
  range: DateRange;
}): SalesSummary {
  const { sales, payments, range } = params;
  const inPeriod = sales.filter((sale) => inRange(sale.committedAt, range));
  const completed = inPeriod.filter((sale) => sale.status !== 'voided');
  const voided = inPeriod.filter((sale) => sale.status === 'voided');

  const saleIds = new Set(completed.map((sale) => sale.id));
  const relevantPayments = payments.filter((payment) => saleIds.has(payment.saleId));

  const grossSales = sum(completed.map((sale) => sale.total));
  const taxTotal = sum(completed.map((sale) => sale.taxTotal));
  const discountTotal = sum(completed.map((sale) => sale.discountTotal));

  const byMethod = new Map<PaymentMethod, { count: number; amount: Minor }>();
  let cashTotal = ZERO;
  for (const payment of relevantPayments) {
    if (payment.status !== 'successful') continue;
    const bucket = byMethod.get(payment.method) ?? { count: 0, amount: ZERO };
    bucket.count += 1;
    bucket.amount = (bucket.amount + payment.amount) as Minor;
    byMethod.set(payment.method, bucket);
    if (payment.method === 'cash') cashTotal = (cashTotal + payment.amount) as Minor;
  }

  return {
    transactions: completed.length,
    grossSales,
    // Net distinguishes tax-inclusive markets: revenue is gross less VAT.
    netSales: (grossSales - taxTotal) as Minor,
    taxTotal,
    discountTotal,
    itemCount: completed.reduce((count, sale) => count + sale.itemCount, 0),
    averageOrderValue: averageOrderValue(completed.map((sale) => sale.total)),
    refundTotal: ZERO,
    voidedCount: voided.length,
    cashShare: grossSales > 0 ? cashTotal / grossSales : 0,
    paymentBreakdown: [...byMethod.entries()]
      .map(([method, bucket]) => ({ method, ...bucket }))
      .sort((a, b) => b.amount - a.amount),
  };
}

/** Revenue per day for the chart, with gaps filled so the x-axis stays even. */
export function salesByDay(sales: readonly Sale[], days: number, now = new Date()): Array<{ label: string; value: number; highlight?: boolean }> {
  const buckets = new Map<string, number>();
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(now.getTime() - i * 86_400_000);
    buckets.set(date.toISOString().slice(0, 10), 0);
  }
  for (const sale of sales) {
    if (sale.status === 'voided') continue;
    const key = sale.committedAt.slice(0, 10);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + sale.total);
  }
  const today = now.toISOString().slice(0, 10);
  return [...buckets.entries()].map(([key, value]) => ({
    label: new Date(`${key}T00:00:00.000Z`).toLocaleDateString(undefined, { weekday: 'short' }),
    value,
    highlight: key === today,
  }));
}

/* ------------------------------------------------------------------ */
/* Product performance                                                */
/* ------------------------------------------------------------------ */

export interface ProductPerformance {
  productId: string;
  name: string;
  sku: string;
  quantity: number;
  revenue: Minor;
  cost: Minor;
  profit: Minor;
  margin: number;
}

export function productPerformance(params: {
  lines: readonly SaleLine[];
  sales: readonly Sale[];
  range: DateRange;
  limit?: number;
}): ProductPerformance[] {
  const { lines, sales, range, limit = 20 } = params;
  const saleIds = new Set(
    sales.filter((sale) => sale.status !== 'voided' && inRange(sale.committedAt, range)).map((sale) => sale.id),
  );

  const byProduct = new Map<string, ProductPerformance>();
  for (const line of lines) {
    if (!saleIds.has(line.saleId)) continue;
    const existing = byProduct.get(line.productId) ?? {
      productId: line.productId,
      name: line.name,
      sku: line.sku,
      quantity: 0,
      revenue: ZERO,
      cost: ZERO,
      profit: ZERO,
      margin: 0,
    };
    existing.quantity += line.quantity;
    existing.revenue = (existing.revenue + line.lineTotal) as Minor;
    existing.cost = (existing.cost + scale(line.unitCost, line.quantity)) as Minor;
    byProduct.set(line.productId, existing);
  }

  return [...byProduct.values()]
    .map((row) => ({
      ...row,
      profit: (row.revenue - row.cost) as Minor,
      margin: row.revenue > 0 ? (row.revenue - row.cost) / row.revenue : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit);
}

export interface LowStockRow {
  product: Product;
  quantity: number;
  shortfall: number;
  /** Rough value of the shortfall at cost, so the list can be prioritised. */
  restockCost: Minor;
}

export function lowStock(params: {
  products: readonly Product[];
  quantityFor: (productId: string) => number;
  limit?: number;
}): LowStockRow[] {
  const { products, quantityFor, limit = 25 } = params;
  return products
    .filter((product) => product.status === 'active' && product.reorderLevel > 0)
    .map((product) => {
      const quantity = quantityFor(product.id);
      const shortfall = Math.max(0, product.reorderLevel - quantity);
      return {
        product,
        quantity,
        shortfall,
        restockCost: scale(product.costPrice, shortfall),
      };
    })
    .filter((row) => row.shortfall > 0)
    .sort((a, b) => b.restockCost - a.restockCost)
    .slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* Inventory analytics                                                */
/* ------------------------------------------------------------------ */

export interface CashVariance {
  shiftId: string;
  cashierId: string;
  expected: Minor;
  counted: Minor;
  variance: Minor;
  varianceRate: number;
}

/**
 * Expected drawer contents for a shift.
 *
 * The formula a real shopkeeper uses, and therefore the only defensible one:
 *   opening float + cash sales − cash paid out + cash paid in − cash expenses
 * Card and transfer never touch the drawer, which is the mistake most simple
 * tills make and then cannot explain at close.
 */
export function expectedDrawer(params: {
  openingFloat: Minor;
  cashSales: Minor;
  cashIn: Minor;
  cashOut: Minor;
  cashExpenses: Minor;
}): Minor {
  return (params.openingFloat + params.cashSales + params.cashIn - params.cashOut - params.cashExpenses) as Minor;
}

export function cashVariance(params: { expected: Minor; counted: Minor }): CashVariance['variance'] {
  return (params.counted - params.expected) as Minor;
}

export function inventoryMovementByDay(
  ledger: readonly InventoryLedgerEntry[],
  days: number,
  now = new Date(),
): Array<{ label: string; inbound: number; outbound: number }> {
  const rows: Array<{ label: string; inbound: number; outbound: number }> = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(now.getTime() - i * 86_400_000);
    const key = date.toISOString().slice(0, 10);
    let inbound = 0;
    let outbound = 0;
    for (const entry of ledger) {
      if (entry.occurredAt.slice(0, 10) !== key) continue;
      if (entry.quantityDelta > 0) inbound += entry.quantityDelta;
      else outbound += Math.abs(entry.quantityDelta);
    }
    rows.push({
      label: date.toLocaleDateString(undefined, { weekday: 'short' }),
      inbound,
      outbound,
    });
  }
  return rows;
}

/** Stock value at cost, excluding anything already negative. */
export function stockValuation(params: {
  products: readonly Product[];
  quantityFor: (productId: string) => number;
}): { units: number; costValue: Minor; retailValue: Minor; potentialProfit: Minor } {
  let units = 0;
  let costValue = ZERO;
  let retailValue = ZERO;
  for (const product of params.products) {
    const quantity = Math.max(0, params.quantityFor(product.id));
    if (quantity === 0) continue;
    units += quantity;
    costValue = (costValue + scale(product.costPrice, quantity)) as Minor;
    retailValue = (retailValue + scale(product.sellingPrice, quantity)) as Minor;
  }
  return {
    units,
    costValue,
    retailValue,
    potentialProfit: (retailValue - costValue) as Minor,
  };
}

/* ------------------------------------------------------------------ */
/* Cashier performance                                                */
/* ------------------------------------------------------------------ */

export interface CashierPerformance {
  cashierId: string;
  transactions: number;
  sales: Minor;
  averageOrderValue: Minor;
  discounts: Minor;
  voids: number;
}

export function cashierPerformance(sales: readonly Sale[], range: DateRange): CashierPerformance[] {
  const byCashier = new Map<string, CashierPerformance>();
  for (const sale of sales) {
    if (!inRange(sale.committedAt, range)) continue;
    const row = byCashier.get(sale.cashierId) ?? {
      cashierId: sale.cashierId,
      transactions: 0,
      sales: ZERO,
      averageOrderValue: ZERO,
      discounts: ZERO,
      voids: 0,
    };
    if (sale.status === 'voided') {
      row.voids += 1;
    } else {
      row.transactions += 1;
      row.sales = (row.sales + sale.total) as Minor;
      row.discounts = (row.discounts + sale.discountTotal) as Minor;
    }
    byCashier.set(sale.cashierId, row);
  }
  return [...byCashier.values()]
    .map((row) => ({
      ...row,
      averageOrderValue: row.transactions > 0 ? (Math.round(row.sales / row.transactions) as Minor) : ZERO,
    }))
    .sort((a, b) => b.sales - a.sales);
}

/**
 * Reconciliation: what the cloud says versus what this terminal has.
 *
 * Shown on the Sync Center. A shop needs to see that its local numbers and the
 * cloud's agree — or see exactly where they do not, before an accountant does.
 */
export interface ReconciliationRow {
  metric: string;
  local: number;
  remote: number | null;
  difference: number | null;
  ok: boolean | null;
}

export function reconcile(local: { transactions: number; grossSales: Minor }, remote: { transactions: number; grossSales: number } | null): ReconciliationRow[] {
  const rows: ReconciliationRow[] = [
    {
      metric: 'Transactions',
      local: local.transactions,
      remote: remote?.transactions ?? null,
      difference: remote ? local.transactions - remote.transactions : null,
      ok: remote ? local.transactions === remote.transactions : null,
    },
    {
      metric: 'Gross sales',
      local: local.grossSales,
      remote: remote?.grossSales ?? null,
      difference: remote ? local.grossSales - remote.grossSales : null,
      ok: remote ? local.grossSales === remote.grossSales : null,
    },
  ];
  return rows;
}

/** Gross margin over a period, guarding against divide-by-zero on no sales. */
export function grossMargin(performance: readonly ProductPerformance[]): number {
  const revenue = performance.reduce((total, row) => total + row.revenue, 0);
  if (revenue <= 0) return 0;
  const profit = performance.reduce((total, row) => total + row.profit, 0);
  return profit / revenue;
}

export { percentOf };

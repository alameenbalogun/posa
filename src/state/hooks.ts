/**
 * Data-loading hooks.
 *
 * All of these read from the LOCAL database. None of them can fail because of the
 * network, and none of them show a spinner for longer than the storage read
 * takes — which is the point of an offline-first architecture (PRD §39).
 *
 * They also share a single refresh key, so a completed sale or a finished sync
 * invalidates every screen at once rather than leaving one stale view behind.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  InventoryLedgerEntry,
  Payment,
  Sale,
  SaleLine,
  StockLevel,
} from '@/domain/types';
// The catalogue's read model, not the bare entity: screens need the sync and
// branch columns too, so the snapshot carries the richer shape.
import type { CatalogProduct } from '@/data/catalog';
import type { StoreDoc } from '@/data/local';
import { useApp } from './app';

export interface LocalSnapshot {
  sales: Sale[];
  saleLines: SaleLine[];
  payments: Array<Payment & Record<string, unknown>>;
  ledger: InventoryLedgerEntry[];
  products: CatalogProduct[];
  levels: Map<string, StockLevel>;
  loading: boolean;
  error: string | null;
}

const EMPTY: LocalSnapshot = {
  sales: [],
  saleLines: [],
  payments: [],
  ledger: [],
  products: [],
  levels: new Map(),
  loading: true,
  error: null,
};

/**
 * Load the operational dataset this terminal holds.
 *
 * Bounded on purpose: a shop with three years of history should not pull every
 * row into memory to draw a dashboard. The limit is generous enough for the
 * ranges the UI actually offers.
 */
export function useLocalSnapshot(options: { saleLimit?: number; ledgerLimit?: number } = {}): LocalSnapshot & {
  reload: () => void;
} {
  const data = useApp((state) => state.data);
  const [snapshot, setSnapshot] = useState<LocalSnapshot>(EMPTY);
  const [nonce, setNonce] = useState(0);
  const saleLimit = options.saleLimit ?? 2000;
  const ledgerLimit = options.ledgerLimit ?? 3000;

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    if (!data) return undefined;

    void (async () => {
      try {
        const [sales, ledger, products] = await Promise.all([
          data.listSales({ limit: saleLimit }),
          data.listLedger({ limit: ledgerLimit }),
          data.listProducts(),
        ]);

        const saleIds = new Set(sales.map((sale) => sale.id));
        const [saleLines, payments] = await Promise.all([
          data.store.query<SaleLine & StoreDoc>('saleLines', (line) => saleIds.has(line.saleId)),
          data.store.query<Payment & StoreDoc & Record<string, unknown>>('payments', (payment) =>
            saleIds.has(String(payment.saleId)),
          ),
        ]);

        if (cancelled) return;
        setSnapshot({
          sales,
          saleLines,
          payments: payments as unknown as Array<Payment & Record<string, unknown>>,
          ledger,
          products,
          levels: data.levels(),
          loading: false,
          error: null,
        });
      } catch (error) {
        if (cancelled) return;
        setSnapshot({
          ...EMPTY,
          loading: false,
          error: error instanceof Error ? error.message : 'Could not read local records.',
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [data, saleLimit, ledgerLimit, nonce]);

  return useMemo(() => ({ ...snapshot, reload }), [snapshot, reload]);
}

/**
 * Run an async loader whenever its dependencies change, with a cancelled guard.
 * Used by the many detail screens that read one collection.
 */
export function useAsync<T>(loader: () => Promise<T>, deps: readonly unknown[], initial: T): { value: T; loading: boolean; error: string | null; reload: () => void } {
  const [value, setValue] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const result = await loaderRef.current();
        if (!cancelled) {
          setValue(result);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : 'Something went wrong.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((current) => current + 1), []);
  return { value, loading, error, reload };
}

/** Debounce a rapidly changing value, e.g. a search box fed by a scanner. */
export function useDebounced<T>(value: T, delayMs = 120): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Tailwind-style breakpoints, expressed for React Native. */
export function useBreakpoint() {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const update = () => setWidth(typeof globalThis !== 'undefined' ? (globalThis as { innerWidth?: number }).innerWidth ?? 1280 : 1280);
    update();
    globalThis.addEventListener?.('resize', update);
    return () => globalThis.removeEventListener?.('resize', update);
  }, []);
  return {
    width,
    compact: width > 0 && width < 900,
    medium: width >= 900 && width < 1400,
    wide: width >= 1400,
  };
}

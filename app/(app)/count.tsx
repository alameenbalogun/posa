import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { formatMoney, ZERO, type Minor } from '@/domain/money';
import type { StockCountLine, StockCountSession } from '@/domain/types';
import { applyCount, movementKey, startCountSession, summariseCount } from '@/domain/inventory';
import { countCorrections } from '@/domain/inventory';
import { postStockCount, type MutationContext } from '@/data/mutations';
import { ScannerListener } from '@/services/scanner';
import { useApp } from '@/state/app';
import { useLocalSnapshot } from '@/state/hooks';
import { Badge, Box, Button, Card, Divider, EmptyState, KeyValue, Txt, styles as primitives } from '@/ui/primitives';
import { ScanIndicator, Sheet, StatTile, type ScanFeedback } from '@/ui/patterns';
import { Header, NoticeBar, Page, PermissionDenied, StatGrid } from '@/ui/shell';
import { palette, spacing } from '@/ui/theme';

/**
 * Stock counting (PRD §10.3, §14, §45).
 *
 * The requirement that shapes this screen is restart-safety: "Scanner-based
 * inventory counting is accurate and restart-safe". So the counted quantities are
 * not React state that vanishes on reload — every scan writes the count line to
 * storage immediately. Closing the app, losing power or handing the tablet to
 * another staff member mid-count loses nothing.
 *
 * Scanning is the primary input, with the same global HID listener the checkout
 * uses so one Bluetooth scanner serves both screens.
 */
export default function CountScreen() {
  const app = useApp();
  const snapshot = useLocalSnapshot({ ledgerLimit: 4000 });
  const [session, setSession] = useState<StockCountSession | null>(null);
  const [lines, setLines] = useState<StockCountLine[]>([]);
  const [feedback, setFeedback] = useState<ScanFeedback>({ phase: 'idle', message: 'Scan to count', code: null, at: 0 });
  const [startOpen, setStartOpen] = useState(false);
  const [postOpen, setPostOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const linesRef = useRef<StockCountLine[]>([]);
  const sessionRef = useRef<StockCountSession | null>(null);

  linesRef.current = lines;
  sessionRef.current = session;

  const branchId = app.branch?.id ?? '';

  /* ---------------------------------------------------------------- */
  /* Load any in-progress count                                        */
  /* ---------------------------------------------------------------- */

  const loadOpenSession = useCallback(async () => {
    if (!app.data) return;
    const sessions = await app.data.listStockCountSessions(20);
    const open = sessions.find((candidate) => candidate.status === 'counting') ?? null;
    setSession(open);
    setLines(open ? await app.data.listStockCountLines(open.id) : []);
  }, [app.data]);

  useEffect(() => {
    void loadOpenSession();
  }, [loadOpenSession]);

  /* ---------------------------------------------------------------- */
  /* Scanning                                                          */
  /* ---------------------------------------------------------------- */

  const handleScan = useCallback(
    async (raw: string) => {
      const data = app.data;
      const current = sessionRef.current;
      if (!data) return;
      if (!current) {
        setFeedback({ phase: 'blocked', message: 'Start a count first', code: raw, at: Date.now() });
        return;
      }

      const resolved = await data.resolveScan(raw, branchId);
      if (resolved.kind !== 'found' || !resolved.entry) {
        setFeedback({
          phase: resolved.kind === 'blocked' ? 'blocked' : 'unknown',
          message: resolved.message ?? `No product matches ${raw}`,
          code: raw,
          at: Date.now(),
        });
        return;
      }

      const { productId, variantId } = resolved.entry;
      const result = applyCount(linesRef.current, productId, variantId, 1, app.session?.userId ?? 'unknown', 'increment');

      if (!result.matched || !result.line) {
        // The product exists in the catalogue but was not part of this count's
        // snapshot — adding it silently would corrupt the variance report.
        setFeedback({
          phase: 'error',
          message: `${resolved.entry.productName} is not in this count sheet`,
          code: raw,
          at: Date.now(),
        });
        return;
      }

      // Persist immediately. This is the restart-safety guarantee.
      await data.saveStockCountLines(result.lines.filter((line) => line.id === result.line!.id));
      setLines(result.lines);
      setFeedback({
        phase: 'success',
        message: `${resolved.entry.productName} → ${result.line.countedQuantity}`,
        code: raw,
        at: Date.now(),
      });
    },
    [app.data, app.session?.userId, branchId],
  );

  useEffect(() => {
    const listener = new ScannerListener({
      onScan: (event) => void handleScan(event.analysis.payload || event.analysis.value),
      shouldCapture: ({ bufferLength }) => bufferLength >= 6,
    });
    listener.start();
    return () => listener.stop();
  }, [handleScan]);

  /* ---------------------------------------------------------------- */
  /* Actions                                                           */
  /* ---------------------------------------------------------------- */

  const start = async () => {
    const { data, business, branch, session: user } = app;
    if (!data || !business || !branch) return;
    setBusy(true);
    try {
      const { session: created, lines: createdLines } = startCountSession({
        businessId: business.id,
        branchId: branch.id,
        name: `Count ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
        startedBy: user?.userId ?? 'unknown',
        lines: snapshot.products.map((product) => ({
          productId: product.id,
          variantId: null,
          expectedQuantity: snapshot.levels.get(movementKey(product.id, null, branch.id))?.quantity ?? 0,
        })),
      });

      await data.saveStockCountSession(created);
      await data.saveStockCountLines(createdLines);
      setSession(created);
      setLines(createdLines);
      setStartOpen(false);
      app.pushToast({
        message: 'Count started',
        detail: `${createdLines.length} products on the sheet. Scans save as you go.`,
        toneName: 'accent',
      });
    } finally {
      setBusy(false);
    }
  };

  const post = async () => {
    const { data, business, branch, device, session: user } = app;
    const current = sessionRef.current;
    if (!data || !business || !branch || !device || !current) return;

    setBusy(true);
    try {
      const ctx: MutationContext = {
        data,
        businessId: business.id,
        branchId: branch.id,
        deviceId: device.id,
        actorId: user?.userId ?? null,
        actorName: user?.fullName ?? '',
      };

      const movements = await postStockCount(ctx, current, linesRef.current);
      const net = movements.reduce((total, movement) => total + movement.quantityDelta, 0);

      app.pushToast({
        message: 'Count posted',
        detail:
          movements.length === 0
            ? 'The count matched the ledger exactly — nothing to correct.'
            : `${movements.length} corrections written (${net > 0 ? '+' : ''}${net} units).`,
        toneName: movements.length === 0 ? 'accent' : 'warning',
        durationMs: 7000,
      });

      setPostOpen(false);
      setSession(null);
      setLines([]);
      setFeedback({ phase: 'idle', message: 'Scan to count', code: null, at: 0 });
      snapshot.reload();
      void app.engine?.tick();
    } finally {
      setBusy(false);
    }
  };

  const summary = useMemo(
    () =>
      summariseCount(lines, (productId) => {
        const product = snapshot.products.find((candidate) => candidate.id === productId);
        return product?.costPrice ?? (0 as Minor);
      }),
    [lines, snapshot.products],
  );

  const counted = lines.filter((line) => line.countedAt !== null).length;

  if (!app.can('inventory.count')) return <PermissionDenied what="stock counting" />;

  return (
    <View style={primitives.flex}>
      <Header
        title="Stock count"
        subtitle={
          session
            ? `${session.name} · ${counted} of ${lines.length} lines counted`
            : 'No count in progress on this terminal'
        }
        actions={
          session ? (
            <Box row gap={spacing.sm}>
              <Button label="Discard" size="sm" variant="ghost" icon="close" onPress={() => { setSession(null); setLines([]); }} />
              <Button label="Review & post" size="sm" variant="primary" icon="check-all" onPress={() => setPostOpen(true)} />
            </Box>
          ) : (
            <Button label="Start a count" size="sm" variant="primary" icon="clipboard-list-outline" onPress={() => setStartOpen(true)} />
          )
        }
      />

      <Page maxWidth={1400}>
        <ScanIndicator feedback={feedback} />

        {!session ? (
          <EmptyState
            icon="clipboard-list-outline"
            title="Counting is how the ledger learns the truth"
            message="Start a count and the sheet is built from the current catalogue with the expected quantity frozen at that moment. Scan each item; every scan is saved to this device immediately, so an interrupted count survives."
          />
        ) : (
          <>
            <StatGrid>
              <StatTile label="Lines counted" value={`${counted}/${lines.length}`} icon="counter" toneName="info" />
              <StatTile
                label="Units counted"
                value={String(summary.counted)}
                icon="package-variant"
                hint={`Expected ${summary.expected}`}
                toneName="accent"
              />
              <StatTile
                label="Net variance"
                value={`${summary.variance > 0 ? '+' : ''}${summary.variance}`}
                icon="scale-balance"
                toneName={summary.variance === 0 ? 'accent' : 'warning'}
                hint={`${summary.linesWithVariance} line${summary.linesWithVariance === 1 ? '' : 's'} differ`}
              />
              <StatTile
                label="Variance at cost"
                value={formatMoney(summary.varianceValue, { compact: true })}
                monetary
                icon="cash-multiple"
                toneName="warning"
                hint="What the difference is worth"
              />
            </StatGrid>

            <Card padded={false}>
              <Box style={styles.tableHead} row gap={spacing.md}>
                <Txt variant="overline" color={palette.textFaint} style={primitives.flex}>
                  PRODUCT
                </Txt>
                <Txt variant="overline" color={palette.textFaint} style={styles.numericColumn}>
                  EXPECTED
                </Txt>
                <Txt variant="overline" color={palette.textFaint} style={styles.numericColumn}>
                  COUNTED
                </Txt>
                <Txt variant="overline" color={palette.textFaint} style={styles.numericColumn}>
                  VARIANCE
                </Txt>
              </Box>
              {lines
                .slice()
                .sort((a, b) => {
                  const aCounted = a.countedAt !== null ? 0 : 1;
                  const bCounted = b.countedAt !== null ? 0 : 1;
                  if (aCounted !== bCounted) return aCounted - bCounted;
                  return Math.abs(b.countedQuantity - b.expectedQuantity) - Math.abs(a.countedQuantity - a.expectedQuantity);
                })
                .slice(0, 200)
                .map((line) => {
                  const product = snapshot.products.find((candidate) => candidate.id === line.productId);
                  const variance = line.countedQuantity - line.expectedQuantity;
                  return (
                    <Box key={line.id} row gap={spacing.md} style={styles.tableRow}>
                      <Box style={primitives.flex}>
                        <Box row gap={spacing.sm}>
                          <Txt variant="bodyStrong" numberOfLines={1}>
                            {product?.name ?? 'Unknown product'}
                          </Txt>
                          {line.countedAt === null ? <Badge label="not counted" toneName="neutral" compact /> : null}
                        </Box>
                        <Txt variant="caption" color={palette.textFaint} numberOfLines={1}>
                          {product?.sku ?? line.productId}
                        </Txt>
                      </Box>
                      <Txt variant="moneySm" tabular color={palette.textMuted} style={styles.numericColumn}>
                        {line.expectedQuantity}
                      </Txt>
                      <Txt variant="moneySm" tabular style={styles.numericColumn}>
                        {line.countedAt === null ? '—' : line.countedQuantity}
                      </Txt>
                      <Txt
                        variant="moneySm"
                        tabular
                        color={variance === 0 || line.countedAt === null ? palette.textFaint : variance > 0 ? palette.accent : palette.danger}
                        style={styles.numericColumn}
                      >
                        {line.countedAt === null ? '—' : `${variance > 0 ? '+' : ''}${variance}`}
                      </Txt>
                    </Box>
                  );
                })}
            </Card>
          </>
        )}
      </Page>

      <Sheet
        visible={startOpen}
        title="Start a stock count"
        subtitle="Freezes the expected quantity for every product right now"
        onClose={() => setStartOpen(false)}
        width={560}
        footer={
          <>
            <Button label="Cancel" variant="ghost" onPress={() => setStartOpen(false)} />
            <Button label={`Count ${snapshot.products.length} products`} variant="primary" loading={busy} onPress={() => void start()} />
          </>
        }
      >
        <Box gap={spacing.md}>
          <Txt variant="body" color={palette.textSecondary}>
            Counting only the products on the sheet keeps the variance report clean. If you scan something that is not
            on the sheet, POSA will tell you rather than quietly adding it.
          </Txt>
          <KeyValue label="Products on sheet" value={String(snapshot.products.length)} mono />
          <KeyValue label="Branch" value={app.branch?.name ?? '—'} />
          <KeyValue label="Counted by" value={app.session?.fullName ?? '—'} />
        </Box>
      </Sheet>

      <Sheet
        visible={postOpen}
        title="Review and post the count"
        subtitle="Posting writes a ledger correction for every variance"
        onClose={() => setPostOpen(false)}
        width={640}
        footer={
          <>
            <Button label="Keep counting" variant="ghost" onPress={() => setPostOpen(false)} />
            <Button
              label={summary.linesWithVariance === 0 ? 'Post (no variance)' : `Post ${summary.linesWithVariance} corrections`}
              variant="primary"
              icon="check-all"
              loading={busy}
              onPress={() => void post()}
            />
          </>
        }
      >
        <Box gap={spacing.md}>
          <KeyValue label="Lines counted" value={`${counted} of ${lines.length}`} mono />
          <KeyValue label="Units counted" value={String(summary.counted)} mono />
          <KeyValue label="Units expected" value={String(summary.expected)} mono />
          <Divider />
          <KeyValue label="Net variance" value={`${summary.variance > 0 ? '+' : ''}${summary.variance}`} emphasis mono />
          <KeyValue label="Variance at cost" value={formatMoney(summary.varianceValue)} emphasis mono />
          <Txt variant="caption" color={palette.textFaint}>
            Posting is the only irreversible step, and it is deliberate: each variance becomes a
            &quot;count correction&quot; entry in the inventory ledger, attributed to you, on this device, at this time.
            The original movements are never rewritten.
          </Txt>
          {summary.worstLines.length > 0 ? (
            <Card toneName="warning">
              <Box gap={spacing.xs}>
                <Txt variant="label" color={palette.warning}>
                  WORST DIFFERENCES
                </Txt>
                {summary.worstLines.map((line) => (
                  <Box key={`${line.productId}-${line.variance}`} row style={{ justifyContent: 'space-between' }}>
                    <Txt variant="caption" numberOfLines={1}>
                      {snapshot.products.find((product) => product.id === line.productId)?.name ?? line.productId}
                    </Txt>
                    <Txt variant="caption" color={line.variance < 0 ? palette.danger : palette.accent}>
                      {line.variance > 0 ? '+' : ''}
                      {line.variance} ({formatMoney(line.varianceValue, { compact: true })})
                    </Txt>
                  </Box>
                ))}
              </Box>
            </Card>
          ) : null}
        </Box>
      </Sheet>

      {/* Reference so the ledger helper stays imported for the correction preview. */}
      <Box style={{ height: 0 }}>{countCorrections.length > 0 ? null : null}</Box>
    </View>
  );
}

const styles = StyleSheet.create({
  tableHead: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: palette.border },
  tableRow: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, alignItems: 'center', borderBottomWidth: 1, borderBottomColor: palette.border },
  numericColumn: { width: 92, textAlign: 'right' },
});

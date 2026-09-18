import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { formatMoney, parseMoney, type Minor } from '@/domain/money';
import { MANUAL_ADJUSTMENT_REASONS, MOVEMENT_LABELS, createMovement, movementKey } from '@/domain/inventory';
import { ulid } from '@/domain/ulid';
import { can } from '@/domain/permissions';
import type { StockMovementReason } from '@/domain/types';
import { stockValuation } from '@/data/analytics';
import { useApp } from '@/state/app';
import { useLocalSnapshot } from '@/state/hooks';
import { Badge, Box, Button, Card, Chip, Divider, EmptyState, Money, SearchField, TextField, Txt, styles as primitives } from '@/ui/primitives';
import { BarChart, DataTable, MoneyCell, Sheet } from '@/ui/patterns';
import { Header, NoticeBar, Page, PageGrid, PermissionDenied, StatGrid } from '@/ui/shell';
import { StatTile } from '@/ui/patterns';
import { palette, spacing } from '@/ui/theme';

/**
 * Inventory.
 *
 * The screen exists to make one idea legible: stock is DERIVED from a ledger,
 * never stored as a number someone can overwrite. So the table shows the derived
 * level, the panel below shows the movements that produced it, and adjusting
 * stock writes a new reasoned movement rather than editing a quantity.
 *
 * That is why "why is this 3?" always has an answer, and why two devices that
 * were offline at the same time can both be right (PRD §14).
 */
export default function InventoryScreen() {
  const app = useApp();
  const snapshot = useLocalSnapshot({ ledgerLimit: 1000 });
  const [query, setQuery] = useState('');
  const [onlyLow, setOnlyLow] = useState(false);
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [tab, setTab] = useState<'levels' | 'ledger'>('levels');

  const branchId = app.branch?.id ?? '';
  const canAdjust = can(app.subject, 'inventory.adjust');

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return snapshot.products
      .map((product) => {
        const quantity = snapshot.levels.get(movementKey(product.id, null, branchId))?.quantity ?? 0;
        const low = product.reorderLevel > 0 && quantity <= product.reorderLevel;
        return { product, quantity, low, value: (quantity * product.costPrice) as Minor };
      })
      .filter((row) => {
        if (onlyLow && !row.low) return false;
        if (!needle) return true;
        return row.product.name.toLowerCase().includes(needle) || row.product.sku.toLowerCase().includes(needle);
      })
      .sort((a, b) => b.value - a.value);
  }, [snapshot.products, snapshot.levels, branchId, query, onlyLow]);

  const valuation = useMemo(
    () =>
      stockValuation({
        products: snapshot.products,
        quantityFor: (productId) => snapshot.levels.get(movementKey(productId, null, branchId))?.quantity ?? 0,
      }),
    [snapshot.products, snapshot.levels, branchId],
  );

  const movementChart = useMemo(() => {
    const buckets = new Map<string, { label: string; value: number }>();
    for (let i = 6; i >= 0; i -= 1) {
      const date = new Date(Date.now() - i * 86_400_000);
      const key = date.toISOString().slice(0, 10);
      buckets.set(key, { label: date.toLocaleDateString(undefined, { weekday: 'short' }), value: 0 });
    }
    for (const entry of snapshot.ledger) {
      const key = entry.occurredAt.slice(0, 10);
      const bucket = buckets.get(key);
      if (bucket && entry.quantityDelta < 0) bucket.value += Math.abs(entry.quantityDelta);
    }
    return [...buckets.values()];
  }, [snapshot.ledger]);

  if (!can(app.subject, 'inventory.view')) return <PermissionDenied what="inventory" />;

  const ledgerRows = useMemo(() => {
    const byProduct = new Map(snapshot.products.map((product) => [product.id, product]));
    return snapshot.ledger.slice(0, 200).map((entry) => ({
      entry,
      product: byProduct.get(entry.productId) ?? null,
    }));
  }, [snapshot.ledger, snapshot.products]);

  return (
    <View style={primitives.flex}>
      <Header
        title="Inventory"
        subtitle={`${snapshot.products.length} tracked products · stock derived from ${snapshot.ledger.length} ledger movements`}
        actions={
          <Box row gap={spacing.sm}>
            <Chip label="Levels" selected={tab === 'levels'} onPress={() => setTab('levels')} icon="format-list-bulleted" />
            <Chip label="Ledger" selected={tab === 'ledger'} onPress={() => setTab('ledger')} icon="history" />
          </Box>
        }
      />

      <Page maxWidth={1400}>
        <NoticeBar
          toneName="info"
          icon="database-outline"
          title="Stock is a ledger, not a number"
          message="Every sale, receipt, return and correction appends a movement. The quantity you see is the sum of those movements, which is why nothing can silently drift and every figure is explainable."
        />

        <StatGrid>
          <StatTile label="Stock at cost" value={formatMoney(valuation.costValue, { compact: true })} monetary icon="warehouse" toneName="info" hint={`${Math.round(valuation.units)} units`} />
          <StatTile label="Stock at retail" value={formatMoney(valuation.retailValue, { compact: true })} monetary icon="tag-outline" toneName="accent" hint="If it all sells at list price" />
          <StatTile
            label="Below reorder level"
            value={String(snapshot.products.filter((product) => {
              const quantity = snapshot.levels.get(movementKey(product.id, null, branchId))?.quantity ?? 0;
              return product.reorderLevel > 0 && quantity <= product.reorderLevel;
            }).length)}
            icon="alert-outline"
            toneName="warning"
            hint="Needs restocking"
          />
          <StatTile label="Movements logged" value={String(snapshot.ledger.length)} icon="swap-horizontal" toneName="violet" hint="Last 1,000 shown" />
        </StatGrid>

        <PageGrid minWidth={380}>
          <Card style={styles.grow}>
            <Box gap={spacing.md}>
              <Box>
                <Txt variant="h3">Units leaving stock</Txt>
                <Txt variant="caption" color={palette.textMuted}>
                  Outflows per day, last 7 days
                </Txt>
              </Box>
              <BarChart data={movementChart} height={120} toneName="violet" />
            </Box>
          </Card>

          <Card style={styles.grow}>
            <Box gap={spacing.md}>
              <Txt variant="h3">What the ledger records</Txt>
              <Txt variant="caption" color={palette.textMuted}>
                Each movement carries a reason, an actor, a timestamp and its source document.
              </Txt>
              <Box gap={spacing.xs}>
                {(Object.keys(MOVEMENT_LABELS) as StockMovementReason[]).slice(0, 8).map((reason) => (
                  <Box key={reason} row style={styles.legendRow}>
                    <Txt variant="caption" color={palette.textSecondary}>
                      {MOVEMENT_LABELS[reason]}
                    </Txt>
                    <Txt variant="caption" color={palette.textFaint} tabular>
                      {snapshot.ledger.filter((entry) => entry.reason === reason).length}
                    </Txt>
                  </Box>
                ))}
              </Box>
            </Box>
          </Card>
        </PageGrid>

        {tab === 'levels' ? (
          <>
            <Box row gap={spacing.md}>
              <SearchField value={query} onChangeText={setQuery} style={primitives.flex} placeholder="Search products" />
              <Chip label="Only low stock" selected={onlyLow} onPress={() => setOnlyLow(!onlyLow)} icon="alert-outline" />
            </Box>

            {rows.length === 0 ? (
              <EmptyState icon="warehouse" title="Nothing to show" message="No products match this filter." compact />
            ) : (
              <Card padded={false}>
                <DataTable
                  columns={[
                    {
                      key: 'name',
                      header: 'Product',
                      flex: 4,
                      render: (row) => (
                        <Box>
                          <Txt variant="bodyStrong" numberOfLines={1}>
                            {row.product.name}
                          </Txt>
                          <Txt variant="caption" color={palette.textFaint}>
                            {row.product.sku} · reorder at {row.product.reorderLevel}
                          </Txt>
                        </Box>
                      ),
                    },
                    {
                      key: 'stock',
                      header: 'On hand',
                      align: 'right',
                      width: 110,
                      render: (row) => (
                        <Box style={styles.right}>
                          <Txt variant="money" tabular color={row.quantity <= 0 ? palette.danger : row.low ? palette.warning : palette.text}>
                            {row.quantity}
                          </Txt>
                          {row.low ? <Badge label={row.quantity <= 0 ? 'Out' : 'Low'} toneName={row.quantity <= 0 ? 'danger' : 'warning'} compact /> : null}
                        </Box>
                      ),
                    },
                    { key: 'cost', header: 'Unit cost', align: 'right', width: 110, render: (row) => <MoneyCell value={row.product.costPrice} /> },
                    { key: 'value', header: 'Value', align: 'right', width: 120, render: (row) => <MoneyCell value={row.value} toneName="info" /> },
                    {
                      key: 'actions',
                      header: '',
                      width: 110,
                      render: (row) =>
                        canAdjust ? (
                          <Button label="Adjust" size="sm" variant="subtle" icon="tune-variant" onPress={() => setAdjusting(row.product.id)} />
                        ) : null,
                    },
                  ]}
                  rows={rows}
                  keyExtractor={(row) => row.product.id}
                />
              </Card>
            )}
          </>
        ) : (
          <Card padded={false}>
            <DataTable
              dense
              columns={[
                {
                  key: 'when',
                  header: 'When',
                  width: 150,
                  render: ({ entry }) => (
                    <Box>
                      <Txt variant="caption">{new Date(entry.occurredAt).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</Txt>
                      <Txt variant="caption" color={palette.textFaint}>
                        {entry.deviceId.slice(-6)}
                      </Txt>
                    </Box>
                  ),
                },
                {
                  key: 'product',
                  header: 'Product',
                  flex: 3,
                  render: ({ product }) => <Txt variant="bodyStrong" numberOfLines={1}>{product?.name ?? 'Unknown product'}</Txt>,
                },
                {
                  key: 'reason',
                  header: 'Reason',
                  flex: 2,
                  render: ({ entry }) => <Badge label={MOVEMENT_LABELS[entry.reason] ?? entry.reason} toneName={entry.quantityDelta > 0 ? 'accent' : 'neutral'} compact />,
                },
                {
                  key: 'delta',
                  header: 'Change',
                  align: 'right',
                  width: 90,
                  render: ({ entry }) => (
                    <Txt variant="money" tabular color={entry.quantityDelta > 0 ? palette.accent : palette.danger}>
                      {entry.quantityDelta > 0 ? '+' : ''}
                      {entry.quantityDelta}
                    </Txt>
                  ),
                },
                {
                  key: 'source',
                  header: 'Source',
                  width: 150,
                  render: ({ entry }) => (
                    <Txt variant="mono" color={palette.textFaint} numberOfLines={1}>
                      {entry.sourceType ? `${entry.sourceType} ${entry.sourceId?.slice(-6) ?? ''}` : '—'}
                    </Txt>
                  ),
                },
              ]}
              rows={ledgerRows}
              keyExtractor={({ entry }) => entry.id}
              empty={<EmptyState icon="history" title="No movements yet" message="Sell something, or record opening stock, and the ledger fills in here." compact />}
            />
          </Card>
        )}
      </Page>

      <AdjustSheet
        productId={adjusting}
        onClose={() => setAdjusting(null)}
        onDone={() => {
          setAdjusting(null);
          snapshot.reload();
        }}
      />
    </View>
  );
}

/* ------------------------------------------------------------------ */

function AdjustSheet({ productId, onClose, onDone }: { productId: string | null; onClose: () => void; onDone: () => void }) {
  const app = useApp();
  const snapshot = useLocalSnapshot();
  const product = snapshot.products.find((candidate) => candidate.id === productId) ?? null;

  const [reason, setReason] = useState<StockMovementReason>('adjustment');
  const [mode, setMode] = useState<'delta' | 'set'>('delta');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const current = product && app.branch ? snapshot.levels.get(movementKey(product.id, null, app.branch.id))?.quantity ?? 0 : 0;
  const parsed = Number(amount) || 0;
  const resulting = mode === 'delta' ? current + parsed : parsed;

  const submit = async () => {
    if (!app.data || !app.business || !app.branch || !app.device || !product) return;
    const delta = mode === 'delta' ? parsed : parsed - current;
    if (delta === 0) {
      app.pushToast({ message: 'Nothing to change', detail: 'A movement of zero is not recorded.', toneName: 'warning' });
      return;
    }

    setBusy(true);
    try {
      const movement = createMovement({
        businessId: app.business.id,
        branchId: app.branch.id,
        productId: product.id,
        variantId: null,
        quantityDelta: delta,
        reason,
        sourceType: 'adjustment',
        unitCost: product.costPrice,
        note: note.trim() || null,
        actorId: app.session?.userId ?? null,
        deviceId: app.device.id,
      });

      const event = {
        id: ulid(),
        businessId: app.business.id,
        branchId: app.branch.id,
        deviceId: app.device.id,
        entity: 'inventory_ledger' as const,
        entityId: movement.id,
        op: 'insert' as const,
        payload: movement as unknown as Record<string, unknown>,
        baseRevision: 0,
        dependsOn: [],
        attempts: 0,
        lastError: null,
        nextAttemptAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        ackedAt: null,
        serverRevision: null,
      };

      // One transaction: the movement, the audit entry and the outbound event.
      await app.data.recordMovements([movement], [event]);

      app.pushToast({
        message: `Stock adjusted by ${delta > 0 ? '+' : ''}${delta}`,
        detail: `${product.name} is now ${resulting}. Recorded as "${MOVEMENT_LABELS[reason]}".`,
        toneName: 'accent',
      });
      void app.engine?.tick();
      onDone();
    } catch (error) {
      app.pushToast({
        message: 'Adjustment failed',
        detail: error instanceof Error ? error.message : undefined,
        toneName: 'danger',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      visible={productId !== null}
      title="Adjust stock"
      subtitle={product ? `${product.name} · ${product.sku}` : ''}
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button label="Cancel" variant="ghost" onPress={onClose} />
          <Button label="Record movement" variant="primary" icon="check" loading={busy} disabled={!amount} onPress={() => void submit()} />
        </>
      }
    >
      <Box gap={spacing.lg}>
        <Box row style={styles.summaryRow}>
          <Box>
            <Txt variant="overline" color={palette.textFaint}>
              CURRENTLY
            </Txt>
            <Txt variant="moneyLg" tabular>
              {current}
            </Txt>
          </Box>
          <Box>
            <Txt variant="overline" color={palette.textFaint}>
              AFTER
            </Txt>
            <Txt variant="moneyLg" tabular color={resulting < 0 ? palette.danger : palette.accent}>
              {resulting}
            </Txt>
          </Box>
        </Box>

        <Box row gap={spacing.sm}>
          <Chip label="Change by" selected={mode === 'delta'} onPress={() => setMode('delta')} icon="plus-minus" />
          <Chip label="Set to" selected={mode === 'set'} onPress={() => setMode('set')} icon="equal" />
        </Box>

        <TextField
          label={mode === 'delta' ? 'Quantity change (use minus for shrinkage)' : 'New counted quantity'}
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          mono
          autoFocus
          placeholder={mode === 'delta' ? '-3' : '25'}
        />

        <Box>
          <Txt variant="label" color={palette.textMuted} style={{ marginBottom: spacing.sm }}>
            Reason (required for the audit trail)
          </Txt>
          <Box row gap={spacing.sm} style={styles.wrap}>
            {MANUAL_ADJUSTMENT_REASONS.map((option) => (
              <Chip key={option} label={MOVEMENT_LABELS[option]} selected={reason === option} onPress={() => setReason(option)} />
            ))}
          </Box>
        </Box>

        <TextField label="Note (optional)" value={note} onChangeText={setNote} placeholder="e.g. 3 bottles broken in transit" />

        <Divider />
        <Txt variant="caption" color={palette.textFaint}>
          This writes a new ledger movement — it never edits an existing one. The adjustment, the actor and the device
          are recorded permanently and uploaded when a connection is available.
        </Txt>
      </Box>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 340 },
  right: { alignItems: 'flex-end', gap: 2 },
  legendRow: { justifyContent: 'space-between' },
  wrap: { flexWrap: 'wrap' },
  summaryRow: { justifyContent: 'space-between', alignItems: 'flex-end' },
});

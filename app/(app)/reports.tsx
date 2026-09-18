import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { formatMoney, type Minor } from '@/domain/money';
import { movementKey } from '@/domain/inventory';
import {
  cashierPerformance,
  grossMargin,
  inventoryMovementByDay,
  lowStock,
  productPerformance,
  resolveRange,
  salesByDay,
  stockValuation,
  summariseSales,
  type PeriodKey,
} from '@/data/analytics';
import { useApp } from '@/state/app';
import { useLocalSnapshot } from '@/state/hooks';
import { Badge, Box, Button, Card, Chip, Divider, KeyValue, Txt, styles as primitives } from '@/ui/primitives';
import { BarChart, DataTable, MoneyCell, StatTile } from '@/ui/patterns';
import { Header, NoticeBar, Page, PageGrid, PermissionDenied, StatGrid } from '@/ui/shell';
import { palette, spacing } from '@/ui/theme';

/**
 * Reports (PRD §25).
 *
 * Every report is computed on the device from the local ledger, so a shop can
 * reconcile its day at closing time whether or not the internet cooperates. Each
 * report exports to CSV — the format an accountant actually wants — rather than
 * a PDF nobody can re-import.
 */
export default function ReportsScreen() {
  const app = useApp();
  const [period, setPeriod] = useState<PeriodKey>('today');
  const [tab, setTab] = useState<'sales' | 'products' | 'staff' | 'stock'>('sales');
  const snapshot = useLocalSnapshot({ saleLimit: 5000, ledgerLimit: 5000 });

  const range = useMemo(() => resolveRange(period), [period]);
  const branchId = app.branch?.id ?? '';
  const quantityFor = useMemo(
    () => (productId: string) => snapshot.levels.get(movementKey(productId, null, branchId))?.quantity ?? 0,
    [snapshot.levels, branchId],
  );

  const summary = useMemo(
    () => summariseSales({ sales: snapshot.sales, payments: snapshot.payments as never, range }),
    [snapshot.sales, snapshot.payments, range],
  );
  const products = useMemo(
    () => productPerformance({ lines: snapshot.saleLines, sales: snapshot.sales, range, limit: 40 }),
    [snapshot.saleLines, snapshot.sales, range],
  );
  const staff = useMemo(() => cashierPerformance(snapshot.sales, range), [snapshot.sales, range]);
  const low = useMemo(() => lowStock({ products: snapshot.products, quantityFor, limit: 40 }), [snapshot.products, quantityFor]);
  const valuation = useMemo(() => stockValuation({ products: snapshot.products, quantityFor }), [snapshot.products, quantityFor]);
  const movement = useMemo(() => inventoryMovementByDay(snapshot.ledger, 14), [snapshot.ledger]);
  const chart = useMemo(() => salesByDay(snapshot.sales, 14), [snapshot.sales]);

  if (!app.can('report.sales')) return <PermissionDenied what="reports" />;

  const exportCsv = (rows: Array<Record<string, string | number>>, filename: string) => {
    if (rows.length === 0) {
      app.pushToast({ message: 'Nothing to export', detail: 'This report is empty for the selected period.', toneName: 'warning' });
      return;
    }
    const headers = Object.keys(rows[0]);
    const csv = [
      headers.join(','),
      ...rows.map((row) => headers.map((header) => JSON.stringify(row[header] ?? '')).join(',')),
    ].join('\n');

    if (typeof globalThis !== 'undefined' && 'document' in globalThis) {
      const url = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
      const anchor = (globalThis as unknown as { document: Document }).document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
    }
    app.pushToast({ message: 'Report exported', detail: `${rows.length} rows · ${filename}`, toneName: 'info' });
  };

  const periodChips = (
    <Box row gap={spacing.xs} style={{ flexWrap: 'wrap' }}>
      {(['today', 'week', 'month', 'quarter', 'all'] as PeriodKey[]).map((key) => (
        <Chip key={key} label={resolveRange(key).label} selected={period === key} onPress={() => setPeriod(key)} />
      ))}
    </Box>
  );

  return (
    <View style={primitives.flex}>
      <Header title="Reports" subtitle={`${range.label} · computed on this device`} actions={periodChips} />

      <Page maxWidth={1400}>
        {!app.syncStatus.cloudConfigured ? (
          <NoticeBar
            toneName="info"
            icon="information-outline"
            title="These reports cover this terminal"
            message="With no cloud project connected, figures reflect sales made here. Once credentials are added, the same reports run across every branch."
          />
        ) : null}

        <Box row gap={spacing.sm} style={{ flexWrap: 'wrap' }}>
          <Chip label="Sales" selected={tab === 'sales'} onPress={() => setTab('sales')} icon="chart-line" />
          <Chip label="Products" selected={tab === 'products'} onPress={() => setTab('products')} icon="package-variant" />
          <Chip label="Cashiers" selected={tab === 'staff'} onPress={() => setTab('staff')} icon="badge-account-outline" />
          <Chip label="Stock" selected={tab === 'stock'} onPress={() => setTab('stock')} icon="warehouse" />
        </Box>

        {tab === 'sales' ? (
          <>
            <StatGrid>
              <StatTile label="Gross sales" value={formatMoney(summary.grossSales, { compact: true })} monetary icon="cash-multiple" toneName="accent" />
              <StatTile label="Net of VAT" value={formatMoney(summary.netSales, { compact: true })} monetary icon="chart-donut" toneName="info" />
              <StatTile label="Transactions" value={String(summary.transactions)} icon="receipt" toneName="violet" hint={`${summary.voidedCount} voided`} />
              <StatTile label="Average basket" value={formatMoney(summary.averageOrderValue, { compact: true })} monetary icon="basket-outline" />
              <StatTile label="Total discounts" value={formatMoney(summary.discountTotal, { compact: true })} monetary icon="percent-outline" toneName="warning" />
              <StatTile label="Gross margin" value={`${(grossMargin(products) * 100).toFixed(1)}%`} icon="trending-up" toneName="accent" hint="Where cost data exists" />
            </StatGrid>

            <PageGrid minWidth={380}>
              <Card style={{ flex: 1, minWidth: 340 }}>
                <Box gap={spacing.md}>
                  <Txt variant="h3">Daily takings</Txt>
                  <BarChart data={chart} height={150} formatValue={(value) => formatMoney(value as Minor, { compact: true })} />
                </Box>
              </Card>
              <Card style={{ flex: 1, minWidth: 340 }}>
                <Box gap={spacing.sm}>
                  <Box row style={{ justifyContent: 'space-between' }}>
                    <Txt variant="h3">Payment methods</Txt>
                    <Button
                      label="Export"
                      size="sm"
                      variant="ghost"
                      icon="download-outline"
                      onPress={() =>
                        exportCsv(
                          summary.paymentBreakdown.map((row) => ({ method: row.method, count: row.count, amount: row.amount / 100 })),
                          'posa-payments.csv',
                        )
                      }
                    />
                  </Box>
                  <Divider />
                  {summary.paymentBreakdown.length === 0 ? (
                    <Txt variant="caption" color={palette.textMuted}>No payments in this period.</Txt>
                  ) : (
                    summary.paymentBreakdown.map((row) => (
                      <KeyValue
                        key={row.method}
                        label={`${row.method.replace(/_/g, ' ')} (${row.count})`}
                        value={formatMoney(row.amount)}
                        mono
                      />
                    ))
                  )}
                  <Divider />
                  <KeyValue label="Cash share of takings" value={`${(summary.cashShare * 100).toFixed(0)}%`} mono emphasis />
                  <Txt variant="caption" color={palette.textFaint}>
                    Cash share is what should reconcile against the drawer at shift close.
                  </Txt>
                </Box>
              </Card>
            </PageGrid>
          </>
        ) : null}

        {tab === 'products' ? (
          <Card padded={false}>
            <Box row style={{ justifyContent: 'space-between', padding: spacing.lg }}>
              <Txt variant="h3">Product performance</Txt>
              <Button
                label="Export CSV"
                size="sm"
                variant="secondary"
                icon="download-outline"
                onPress={() => exportCsv(products.map((row) => ({
                  name: row.name, sku: row.sku, quantity: row.quantity,
                  revenue: row.revenue / 100, cost: row.cost / 100, profit: row.profit / 100,
                })), 'posa-product-sales.csv')}
              />
            </Box>
            <DataTable
              dense
              columns={[
                { key: 'name', header: 'Product', flex: 4, render: (row) => <Txt variant="bodyStrong" numberOfLines={1}>{row.name}</Txt> },
                { key: 'qty', header: 'Sold', align: 'right', width: 80, render: (row) => <Txt variant="moneySm" tabular>{row.quantity}</Txt> },
                { key: 'revenue', header: 'Revenue', align: 'right', width: 120, render: (row) => <MoneyCell value={row.revenue} /> },
                { key: 'cost', header: 'Cost', align: 'right', width: 110, render: (row) => <MoneyCell value={row.cost} /> },
                { key: 'profit', header: 'Profit', align: 'right', width: 110, render: (row) => <MoneyCell value={row.profit} toneName={row.profit >= 0 ? 'accent' : 'danger'} /> },
                { key: 'margin', header: 'Margin', align: 'right', width: 80, render: (row) => <Txt variant="moneySm" tabular color={row.margin > 0.2 ? palette.accent : palette.textSecondary}>{(row.margin * 100).toFixed(0)}%</Txt> },
              ]}
              rows={products}
              keyExtractor={(row) => row.productId}
            />
          </Card>
        ) : null}

        {tab === 'staff' ? (
          <Card padded={false}>
            <Box row style={{ justifyContent: 'space-between', padding: spacing.lg }}>
              <Txt variant="h3">Cashier performance</Txt>
              <Button
                label="Export CSV"
                size="sm"
                variant="secondary"
                icon="download-outline"
                onPress={() => exportCsv(staff.map((row) => ({
                  cashier: app.users.find((user) => user.id === row.cashierId)?.fullName ?? row.cashierId,
                  transactions: row.transactions, sales: row.sales / 100,
                  average: row.averageOrderValue / 100, discounts: row.discounts / 100, voids: row.voids,
                })), 'posa-cashier-report.csv')}
              />
            </Box>
            <DataTable
              dense
              columns={[
                { key: 'name', header: 'Cashier', flex: 3, render: (row) => <Txt variant="bodyStrong">{app.users.find((user) => user.id === row.cashierId)?.fullName ?? row.cashierId.slice(-6)}</Txt> },
                { key: 'tx', header: 'Sales', align: 'right', width: 70, render: (row) => <Txt variant="moneySm" tabular>{row.transactions}</Txt> },
                { key: 'aov', header: 'Avg basket', align: 'right', width: 120, render: (row) => <MoneyCell value={row.averageOrderValue} /> },
                { key: 'disc', header: 'Discounts', align: 'right', width: 120, render: (row) => <MoneyCell value={row.discounts} toneName="warning" /> },
                { key: 'voids', header: 'Voids', align: 'right', width: 70, render: (row) => <Txt variant="moneySm" tabular color={row.voids > 0 ? palette.danger : palette.textMuted}>{row.voids}</Txt> },
                { key: 'total', header: 'Taken', align: 'right', width: 130, render: (row) => <MoneyCell value={row.sales} toneName="accent" /> },
              ]}
              rows={staff}
              keyExtractor={(row) => row.cashierId}
              empty={<Txt variant="caption" color={palette.textMuted}>No activity in this period.</Txt>}
            />
          </Card>
        ) : null}

        {tab === 'stock' ? (
          <>
            <StatGrid>
              <StatTile label="Value at cost" value={formatMoney(valuation.costValue, { compact: true })} monetary icon="warehouse" toneName="info" />
              <StatTile label="Value at retail" value={formatMoney(valuation.retailValue, { compact: true })} monetary icon="tag-outline" toneName="accent" />
              <StatTile label="Units tracked" value={String(Math.round(valuation.units))} icon="cube-outline" />
              <StatTile label="Lines below reorder" value={String(low.length)} icon="alert-outline" toneName={low.length > 0 ? 'warning' : 'accent'} />
            </StatGrid>

            <Card>
              <Box gap={spacing.md}>
                <Txt variant="h3">Inbound vs outbound, last 14 days</Txt>
                <BarChart
                  data={movement.map((row) => ({ label: row.label, value: row.outbound }))}
                  height={140}
                  toneName="danger"
                />
                <Txt variant="caption" color={palette.textMuted}>
                  Outbound units per day. Inbound peaks (deliveries) are visible as gaps in the outbound line.
                </Txt>
              </Box>
            </Card>

            <Card padded={false}>
              <Box row style={{ justifyContent: 'space-between', padding: spacing.lg }}>
                <Txt variant="h3">Restock report</Txt>
                <Button
                  label="Export CSV"
                  size="sm"
                  variant="secondary"
                  icon="download-outline"
                  onPress={() => exportCsv(low.map((row) => ({
                    product: row.product.name, sku: row.product.sku,
                    onHand: row.quantity, order: row.shortfall, cost: row.restockCost / 100,
                  })), 'posa-restock.csv')}
                />
              </Box>
              <DataTable
                dense
                columns={[
                  { key: 'name', header: 'Product', flex: 4, render: (row) => <Txt variant="bodyStrong" numberOfLines={1}>{row.product.name}</Txt> },
                  { key: 'sku', header: 'SKU', flex: 2, render: (row) => <Txt variant="mono" color={palette.textMuted}>{row.product.sku}</Txt> },
                  { key: 'onhand', header: 'On hand', align: 'right', width: 90, render: (row) => <Txt variant="moneySm" tabular color={row.quantity <= 0 ? palette.danger : palette.warning}>{row.quantity}</Txt> },
                  { key: 'order', header: 'Order', align: 'right', width: 80, render: (row) => <Txt variant="moneySm" tabular>{row.shortfall}</Txt> },
                  { key: 'cost', header: 'Cost to restock', align: 'right', width: 140, render: (row) => <MoneyCell value={row.restockCost} toneName="info" /> },
                ]}
                rows={low}
                keyExtractor={(row) => row.product.id}
                empty={<Txt variant="caption" color={palette.textMuted}>Everything is above its reorder level.</Txt>}
              />
            </Card>
          </>
        ) : null}

        <Card>
          <Box gap={spacing.sm}>
            <Box row gap={spacing.sm}>
              <Badge label={range.label} toneName="neutral" />
              <Badge label={app.syncStatus.cloudConfigured ? 'Local + synced' : 'Local only'} toneName={app.syncStatus.cloudConfigured ? 'accent' : 'info'} />
            </Box>
            <Txt variant="caption" color={palette.textMuted}>
              Reports are built from the same append-only ledger the till writes to, so a report and a receipt can never
              disagree. Figures are computed on this device; where a cloud copy exists, the Sync Center shows the
              reconciliation between the two.
            </Txt>
          </Box>
        </Card>
      </Page>
    </View>
  );
}

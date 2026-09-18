import React, { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { formatMoney, type Minor } from "@/domain/money";
import { movementKey } from "@/domain/inventory";
import { ROLE_LABELS } from "@/domain/permissions";
import {
  cashierPerformance,
  lowStock,
  productPerformance,
  resolveRange,
  salesByDay,
  stockValuation,
  summariseSales,
  type PeriodKey,
} from "@/data/analytics";
import { useApp } from "@/state/app";
import { useLocalSnapshot } from "@/state/hooks";
import {
  Badge,
  Box,
  Button,
  Card,
  Chip,
  EmptyState,
  Money,
  Txt,
  styles as primitives,
} from "@/ui/primitives";
import { BarChart, DataTable, MoneyCell, StatTile } from "@/ui/patterns";
import {
  Header,
  NoticeBar,
  Page,
  PageGrid,
  StatGrid,
  relativeTime,
} from "@/ui/shell";
import { palette, spacing } from "@/ui/theme";

/**
 * The dashboard.
 *
 * Ordered by the question an owner actually asks when they open it: "have we made
 * money today, is anything about to run out, and is my data safe?" Everything
 * below the fold serves one of those three.
 *
 * Note the provenance labels. Every figure says whether it came from this device
 * or from the cloud, because PRD §24 requires it and because a shopkeeper
 * deserves to know when a number is partial.
 */
export default function DashboardScreen() {
  const router = useRouter();
  const app = useApp();
  const [period, setPeriod] = useState<PeriodKey>("today");
  const snapshot = useLocalSnapshot({ saleLimit: 3000 });

  const range = useMemo(() => resolveRange(period), [period]);

  const summary = useMemo(
    () =>
      summariseSales({
        sales: snapshot.sales,
        payments: snapshot.payments as never,
        range,
      }),
    [snapshot.sales, snapshot.payments, range],
  );

  const chart = useMemo(() => salesByDay(snapshot.sales, 7), [snapshot.sales]);

  const quantityFor = useMemo(() => {
    const branchId = app.branch?.id ?? "";
    return (productId: string) =>
      snapshot.levels.get(movementKey(productId, null, branchId))?.quantity ??
      0;
  }, [snapshot.levels, app.branch?.id]);

  const low = useMemo(
    () => lowStock({ products: snapshot.products, quantityFor, limit: 8 }),
    [snapshot.products, quantityFor],
  );

  const valuation = useMemo(
    () => stockValuation({ products: snapshot.products, quantityFor }),
    [snapshot.products, quantityFor],
  );

  const topProducts = useMemo(
    () =>
      productPerformance({
        lines: snapshot.saleLines,
        sales: snapshot.sales,
        range,
        limit: 6,
      }),
    [snapshot.saleLines, snapshot.sales, range],
  );

  const cashiers = useMemo(
    () => cashierPerformance(snapshot.sales, range),
    [snapshot.sales, range],
  );

  const recent = useMemo(() => snapshot.sales.slice(0, 8), [snapshot.sales]);

  const userName = (id: string) =>
    app.users.find((user) => user.id === id)?.fullName ?? id.slice(-6);

  if (snapshot.loading) {
    return (
      <>
        <Header title="Dashboard" subtitle="Reading local records…" />
        <Page>
          <Box gap={spacing.md}>
            {[0, 1, 2].map((key) => (
              <View key={key} style={styles.skeleton} />
            ))}
          </Box>
        </Page>
      </>
    );
  }

  return (
    <View style={primitives.flex}>
      <Header
        title="Dashboard"
        subtitle={`${ROLE_LABELS[app.session?.role ?? "cashier"]} · ${app.branch?.name ?? ""}`}
        actions={
          <Box row gap={spacing.xs}>
            {(["today", "week", "month"] as PeriodKey[]).map((key) => (
              <Chip
                key={key}
                label={
                  key === "today"
                    ? "Today"
                    : key === "week"
                      ? "7 days"
                      : "30 days"
                }
                selected={period === key}
                onPress={() => setPeriod(key)}
              />
            ))}
          </Box>
        }
      />

      <Page>
        {!app.syncStatus.cloudConfigured ? (
          <NoticeBar
            toneName="info"
            icon="harddisk"
            title="These figures come from this terminal only"
            message={`No cloud project is connected, so nothing has been merged from other devices or branches. ${
              snapshot.sales.length
            } sale${snapshot.sales.length === 1 ? "" : "s"} are on this device and all of them are safe.`}
            action={
              <Button
                label="Sync Center"
                size="sm"
                variant="subtle"
                iconRight="chevron-right"
                onPress={() => router.push("/(app)/sync" as never)}
              />
            }
          />
        ) : app.syncStatus.pending > 0 ? (
          <NoticeBar
            toneName="warning"
            icon="cloud-upload-outline"
            title={`${app.syncStatus.pending} change${app.syncStatus.pending === 1 ? "" : "s"} waiting to upload`}
            message={`Local figures may be ahead of the cloud. Last sync ${relativeTime(app.syncStatus.lastSyncAt)}.`}
            action={
              <Button
                label="Sync now"
                size="sm"
                variant="subtle"
                onPress={() => void app.syncNow()}
              />
            }
          />
        ) : null}

        <StatGrid>
          <StatTile
            label={`${range.label} sales`}
            value={formatMoney(summary.grossSales, { compact: true })}
            monetary
            icon="cash-multiple"
            toneName="accent"
            hint={`${summary.transactions} transaction${summary.transactions === 1 ? "" : "s"}`}
          />
          <StatTile
            label="Average basket"
            value={formatMoney(summary.averageOrderValue, { compact: true })}
            monetary
            icon="basket-outline"
            toneName="info"
            hint={`${summary.itemCount} items sold`}
          />
          <StatTile
            label="VAT collected"
            value={formatMoney(summary.taxTotal, { compact: true })}
            monetary
            icon="receipt-text-outline"
            toneName="violet"
            hint="Tax on completed sales"
          />
          <StatTile
            label="Discounts given"
            value={formatMoney(summary.discountTotal, { compact: true })}
            monetary
            icon="percent-outline"
            toneName={summary.discountTotal > 0 ? "warning" : "neutral"}
            hint={
              summary.grossSales > 0
                ? `${((summary.discountTotal / (summary.grossSales + summary.discountTotal)) * 100).toFixed(1)}% of gross`
                : "—"
            }
          />
        </StatGrid>

        <PageGrid minWidth={380}>
          <Card style={styles.grow}>
            <Box gap={spacing.md}>
              <Box row style={styles.cardTitleRow}>
                <Box>
                  <Txt variant="h3">Sales, last 7 days</Txt>
                  <Txt variant="caption" color={palette.textMuted}>
                    Local records only
                  </Txt>
                </Box>
                <Badge label={range.label} toneName="neutral" />
              </Box>
              <BarChart
                data={chart.map((datum) => ({
                  ...datum,
                  value: datum.value as number,
                }))}
                height={140}
                formatValue={(value) =>
                  formatMoney(value as Minor, { compact: true })
                }
              />
            </Box>
          </Card>

          <Card style={styles.grow}>
            <Box gap={spacing.md}>
              <Box row style={styles.cardTitleRow}>
                <Box>
                  <Txt variant="h3">Stock on hand</Txt>
                  <Txt variant="caption" color={palette.textMuted}>
                    Valued at cost, this branch
                  </Txt>
                </Box>
                <Button
                  label="Inventory"
                  size="sm"
                  variant="ghost"
                  iconRight="chevron-right"
                  onPress={() => router.push("/(app)/inventory" as never)}
                />
              </Box>
              <Box gap={spacing.sm}>
                <Box row style={styles.kpiRow}>
                  <Txt variant="body" color={palette.textMuted}>
                    Retail value
                  </Txt>
                  <Money
                    value={valuation.retailValue}
                    variant="moneyLg"
                    color={palette.accent}
                  />
                </Box>
                <Box row style={styles.kpiRow}>
                  <Txt variant="body" color={palette.textMuted}>
                    At cost
                  </Txt>
                  <Money value={valuation.costValue} variant="money" />
                </Box>
                <Box row style={styles.kpiRow}>
                  <Txt variant="body" color={palette.textMuted}>
                    Potential profit
                  </Txt>
                  <Money
                    value={valuation.potentialProfit}
                    variant="money"
                    color={palette.info}
                  />
                </Box>
                <Box row style={styles.kpiRow}>
                  <Txt variant="body" color={palette.textMuted}>
                    Units tracked
                  </Txt>
                  <Txt variant="money" tabular>
                    {Math.round(valuation.units).toString()}
                  </Txt>
                </Box>
              </Box>
            </Box>
          </Card>
        </PageGrid>

        <PageGrid minWidth={420}>
          <Card style={styles.grow} padded={false}>
            <Box padding={spacing.lg} gap={spacing.md}>
              <Box row style={styles.cardTitleRow}>
                <Box>
                  <Txt variant="h3">Needs restocking</Txt>
                  <Txt variant="caption" color={palette.textMuted}>
                    At or below the reorder level
                  </Txt>
                </Box>
                <Badge
                  label={String(low.length)}
                  toneName={low.length > 0 ? "warning" : "accent"}
                />
              </Box>
            </Box>
            {low.length === 0 ? (
              <EmptyState
                icon="check-circle-outline"
                title="Nothing is low"
                message="Every tracked product is above its reorder level."
                compact
              />
            ) : (
              <DataTable
                dense
                columns={[
                  {
                    key: "name",
                    header: "Product",
                    flex: 3,
                    render: (row) => (
                      <Box>
                        <Txt variant="bodyStrong" numberOfLines={1}>
                          {row.product.name}
                        </Txt>
                        <Txt variant="caption" color={palette.textFaint}>
                          {row.product.sku}
                        </Txt>
                      </Box>
                    ),
                  },
                  {
                    key: "stock",
                    header: "On hand",
                    align: "right",
                    width: 80,
                    render: (row) => (
                      <Txt
                        variant="moneySm"
                        color={
                          row.quantity <= 0 ? palette.danger : palette.warning
                        }
                        tabular
                      >
                        {row.quantity}
                      </Txt>
                    ),
                  },
                  {
                    key: "order",
                    header: "Order",
                    align: "right",
                    width: 70,
                    render: (row) => (
                      <Txt variant="moneySm" tabular>
                        {row.shortfall}
                      </Txt>
                    ),
                  },
                  {
                    key: "cost",
                    header: "Cost",
                    align: "right",
                    width: 100,
                    render: (row) => <MoneyCell value={row.restockCost} />,
                  },
                ]}
                rows={low}
                keyExtractor={(row) => row.product.id}
                onRowPress={(row) => router.push("/(app)/inventory" as never)}
              />
            )}
          </Card>

          <Card style={styles.grow} padded={false}>
            <Box padding={spacing.lg} gap={spacing.md}>
              <Box row style={styles.cardTitleRow}>
                <Box>
                  <Txt variant="h3">Recent sales</Txt>
                  <Txt variant="caption" color={palette.textMuted}>
                    Newest first, from this device
                  </Txt>
                </Box>
                <Button
                  label="All sales"
                  size="sm"
                  variant="ghost"
                  iconRight="chevron-right"
                  onPress={() => router.push("/(app)/returns" as never)}
                />
              </Box>
            </Box>
            {recent.length === 0 ? (
              <EmptyState
                icon="point-of-sale"
                title="No sales yet"
                message="Complete a sale on the Checkout screen and it appears here immediately — no internet needed."
                compact
                action={
                  <Button
                    label="Go to checkout"
                    variant="primary"
                    icon="point-of-sale"
                    onPress={() => router.push("/(app)/checkout" as never)}
                  />
                }
              />
            ) : (
              <DataTable
                dense
                columns={[
                  {
                    key: "receipt",
                    header: "Receipt",
                    flex: 2,
                    render: (sale) => (
                      <Box>
                        <Txt variant="mono" numberOfLines={1}>
                          {sale.receiptNumber}
                        </Txt>
                        <Txt variant="caption" color={palette.textFaint}>
                          {userName(sale.cashierId)} ·{" "}
                          {new Date(sale.committedAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </Txt>
                      </Box>
                    ),
                  },
                  {
                    key: "items",
                    header: "Items",
                    align: "right",
                    width: 60,
                    render: (sale) => (
                      <Txt variant="moneySm" tabular>
                        {sale.itemCount}
                      </Txt>
                    ),
                  },
                  {
                    key: "status",
                    header: "Status",
                    width: 110,
                    render: (sale) => (
                      <Badge
                        label={sale.status.replace(/_/g, " ")}
                        toneName={
                          sale.status === "voided"
                            ? "danger"
                            : sale.status === "committed"
                              ? "accent"
                              : "warning"
                        }
                        compact
                      />
                    ),
                  },
                  {
                    key: "total",
                    header: "Total",
                    align: "right",
                    width: 110,
                    render: (sale) => <MoneyCell value={sale.total} />,
                  },
                ]}
                rows={recent}
                keyExtractor={(sale) => sale.id}
              />
            )}
          </Card>
        </PageGrid>

        <PageGrid minWidth={420}>
          <Card style={styles.grow} padded={false}>
            <Box padding={spacing.lg}>
              <Txt variant="h3">Top sellers</Txt>
              <Txt variant="caption" color={palette.textMuted}>
                {range.label} · ranked by revenue
              </Txt>
            </Box>
            {topProducts.length === 0 ? (
              <EmptyState
                icon="chart-line"
                title="No sales in this period"
                compact
              />
            ) : (
              <DataTable
                dense
                columns={[
                  {
                    key: "name",
                    header: "Product",
                    flex: 4,
                    render: (row) => (
                      <Txt variant="bodyStrong" numberOfLines={1}>
                        {row.name}
                      </Txt>
                    ),
                  },
                  {
                    key: "qty",
                    header: "Sold",
                    align: "right",
                    width: 64,
                    render: (row) => (
                      <Txt variant="moneySm" tabular>
                        {row.quantity}
                      </Txt>
                    ),
                  },
                  {
                    key: "revenue",
                    header: "Revenue",
                    align: "right",
                    width: 110,
                    render: (row) => <MoneyCell value={row.revenue} />,
                  },
                  {
                    key: "margin",
                    header: "Margin",
                    align: "right",
                    width: 80,
                    render: (row) => (
                      <Txt
                        variant="moneySm"
                        color={
                          row.margin > 0.25
                            ? palette.accent
                            : palette.textSecondary
                        }
                        tabular
                      >
                        {(row.margin * 100).toFixed(0)}%
                      </Txt>
                    ),
                  },
                ]}
                rows={topProducts}
                keyExtractor={(row) => row.productId}
              />
            )}
          </Card>

          <Card style={styles.grow} padded={false}>
            <Box padding={spacing.lg}>
              <Txt variant="h3">By cashier</Txt>
              <Txt variant="caption" color={palette.textMuted}>
                {range.label}
              </Txt>
            </Box>
            {cashiers.length === 0 ? (
              <EmptyState
                icon="account-group-outline"
                title="No activity yet"
                compact
              />
            ) : (
              <DataTable
                dense
                columns={[
                  {
                    key: "name",
                    header: "Cashier",
                    flex: 3,
                    render: (row) => (
                      <Txt variant="bodyStrong">{userName(row.cashierId)}</Txt>
                    ),
                  },
                  {
                    key: "tx",
                    header: "Sales",
                    align: "right",
                    width: 60,
                    render: (row) => (
                      <Txt variant="moneySm" tabular>
                        {row.transactions}
                      </Txt>
                    ),
                  },
                  {
                    key: "voids",
                    header: "Voids",
                    align: "right",
                    width: 60,
                    render: (row) => (
                      <Txt
                        variant="moneySm"
                        color={
                          row.voids > 0 ? palette.danger : palette.textMuted
                        }
                        tabular
                      >
                        {row.voids}
                      </Txt>
                    ),
                  },
                  {
                    key: "total",
                    header: "Taken",
                    align: "right",
                    width: 110,
                    render: (row) => <MoneyCell value={row.sales} />,
                  },
                ]}
                rows={cashiers}
                keyExtractor={(row) => row.cashierId}
              />
            )}
          </Card>
        </PageGrid>
      </Page>
    </View>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 340 },
  cardTitleRow: { justifyContent: "space-between", alignItems: "flex-start" },
  kpiRow: { justifyContent: "space-between", alignItems: "baseline" },
  skeleton: { height: 96, borderRadius: 14, backgroundColor: palette.surface },
});

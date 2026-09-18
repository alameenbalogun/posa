import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { formatMoney, parseMoney, scale, ZERO, type Minor } from '@/domain/money';
import { ulid } from '@/domain/ulid';
import type { Purchase, PurchaseLine, Supplier } from '@/domain/types';
import { outboxEvent, receivePurchase, type MutationContext } from '@/data/mutations';
import { useApp } from '@/state/app';
import { useLocalSnapshot } from '@/state/hooks';
import {
  Badge,
  Box,
  Button,
  Card,
  Chip,
  Divider,
  EmptyState,
  IconButton,
  Money,
  SearchField,
  TextField,
  Txt,
  styles as primitives,
} from '@/ui/primitives';
import { MoneyCell, Sheet } from '@/ui/patterns';
import { Header, NoticeBar, Page, PermissionDenied, relativeTime } from '@/ui/shell';
import { palette, spacing } from '@/ui/theme';

/**
 * Purchases and receiving (PRD §15).
 *
 * The important half of this screen is receiving, because receiving is the only
 * thing that moves stock. Two rules are enforced here:
 *
 *  - Receiving posts inventory ledger movements with the UNIT COST you actually
 *    paid. That cost is what weighted-average valuation and gross profit are
 *    built on later, so it cannot be reconstructed from a purchase total.
 *  - Partial deliveries are normal, not an error. A supplier bringing 8 of 10
 *    cartons leaves the order `partially_received`; the shortfall stays visible
 *    instead of being silently closed.
 */
export default function PurchasesScreen() {
  const app = useApp();
  const snapshot = useLocalSnapshot({ ledgerLimit: 200 });
  const [orders, setOrders] = useState<Purchase[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [newOpen, setNewOpen] = useState(false);
  const [receiving, setReceiving] = useState<Purchase | null>(null);

  const reload = React.useCallback(async () => {
    if (!app.data) return;
    setLoading(true);
    const [list, supplierList] = await Promise.all([app.data.listPurchases(200), app.data.listSuppliers()]);
    setOrders(list);
    setSuppliers(supplierList);
    setLoading(false);
  }, [app.data]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  const open = useMemo(() => orders.filter((order) => order.status !== 'received' && order.status !== 'cancelled'), [orders]);
  const outstanding = open.reduce((total, order) => total + (order.total - order.amountPaid), 0) as Minor;

  if (!app.can('purchase.create') && !app.can('report.inventory')) return <PermissionDenied what="purchases" />;

  const supplierName = (id: string) => suppliers.find((supplier) => supplier.id === id)?.name ?? 'Unknown supplier';

  return (
    <View style={primitives.flex}>
      <Header
        title="Purchases"
        subtitle={`${open.length} open · ${orders.length} total`}
        actions={
          app.can('purchase.create') ? (
            <Button label="New purchase order" size="sm" variant="primary" icon="plus" onPress={() => setNewOpen(true)} />
          ) : null
        }
      />

      <Page maxWidth={1400}>
        <NoticeBar
          toneName="info"
          icon="truck-delivery-outline"
          title="Receiving is what moves stock"
          message="A purchase order on its own changes nothing. Receiving it writes ledger movements at the cost you paid — that is what makes your stock valuation and gross profit real numbers."
        />

        {loading ? (
          <Card>
            <Txt variant="body" color={palette.textMuted}>
              Reading local records…
            </Txt>
          </Card>
        ) : orders.length === 0 ? (
          <EmptyState
            icon="clipboard-text-outline"
            title="No purchase orders yet"
            message="Record what you ordered, then receive it when it arrives. Partial deliveries are supported — the shortfall stays visible on the order."
          />
        ) : (
          <Card padded={false}>
            <Box row gap={spacing.md} style={styles.row}>
              <Txt variant="overline" color={palette.textFaint} style={primitives.flex}>
                REFERENCE / SUPPLIER
              </Txt>
              <Txt variant="overline" color={palette.textFaint} style={styles.statusColumn}>
                STATUS
              </Txt>
              <Txt variant="overline" color={palette.textFaint} style={styles.moneyColumn}>
                TOTAL
              </Txt>
              <Box style={styles.actionColumn} />
            </Box>

            {orders.map((order) => {
              const receivedUnits = order.lines.reduce((total, line) => total + line.receivedQuantity, 0);
              const orderedUnits = order.lines.reduce((total, line) => total + line.quantity, 0);
              const complete = order.status === 'received';
              return (
                <Box key={order.id} row gap={spacing.md} style={styles.dataRow}>
                  <Box style={primitives.flex}>
                    <Txt variant="bodyStrong" numberOfLines={1}>
                      {order.reference}
                    </Txt>
                    <Txt variant="caption" color={palette.textFaint} numberOfLines={1}>
                      {supplierName(order.supplierId)} · {receivedUnits}/{orderedUnits} units received ·{' '}
                      {relativeTime(order.createdAt)}
                    </Txt>
                  </Box>
                  <Box style={styles.statusColumn}>
                    <Badge
                      label={order.status.replace('_', ' ')}
                      toneName={complete ? 'accent' : order.status === 'cancelled' ? 'neutral' : 'warning'}
                      compact
                    />
                  </Box>
                  <Box style={styles.moneyColumn}>
                    <MoneyCell value={order.total} />
                    {order.amountPaid < order.total ? (
                      <Txt variant="caption" color={palette.warning}>
                        {formatMoney((order.total - order.amountPaid) as Minor, { compact: true })} unpaid
                      </Txt>
                    ) : null}
                  </Box>
                  <Box row gap={spacing.xs} style={styles.actionColumn}>
                    {app.can('purchase.receive') && !complete && order.status !== 'cancelled' ? (
                      <Button label="Receive" size="sm" variant="secondary" icon="truck-check-outline" onPress={() => setReceiving(order)} />
                    ) : (
                      <IconButton icon="check-circle-outline" label="Nothing outstanding" size={30} disabled onPress={() => undefined} />
                    )}
                  </Box>
                </Box>
              );
            })}
          </Card>
        )}

        {open.length > 0 ? (
          <Card toneName="warning">
            <Box gap={spacing.xs}>
              <Txt variant="label" color={palette.warning}>
                OUTSTANDING
              </Txt>
              <Txt variant="body" color={palette.textSecondary}>
                {open.length} open order{open.length === 1 ? '' : 's'} with{' '}
                <Txt variant="bodyStrong">{formatMoney(outstanding)}</Txt> not yet paid.
              </Txt>
            </Box>
          </Card>
        ) : null}
      </Page>

      <NewPurchaseSheet
        visible={newOpen}
        suppliers={suppliers}
        onClose={() => setNewOpen(false)}
        onSaved={async () => {
          setNewOpen(false);
          await reload();
          snapshot.reload();
        }}
      />

      <ReceiveSheet
        purchase={receiving}
        onClose={() => setReceiving(null)}
        onSaved={async () => {
          setReceiving(null);
          await reload();
          snapshot.reload();
        }}
      />
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Create a purchase order                                             */
/* ------------------------------------------------------------------ */

function NewPurchaseSheet({
  visible,
  suppliers,
  onClose,
  onSaved,
}: {
  visible: boolean;
  suppliers: Supplier[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const app = useApp();
  const snapshot = useLocalSnapshot({ ledgerLimit: 50 });
  const [supplierText, setSupplierText] = useState('');
  const [reference, setReference] = useState('');
  const [query, setQuery] = useState('');
  const [draftLines, setDraftLines] = useState<PurchaseLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  React.useEffect(() => {
    if (!visible) return;
    setSupplierText('');
    setReference('');
    setQuery('');
    setDraftLines([]);
    setError(null);
  }, [visible]);

  const results = useMemo(() => (app.data ? app.data.search(query, 8) : []), [app.data, query]);
  const total = draftLines.reduce((sum, line) => sum + line.lineTotal, 0) as Minor;

  const addLine = (productId: string, name: string, unitCost: Minor) => {
    setDraftLines((current) => [
      ...current,
      {
        id: ulid(),
        purchaseId: '',
        productId,
        variantId: null,
        name,
        quantity: 1,
        receivedQuantity: 0,
        unitCost,
        lineTotal: unitCost,
      },
    ]);
    setQuery('');
  };

  const save = async () => {
    const { data, business, branch, device, session } = app;
    if (!data || !business || !branch || !device) return;
    if (!supplierText.trim()) {
      setError('Name the supplier — a purchase order without one cannot be reconciled.');
      return;
    }
    if (draftLines.length === 0) {
      setError('Add at least one product line.');
      return;
    }

    setBusy(true);
    try {
      let supplier = suppliers.find((candidate) => candidate.name.toLowerCase() === supplierText.trim().toLowerCase());
      if (!supplier) {
        supplier = {
          id: ulid(),
          businessId: business.id,
          name: supplierText.trim(),
          contactName: null,
          phone: null,
          email: null,
          address: null,
          balance: ZERO,
          status: 'active',
          createdAt: new Date().toISOString(),
        };
        const supplierEvent = outboxEvent({
          businessId: business.id,
          branchId: branch.id,
          deviceId: device.id,
          entity: 'supplier',
          entityId: supplier.id,
          payload: supplier,
        });
        await data.store.transaction(async (tx) => {
          await tx.put('suppliers', supplier as never);
          await tx.enqueue([supplierEvent]);
        });
      }

      const purchaseId = ulid();
      const purchase: Purchase = {
        id: purchaseId,
        businessId: business.id,
        branchId: branch.id,
        supplierId: supplier.id,
        reference: reference.trim() || `PO-${purchaseId.slice(-6).toUpperCase()}`,
        status: 'ordered',
        lines: draftLines.map((line) => ({ ...line, purchaseId })),
        subtotal: total,
        taxTotal: ZERO,
        total,
        amountPaid: ZERO,
        expectedAt: null,
        receivedAt: null,
        createdBy: session?.userId ?? device.id,
        createdAt: new Date().toISOString(),
        note: null,
      };

      const event = outboxEvent({
        businessId: business.id,
        branchId: branch.id,
        deviceId: device.id,
        entity: 'purchase',
        entityId: purchase.id,
        payload: purchase,
      });

      await data.store.transaction(async (tx) => {
        await tx.put('purchases', purchase as never);
        await tx.enqueue([event]);
      });

      app.pushToast({
        message: 'Purchase order saved',
        detail: `${purchase.reference} · ${formatMoney(total)} · ${purchase.lines.length} line${purchase.lines.length === 1 ? '' : 's'}`,
        toneName: 'accent',
      });
      void app.engine?.tick();
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the order.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      visible={visible}
      title="New purchase order"
      subtitle="What you ordered and what you expect to pay"
      onClose={onClose}
      width={680}
      footer={
        <>
          <Button label="Cancel" variant="ghost" onPress={onClose} />
          <Button label="Save order" variant="primary" loading={busy} icon="content-save-outline" onPress={() => void save()} />
        </>
      }
    >
      <Box gap={spacing.lg}>
        <Box row gap={spacing.md}>
          <TextField
            label="Supplier"
            value={supplierText}
            onChangeText={setSupplierText}
            placeholder="Type a new name, or pick an existing supplier"
            style={primitives.flex}
            autoFocus
          />
          <TextField label="Reference" value={reference} onChangeText={setReference} placeholder="Optional invoice no." style={primitives.flex} />
        </Box>

        {suppliers.length > 0 ? (
          <Box row gap={spacing.xs} style={styles.wrap}>
            {suppliers.slice(0, 6).map((supplier) => (
              <Chip key={supplier.id} label={supplier.name} selected={supplierText === supplier.name} onPress={() => setSupplierText(supplier.name)} />
            ))}
          </Box>
        ) : null}

        <Divider />

        <SearchField value={query} onChangeText={setQuery} placeholder="Search a product to add a line" />
        {query.trim().length > 0 ? (
          <Card padded={false}>
            {results.length === 0 ? (
              <Box style={{ padding: spacing.md }}>
                <Txt variant="caption" color={palette.textMuted}>
                  No product matches that. Create it in Products first so receiving can identify it by SKU.
                </Txt>
              </Box>
            ) : (
              results.map((row) => (
                <Box key={row.product.id} row gap={spacing.md} style={styles.resultRow}>
                  <Box style={primitives.flex}>
                    <Txt variant="bodyStrong" numberOfLines={1}>
                      {row.product.name}
                    </Txt>
                    <Txt variant="caption" color={palette.textFaint}>
                      {row.product.sku} · last cost {formatMoney(row.product.costPrice, { compact: true })}
                    </Txt>
                  </Box>
                  <Button label="Add" size="sm" variant="subtle" onPress={() => addLine(row.product.id, row.product.name, row.product.costPrice)} />
                </Box>
              ))
            )}
          </Card>
        ) : null}

        {draftLines.length > 0 ? (
          <Card padded={false}>
            {draftLines.map((line) => (
              <Box key={line.id} row gap={spacing.sm} style={styles.resultRow}>
                <Box style={primitives.flex}>
                  <Txt variant="bodyStrong" numberOfLines={1}>
                    {line.name}
                  </Txt>
                  <Txt variant="caption" color={palette.textFaint}>
                    {line.quantity} × {formatMoney(line.unitCost)}
                  </Txt>
                </Box>
                <IconButton
                  icon="minus"
                  label="Reduce quantity"
                  size={28}
                  onPress={() =>
                    setDraftLines((current) =>
                      current.map((candidate) =>
                        candidate.id === line.id
                          ? {
                              ...candidate,
                              quantity: Math.max(1, candidate.quantity - 1),
                              lineTotal: scale(candidate.unitCost, Math.max(1, candidate.quantity - 1)),
                            }
                          : candidate,
                      ),
                    )
                  }
                />
                <IconButton
                  icon="plus"
                  label="Increase quantity"
                  size={28}
                  onPress={() =>
                    setDraftLines((current) =>
                      current.map((candidate) =>
                        candidate.id === line.id
                          ? {
                              ...candidate,
                              quantity: candidate.quantity + 1,
                              lineTotal: scale(candidate.unitCost, candidate.quantity + 1),
                            }
                          : candidate,
                      ),
                    )
                  }
                />
                <Box style={styles.moneyColumn}>
                  <MoneyCell value={line.lineTotal} />
                </Box>
                <IconButton icon="trash-can-outline" label={`Remove ${line.name}`} size={28} onPress={() => setDraftLines((current) => current.filter((candidate) => candidate.id !== line.id))} />
              </Box>
            ))}
          </Card>
        ) : (
          <Txt variant="caption" color={palette.textFaint}>
            Add lines by searching above. Untracked products — anything you have not created — cannot be received into
            stock, because stock is tracked per product.
          </Txt>
        )}

        {error ? (
          <Txt variant="caption" color={palette.warning}>
            {error}
          </Txt>
        ) : null}

        <Box row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <Txt variant="label" color={palette.textMuted}>
            Order total
          </Txt>
          <Money value={total} />
        </Box>
        <Txt variant="caption" color={palette.textFaint}>
          {snapshot.products.length} products on this terminal are available to order.
        </Txt>
      </Box>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ */
/* Receive                                                             */
/* ------------------------------------------------------------------ */

function ReceiveSheet({
  purchase,
  onClose,
  onSaved,
}: {
  purchase: Purchase | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const app = useApp();
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  React.useEffect(() => {
    if (!purchase) return;
    // Default to "everything arrived", because that is the common case. Editing
    // down is faster than adding up.
    const defaults: Record<string, string> = {};
    for (const line of purchase.lines) {
      const outstanding = Math.max(0, line.quantity - line.receivedQuantity);
      defaults[line.id] = outstanding > 0 ? String(outstanding) : '0';
    }
    setQuantities(defaults);
    setError(null);
  }, [purchase]);

  if (!purchase) return null;

  const submit = async () => {
    const { data, business, branch, device, session } = app;
    if (!data || !business || !branch || !device) return;

    const received = purchase.lines
      .map((line) => ({ lineId: line.id, quantity: Math.max(0, Math.floor(Number(quantities[line.id] ?? '0') || 0)) }))
      .filter((entry) => entry.quantity > 0);

    if (received.length === 0) {
      setError('Nothing to receive — every quantity is zero.');
      return;
    }

    setBusy(true);
    try {
      const ctx: MutationContext = {
        data,
        businessId: business.id,
        branchId: branch.id,
        deviceId: device.id,
        actorId: session?.userId ?? null,
        actorName: session?.fullName ?? '',
      };

      const result = await receivePurchase(ctx, purchase, received);
      const units = result.movements.reduce((total, movement) => total + movement.quantityDelta, 0);

      app.pushToast({
        message: result.purchase.status === 'received' ? 'Order fully received' : 'Part delivered',
        detail: `${units} unit${units === 1 ? '' : 's'} added to stock at ${formatMoney(
          result.movements.reduce((total, movement) => total + (movement.unitCost ?? 0), 0) as Minor,
        )} total cost. The remainder stays on the order.`,
        toneName: 'accent',
        durationMs: 7000,
      });
      void app.engine?.tick();
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not receive the order.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      visible
      title={`Receive ${purchase.reference}`}
      subtitle="Enter what actually arrived — partial deliveries are fine"
      onClose={onClose}
      width={680}
      footer={
        <>
          <Button label="Cancel" variant="ghost" onPress={onClose} />
          <Button label="Receive into stock" variant="primary" icon="truck-check-outline" loading={busy} onPress={() => void submit()} />
        </>
      }
    >
      <Box gap={spacing.lg}>
        {purchase.lines.map((line) => {
          const outstanding = Math.max(0, line.quantity - line.receivedQuantity);
          return (
            <Box key={line.id} row gap={spacing.md} style={{ alignItems: 'flex-end' }}>
              <Box style={primitives.flex}>
                <Txt variant="bodyStrong" numberOfLines={1}>
                  {line.name}
                </Txt>
                <Txt variant="caption" color={palette.textFaint}>
                  Ordered {line.quantity} · already received {line.receivedQuantity} · outstanding {outstanding} ·{' '}
                  {formatMoney(line.unitCost)} each
                </Txt>
              </Box>
              <Box style={{ width: 130 }}>
                <TextField
                  label="Received now"
                  value={quantities[line.id] ?? ''}
                  onChangeText={(value) => setQuantities((current) => ({ ...current, [line.id]: value.replace(/[^0-9]/g, '') }))}
                  keyboardType="numeric"
                  mono
                  editable={outstanding > 0}
                  hint={outstanding === 0 ? 'Complete' : undefined}
                />
              </Box>
            </Box>
          );
        })}

        {error ? (
          <Txt variant="caption" color={palette.warning}>
            {error}
          </Txt>
        ) : null}

        <Txt variant="caption" color={palette.textFaint}>
          The cost on each line becomes the unit cost of the ledger movement, which is what weighted-average valuation
          and gross profit are calculated from. If the invoice price differs, correct it here rather than in your head.
        </Txt>
      </Box>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  wrap: { flexWrap: 'wrap' },
  row: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: palette.border, alignItems: 'center' },
  dataRow: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: palette.border, alignItems: 'center' },
  resultRow: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: palette.border, alignItems: 'center' },
  statusColumn: { width: 130 },
  moneyColumn: { width: 130, alignItems: 'flex-end' },
  actionColumn: { width: 150, alignItems: 'flex-end' },
});

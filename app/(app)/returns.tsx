import React, { useState } from 'react';
import { formatMoney, type Minor } from '@/domain/money';
import { parseReceiptNumber } from '@/domain/sale';
import { parseReceiptQr, computeRefund, buildReturn } from '@/domain/returns';
import { can } from '@/domain/permissions';
import type { ReturnReason, Sale, SaleLine } from '@/domain/types';
import { useApp } from '@/state/app';
import { useAsync } from '@/state/hooks';
import { Badge, Box, Button, Card, Divider, KeyValue, TextField, Txt, styles as primitives } from '@/ui/primitives';
import { MoneyCell, Sheet } from '@/ui/patterns';
import { NoticeBar, PermissionDenied } from '@/ui/shell';
import { RecordListPage } from '@/ui/record-page';
import { palette, spacing } from '@/ui/theme';

/**
 * Sales history and returns (PRD §17).
 *
 * Returns are computed from the ORIGINAL sale's line snapshots, never from
 * today's price — re-pricing a refund would let a shop quietly refund the new
 * higher price for something bought on promotion, and would make the VAT
 * reversal wrong.
 *
 * Lookup accepts a receipt number, a scanned receipt QR, or a bare code, because
 * a customer presents all three depending on how the receipt was issued.
 */
export default function ReturnsScreen() {
  const app = useApp();
  const [lookup, setLookup] = useState('');
  const [selected, setSelected] = useState<Sale | null>(null);

  const canReturn = can(app.subject, 'return.create');

  const findSale = async (raw: string): Promise<Sale | null> => {
    if (!app.data) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;

    const fromQr = parseReceiptQr(trimmed);
    if (fromQr?.saleId) {
      const byId = await app.data.getSale(fromQr.saleId);
      if (byId) return byId;
    }
    const receipt = fromQr?.receiptNumber ?? trimmed;
    if (parseReceiptNumber(receipt) || receipt.length > 4) {
      return app.data.findSaleByReceipt(receipt);
    }
    return null;
  };

  const runLookup = async () => {
    const sale = await findSale(lookup);
    if (!sale) {
      app.pushToast({
        message: 'No sale matches that reference',
        detail: 'Try the receipt number printed at the top, or scan the receipt QR code.',
        toneName: 'warning',
      });
      return;
    }
    setSelected(sale);
  };

  if (!canReturn) return <PermissionDenied what="returns" />;

  return (
    <>
      <RecordListPage<Sale>
        title="Sales & returns"
        subtitle="Search by receipt number, or scan the QR code on a printed receipt"
        permission="return.create"
        noun="sales"
        refreshKey={app.syncStatus.pending}
        load={async () => (app.data ? app.data.listSales({ limit: 300 }) : [])}
        keyExtractor={(sale) => sale.id}
        searchText={(sale) => `${sale.receiptNumber} ${sale.status}`}
        onRowPress={(sale) => setSelected(sale)}
        actions={
          <Button
            label="Find receipt"
            size="sm"
            variant="secondary"
            icon="qrcode-scan"
            onPress={() => void runLookup()}
            disabled={!lookup.trim()}
          />
        }
        notice={{
          title: 'Refunds are calculated from the original sale',
          message:
            'POSA never re-prices a refund. It reverses exactly what was charged, including the VAT that was declared, which is what makes the books balance afterwards.',
        }}
        emptyIcon="receipt-text-outline"
        emptyTitle="No sales on this terminal"
        emptyMessage="Complete a sale on Checkout and it appears here with every line, payment and discount preserved."
        columns={[
          {
            key: 'receipt',
            header: 'Receipt',
            flex: 3,
            render: (sale) => (
              <Box>
                <Txt variant="mono" numberOfLines={1}>
                  {sale.receiptNumber}
                </Txt>
                <Txt variant="caption" color={palette.textFaint}>
                  {new Date(sale.committedAt).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </Txt>
              </Box>
            ),
          },
          {
            key: 'items',
            header: 'Items',
            align: 'right',
            width: 70,
            render: (sale) => (
              <Txt variant="moneySm" tabular>
                {sale.itemCount}
              </Txt>
            ),
          },
          {
            key: 'status',
            header: 'Status',
            width: 150,
            render: (sale) => (
              <Badge
                label={sale.status.replace(/_/g, ' ')}
                toneName={sale.status === 'voided' ? 'danger' : sale.status === 'committed' ? 'accent' : 'warning'}
                compact
              />
            ),
          },
          {
            key: 'total',
            header: 'Total',
            align: 'right',
            width: 120,
            render: (sale) => <MoneyCell value={sale.total} />,
          },
        ]}
      />

      <SaleDetailSheet sale={selected} onClose={() => setSelected(null)} />
    </>
  );
}

/* ------------------------------------------------------------------ */

export function SaleDetailSheet({ sale, onClose }: { sale: Sale | null; onClose: () => void }) {
  const app = useApp();
  const [requested, setRequested] = useState<Record<string, number>>({});
  const [reason, setReason] = useState('customer_changed_mind');
  const [busy, setBusy] = useState(false);

  const detail = useAsync(
    async () => {
      if (!app.data || !sale) return { lines: [] as SaleLine[], payments: [] as Array<Record<string, unknown>> };
      const [lines, payments] = await Promise.all([app.data.getSaleLines(sale.id), app.data.getSalePayments(sale.id)]);
      return { lines, payments };
    },
    [sale?.id],
    { lines: [] as SaleLine[], payments: [] as Array<Record<string, unknown>> },
  );

  if (!sale) return null;

  const requests = Object.entries(requested)
    .filter(([, quantity]) => quantity > 0)
    .map(([saleLineId, quantity]) => ({ saleLineId, quantity }));

  const computation = computeRefund({ returnId: 'preview', saleLines: detail.value.lines, requested: requests });

  const commit = async () => {
    if (!app.data || !app.business || !app.branch || !app.device || requests.length === 0) return;
    setBusy(true);
    try {
      const bundle = buildReturn({
        sale: {
          id: sale.id,
          receiptNumber: sale.receiptNumber,
          businessId: sale.businessId,
          branchId: sale.branchId,
          deviceId: sale.deviceId,
          status: sale.status,
          total: sale.total,
          committedAt: sale.committedAt,
        },
        saleLines: detail.value.lines,
        requested: requests,
        context: {
          businessId: app.business.id,
          branchId: app.branch.id,
          deviceId: app.device.id,
          cashierId: app.session?.userId ?? '',
          approvedBy: null,
          reason: reason as ReturnReason,
          reasonNote: null,
          refundMethod: 'cash',
        },
      });
      await app.data.commitReturn(bundle);
      app.pushToast({
        message: `Refund recorded · ${formatMoney(bundle.refundTotal)}`,
        detail: `${bundle.inventory.length} item(s) returned to stock.`,
        toneName: 'accent',
      });
      void app.engine?.tick();
      onClose();
    } catch (error) {
      app.pushToast({
        message: 'Return could not be completed',
        detail: error instanceof Error ? error.message : undefined,
        toneName: 'danger',
      });
    } finally {
      setBusy(false);
    }
  };

  const statusTone = sale.status === 'voided' ? 'danger' : sale.status === 'committed' ? 'accent' : 'warning';

  return (
    <Sheet
      visible
      title={`Receipt ${sale.receiptNumber}`}
      subtitle={`${new Date(sale.committedAt).toLocaleString()} · ${sale.status.replace(/_/g, ' ')}`}
      onClose={onClose}
      width={700}
      footer={
        <>
          <Button label="Close" variant="ghost" onPress={onClose} />
          <Button
            label={computation.refundTotal > 0 ? `Refund ${formatMoney(computation.refundTotal)}` : 'Select items to refund'}
            variant="primary"
            icon="backup-restore"
            loading={busy}
            disabled={requests.length === 0 || sale.status === 'voided'}
            onPress={() => void commit()}
          />
        </>
      }
    >
      <Box gap={spacing.md}>
        <NoticeBar
          toneName={statusTone}
          icon="information-outline"
          title={`Sale total ${formatMoney(sale.total)}`}
          message={`VAT ${formatMoney(sale.taxTotal)} · discounts ${formatMoney(sale.discountTotal)} · ${sale.itemCount} items. Choose the quantities coming back.`}
        />

        {detail.value.lines.map((line) => {
          const remaining = line.quantity - (line.returnedQuantity ?? 0);
          const chosen = requested[line.id] ?? 0;
          return (
            <Box key={line.id} row gap={spacing.md} style={primitives.row}>
              <Box style={primitives.flex}>
                <Txt variant="bodyStrong" numberOfLines={1}>
                  {line.name}
                </Txt>
                <Txt variant="caption" color={palette.textFaint}>
                  {line.quantity} sold · {remaining} returnable · {formatMoney(line.unitPrice)} each
                </Txt>
              </Box>
              <Box row gap={spacing.xs}>
                {Array.from({ length: Math.min(remaining, 6) }).map((_, index) => (
                  <Button
                    key={index}
                    label={String(index + 1)}
                    size="sm"
                    variant={chosen === index + 1 ? 'primary' : 'subtle'}
                    onPress={() => setRequested({ ...requested, [line.id]: chosen === index + 1 ? 0 : index + 1 })}
                  />
                ))}
              </Box>
              <Box style={{ minWidth: 90, alignItems: 'flex-end' }}>
                <MoneyCell value={(chosen * line.unitPrice) as Minor} toneName={chosen > 0 ? 'warning' : undefined} />
              </Box>
            </Box>
          );
        })}

        <Divider />
        <TextField label="Return reason" value={reason} onChangeText={setReason} placeholder="customer_changed_mind" />

        <KeyValue label="Refund subtotal" value={formatMoney(computation.refundSubtotal)} mono />
        <KeyValue label="VAT reversed" value={formatMoney(computation.refundTax)} mono />
        <KeyValue label="Total refund" value={formatMoney(computation.refundTotal)} emphasis mono />

        {computation.errors.length > 0 ? (
          <Card toneName="danger">
            <Txt variant="caption" color={palette.danger}>
              {computation.errors.join(' ')}
            </Txt>
          </Card>
        ) : null}

      </Box>
    </Sheet>
  );
}

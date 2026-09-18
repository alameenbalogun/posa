import React from 'react';
import { useRouter } from 'expo-router';
import type { Minor } from '@/domain/money';
import { useApp } from '@/state/app';
import { useCart } from '@/state/cart';
import { Box, Button, Txt } from '@/ui/primitives';
import { MoneyCell } from '@/ui/patterns';
import { relativeTime } from '@/ui/shell';
import { RecordListPage } from '@/ui/record-page';
import { palette } from '@/ui/theme';

/**
 * Held sales (PRD §11).
 *
 * A held sale is a half-rung order — a customer who went back for the milk they
 * forgot, or a queue that needs clearing at 5pm. Resuming restores the exact
 * lines, prices and discounts that were parked, which is why a held cart is
 * stored as a serialised cart rather than re-derived from the catalogue: a price
 * change while the cart sat on hold must not silently alter what the customer was
 * quoted.
 */

interface HeldRow {
  id: string;
  label: string;
  heldBy: string;
  heldAt: string;
  customerId: string | null;
  deviceId: string;
  lines: Array<{ quantity: number; lineTotal: number }>;
}

export default function HeldSalesScreen() {
  const app = useApp();
  const cart = useCart();
  const router = useRouter();

  return (
    <RecordListPage<HeldRow>
      title="Held sales"
      subtitle="Suspended carts, kept exactly as they were left"
      permission="sale.create"
      noun="held sales"
      refreshKey={app.syncStatus.lastSyncAt}
      load={async () => (app.data ? ((await app.data.listHeldSales()) as unknown as HeldRow[]) : [])}
      keyExtractor={(row) => row.id}
      searchText={(row) => row.label}
      emptyIcon="pause-circle-outline"
      emptyTitle="No held sales"
      emptyMessage="Hold a cart from Checkout when a customer needs to fetch something, or to clear a queue. It returns exactly as it was, at the same prices."
      emptyActionLabel="Go to checkout"
      emptyAction={() => router.push('/(app)/checkout' as never)}
      notice={{
        title: 'Held carts are local to this terminal',
        message:
          'A customer who walks to another till will not find their cart there. Held carts do sync to the cloud, but each terminal lists only its own.',
      }}
      columns={[
        {
          key: 'label',
          header: 'Held sale',
          flex: 3,
          render: (row) => (
            <Box>
              <Txt variant="bodyStrong" numberOfLines={1}>
                {row.label || 'Held sale'}
              </Txt>
              <Txt variant="caption" color={palette.textFaint}>
                Held by {app.users.find((user) => user.id === row.heldBy)?.fullName ?? 'another terminal'} ·{' '}
                {relativeTime(row.heldAt)}
              </Txt>
            </Box>
          ),
        },
        {
          key: 'value',
          header: 'Value',
          align: 'right',
          width: 130,
          render: (row) => {
            const lines = row.lines ?? [];
            const count = lines.reduce((total, line) => total + line.quantity, 0);
            const value = lines.reduce((total, line) => total + (line.lineTotal ?? 0), 0) as Minor;
            return (
              <Box style={{ alignItems: 'flex-end' }}>
                <MoneyCell value={value} toneName="accent" />
                <Txt variant="caption" color={palette.textFaint}>
                  {count} item{count === 1 ? '' : 's'}
                </Txt>
              </Box>
            );
          },
        },
        {
          key: 'customer',
          header: 'Customer',
          width: 170,
          render: (row) => (
            <Txt variant="caption" color={palette.textMuted} numberOfLines={1}>
              {row.customerId ? 'Attached' : 'Walk-in'}
            </Txt>
          ),
        },
        {
          key: 'actions',
          header: '',
          width: 190,
          render: (row) => (
            <Box row gap={4}>
              <Button
                label="Resume"
                size="sm"
                variant="primary"
                icon="play"
                onPress={async () => {
                  const resumed = await cart.resumeHeld(row.id);
                  if (resumed) {
                    router.push('/(app)/checkout' as never);
                  } else {
                    app.pushToast({ message: 'That held sale is no longer available', toneName: 'warning' });
                  }
                }}
              />
              <Button
                label="Discard"
                size="sm"
                variant="ghost"
                icon="trash-can-outline"
                onPress={async () => {
                  await app.data?.removeHeldSale(row.id);
                  app.pushToast({ message: 'Held sale discarded', detail: row.label, toneName: 'info' });
                }}
              />
            </Box>
          ),
        },
      ]}
    />
  );
}

import React from 'react';
import { formatMoney } from '@/domain/money';
import type { Supplier } from '@/domain/types';
import { useApp } from '@/state/app';
import { Badge, Box, Txt } from '@/ui/primitives';
import { MoneyCell } from '@/ui/patterns';
import { RecordListPage } from '@/ui/record-page';
import { palette } from '@/ui/theme';

/**
 * Suppliers (PRD §15).
 *
 * Deliberately a register rather than a form-first screen: the operational
 * question is "who do I owe, and who should I call about the short delivery?",
 * not "let me type a supplier in". Creating them happens as part of purchasing.
 */
export default function SuppliersScreen() {
  const app = useApp();

  return (
    <RecordListPage<Supplier>
      title="Suppliers"
      subtitle="Who you buy from, and what you owe them"
      permission="supplier.manage"
      noun="suppliers"
      refreshKey={app.syncStatus.pending}
      load={async () => (app.data ? app.data.listSuppliers() : [])}
      keyExtractor={(supplier) => supplier.id}
      searchText={(supplier) => `${supplier.name} ${supplier.contactName ?? ''} ${supplier.phone ?? ''}`}
      notice={{
        title: 'Suppliers turn into stock through receiving',
        message:
          'A purchase order records what you expect. Receiving it is what moves stock in — and it is recorded as an inventory ledger event with the cost you paid, which is what makes gross profit real rather than guessed.',
      }}
      emptyIcon="truck-delivery-outline"
      emptyTitle="No suppliers yet"
      emptyMessage="Suppliers are created while you record a purchase. Once one exists you can track what you owe and see your purchase history."
      columns={[
        {
          key: 'name',
          header: 'Supplier',
          flex: 3,
          render: (supplier) => (
            <Box>
              <Txt variant="bodyStrong" numberOfLines={1}>
                {supplier.name}
              </Txt>
              <Txt variant="caption" color={palette.textFaint} numberOfLines={1}>
                {[supplier.contactName, supplier.phone].filter(Boolean).join(' · ') || 'no contact person yet'}
              </Txt>
            </Box>
          ),
        },
        {
          key: 'contact',
          header: 'Email',
          flex: 2,
          render: (supplier) => (
            <Txt variant="caption" color={palette.textMuted} numberOfLines={1}>
              {supplier.email ?? '—'}
            </Txt>
          ),
        },
        {
          key: 'balance',
          header: 'Owed',
          align: 'right',
          width: 130,
          render: (supplier) => (
            <Box style={{ alignItems: 'flex-end' }}>
              <MoneyCell value={supplier.balance} toneName={supplier.balance > 0 ? 'warning' : undefined} />
              <Txt variant="caption" color={palette.textFaint}>
                {supplier.balance > 0 ? formatMoney(supplier.balance) : 'settled'}
              </Txt>
            </Box>
          ),
        },
        {
          key: 'status',
          header: 'Status',
          width: 100,
          render: (supplier) => (
            <Badge label={supplier.status} toneName={supplier.status === 'active' ? 'accent' : 'neutral'} compact />
          ),
        },
      ]}
    />
  );
}

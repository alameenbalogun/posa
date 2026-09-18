import React, { useState } from 'react';
import { StyleSheet } from 'react-native';
import { formatMoney, parseMoney, ZERO, type Minor } from '@/domain/money';
import { ulid } from '@/domain/ulid';
import type { Customer } from '@/domain/types';
import { outboxEvent } from '@/data/mutations';
import { useApp } from '@/state/app';
import { Badge, Box, Button, TextField, Txt } from '@/ui/primitives';
import { MoneyCell, Sheet } from '@/ui/patterns';
import { RecordListPage } from '@/ui/record-page';
import { palette, spacing } from '@/ui/theme';

/**
 * Customers (PRD §16).
 *
 * Balances are shown as the business thinks about them: a NEGATIVE balance means
 * the customer owes money (credit sales), a positive one means they have paid
 * ahead. Getting that sign convention wrong in the UI is how a shopkeeper ends up
 * chasing the wrong person, so the wording is explicit rather than relying on the
 * colour alone.
 */
export default function CustomersScreen() {
  const app = useApp();
  const [editing, setEditing] = useState<Customer | null>(null);
  const [nonce, setNonce] = useState(0);

  return (
    <>
      <RecordListPage<Customer>
        title="Customers"
        subtitle="People who buy from this shop, with their balances"
        permission="customer.view"
        noun="customers"
        refreshKey={nonce}
        load={async () => (app.data ? app.data.listCustomers() : [])}
        keyExtractor={(customer) => customer.id}
        onRowPress={(customer) => {
          if (app.can('customer.manage')) setEditing(customer);
        }}
        searchText={(customer) => `${customer.name} ${customer.phone ?? ''} ${customer.email ?? ''}`}
        notice={{
          title: 'Attach a customer to record credit and send receipts',
          message:
            'A customer is optional on a sale. Attaching one lets you keep a tracked balance for credit sales and gives the receipt somewhere to go.',
        }}
        actions={
          app.can('customer.manage') ? (
            <Button
              label="New customer"
              size="sm"
              variant="primary"
              icon="account-plus-outline"
              onPress={() =>
                setEditing({
                  id: ulid(),
                  businessId: app.business?.id ?? '',
                  name: '',
                  phone: null,
                  email: null,
                  address: null,
                  balance: ZERO,
                  creditLimit: ZERO,
                  loyaltyPoints: 0,
                  notes: null,
                  status: 'active',
                  createdAt: new Date().toISOString(),
                })
              }
            />
          ) : null
        }
        emptyIcon="account-multiple-plus-outline"
        emptyTitle="No customers yet"
        emptyMessage="Add regulars here so you can track credit sales, look up their purchase history and send digital receipts."
        columns={[
          {
            key: 'name',
            header: 'Customer',
            flex: 3,
            render: (customer) => (
              <Box>
                <Txt variant="bodyStrong" numberOfLines={1}>
                  {customer.name}
                </Txt>
                <Txt variant="caption" color={palette.textFaint} numberOfLines={1}>
                  {[customer.phone, customer.email].filter(Boolean).join(' · ') || 'no contact details'}
                </Txt>
              </Box>
            ),
          },
          {
            key: 'balance',
            header: 'Balance',
            align: 'right',
            width: 130,
            render: (customer) => (
              <Box style={styles.right}>
                <Txt
                  variant="moneySm"
                  tabular
                  color={customer.balance < 0 ? palette.warning : customer.balance > 0 ? palette.accent : palette.textMuted}
                >
                  {customer.balance === 0 ? '—' : formatMoney(Math.abs(customer.balance))}
                </Txt>
                <Txt variant="caption" color={palette.textFaint}>
                  {customer.balance === 0 ? 'settled' : customer.balance < 0 ? 'owes shop' : 'paid ahead'}
                </Txt>
              </Box>
            ),
          },
          {
            key: 'limit',
            header: 'Credit limit',
            align: 'right',
            width: 110,
            render: (customer) => <MoneyCell value={customer.creditLimit} />,
          },
          {
            key: 'status',
            header: 'Status',
            width: 100,
            render: (customer) => (
              <Badge label={customer.status} toneName={customer.status === 'active' ? 'accent' : 'neutral'} compact />
            ),
          },
        ]}
      />

      <CustomerSheet
        draft={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          setNonce((value) => value + 1);
        }}
      />
    </>
  );
}

function CustomerSheet({
  draft,
  onClose,
  onSaved,
}: {
  draft: Customer | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const app = useApp();
  const [local, setLocal] = useState<Customer | null>(draft);
  const [limitText, setLimitText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  React.useEffect(() => {
    if (!draft) return;
    setLocal(draft);
    setLimitText(formatMoney(draft.creditLimit, { bare: true }));
    setError(null);
  }, [draft]);

  if (!local) return null;
  const isNew = local.createdAt === draft?.createdAt && !draft?.name;

  const save = async () => {
    if (!app.data || !app.business || !app.device) return;
    if (!local.name.trim()) {
      setError('A customer needs a name.');
      return;
    }
    setBusy(true);
    try {
      const customer: Customer = {
        ...local,
        name: local.name.trim(),
        creditLimit: parseMoney(limitText) ?? ZERO,
      };

      // The customer row and its outbound event are written together: a customer
      // created offline must survive a crash and still reach the cloud later.
      const event = outboxEvent({
        businessId: app.business.id,
        branchId: app.branch?.id ?? null,
        deviceId: app.device.id,
        entity: 'customer',
        entityId: customer.id,
        payload: customer,
      });

      await app.data.store.transaction(async (tx) => {
        await tx.put('customers', customer as never);
        await tx.enqueue([event]);
      });

      await app.data.writeAudit(
        {
          id: ulid(),
          businessId: app.business.id,
          branchId: app.branch?.id ?? null,
          deviceId: app.device.id,
          actorId: app.session?.userId ?? null,
          actorName: app.session?.fullName ?? '',
          action: 'settings.update',
          entityType: 'customer',
          entityId: customer.id,
          metadata: { name: customer.name, creditLimit: customer.creditLimit },
          origin: 'local',
          occurredAt: new Date().toISOString(),
        },
      );

      app.pushToast({
        message: isNew ? 'Customer added' : 'Customer updated',
        detail: customer.name,
        toneName: 'accent',
      });
      void app.engine?.tick();
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the customer.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      visible
      title={isNew ? 'New customer' : 'Edit customer'}
      subtitle="Only the name is required"
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button label="Cancel" variant="ghost" onPress={onClose} />
          <Button label={isNew ? 'Add customer' : 'Save changes'} variant="primary" loading={busy} onPress={() => void save()} />
        </>
      }
    >
      <Box gap={spacing.md}>
        <TextField label="Name" value={local.name} onChangeText={(name) => setLocal({ ...local, name })} autoFocus placeholder="Amina Yusuf" />
        <Box row gap={spacing.md}>
          <TextField
            label="Phone"
            value={local.phone ?? ''}
            onChangeText={(phone) => setLocal({ ...local, phone })}
            keyboardType="phone-pad"
            style={styles.flex}
            mono
          />
          <TextField
            label="Email"
            value={local.email ?? ''}
            onChangeText={(email) => setLocal({ ...local, email })}
            style={styles.flex}
            hint="Where digital receipts go"
          />
        </Box>
        <TextField
          label="Credit limit"
          value={limitText}
          onChangeText={setLimitText}
          keyboardType="decimal-pad"
          mono
          hint="How much you are willing to let this customer owe. Leave at 0 for cash-only."
        />
        <TextField
          label="Notes"
          value={local.notes ?? ''}
          onChangeText={(notes) => setLocal({ ...local, notes })}
          multiline
          placeholder="Optional — delivery instructions, a landmark, anything useful"
        />
        {error ? (
          <Txt variant="caption" color={palette.warning}>
            {error}
          </Txt>
        ) : null}
      </Box>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  right: { alignItems: 'flex-end' },
});

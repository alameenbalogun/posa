import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { formatMoney, parseMoney, ZERO, type Minor } from '@/domain/money';
import type { Expense, PaymentMethod } from '@/domain/types';
import { recordExpense, type MutationContext } from '@/data/mutations';
import { resolveRange } from '@/data/analytics';
import { useApp } from '@/state/app';
import { Badge, Box, Button, Card, Chip, TextField, Txt } from '@/ui/primitives';
import { MoneyCell, Sheet, StatTile } from '@/ui/patterns';
import { Header, NoticeBar, Page, PermissionDenied, StatGrid } from '@/ui/shell';
import { palette, spacing } from '@/ui/theme';

/**
 * Expenses (PRD §20).
 *
 * Two design decisions worth stating.
 *
 * 1. The category list is short and operational — rent, transport, generator
 *    fuel — because a long taxonomy is how expense tracking dies in a small shop.
 * 2. When the source is cash, the expense is expected to be tied to the open
 *    shift, so the drawer reconciliation at close-of-day accounts for it. Money
 *    that leaves the till without being recorded is the most common source of a
 *    till that "never balances".
 */

const DEFAULT_CATEGORIES = ['Rent', 'Transport', 'Fuel / Power', 'Supplies', 'Repairs', 'Salaries', 'Other'] as const;

const SOURCES: Array<{ key: PaymentMethod; label: string }> = [
  { key: 'cash', label: 'Cash' },
  { key: 'transfer', label: 'Transfer' },
  { key: 'card', label: 'Card' },
];

export default function ExpensesScreen() {
  const app = useApp();
  const [rows, setRows] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);

  const reload = React.useCallback(async () => {
    if (!app.data) return;
    setLoading(true);
    setRows(await app.data.listExpenses(300));
    setLoading(false);
  }, [app.data]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  const today = useMemo(() => {
    const range = resolveRange('today');
    return rows
      .filter((expense) => expense.spentAt >= range.from && expense.spentAt <= range.to)
      .reduce((total, expense) => total + expense.amount, 0) as Minor;
  }, [rows]);

  const thisMonth = useMemo(() => {
    const range = resolveRange('month');
    return rows
      .filter((expense) => expense.spentAt >= range.from && expense.spentAt <= range.to)
      .reduce((total, expense) => total + expense.amount, 0) as Minor;
  }, [rows]);

  if (!app.can('finance.expense')) return <PermissionDenied what="expenses" />;

  const cashShare = rows.filter((expense) => expense.source === 'cash').length;

  return (
    <View style={styles.flex}>
      <Header
        title="Expenses"
        subtitle={`${rows.length} recorded · ${cashShare} paid from the drawer`}
        actions={
          <Button
            label="Record expense"
            size="sm"
            variant="primary"
            icon="plus"
            onPress={() => setSheetOpen(true)}
          />
        }
      />

      <Page maxWidth={1400}>
        <NoticeBar
          toneName="info"
          icon="cash-remove"
          title="Cash expenses are reconciled against the open shift"
          message="Money that leaves the till without being recorded here will show up as a shortfall at close of day. Recording it as it happens keeps the variance honest."
        />

        <StatGrid>
          <StatTile label="Today" value={formatMoney(today, { compact: true })} monetary icon="calendar-today" toneName="info" />
          <StatTile label="This month" value={formatMoney(thisMonth, { compact: true })} monetary icon="calendar-month-outline" toneName="warning" />
          <StatTile label="Entries" value={String(rows.length)} icon="receipt-text-outline" hint="Newest first" />
        </StatGrid>

        {loading ? (
          <Card>
            <Txt variant="body" color={palette.textMuted}>
              Reading local records…
            </Txt>
          </Card>
        ) : rows.length === 0 ? (
          <Card>
            <Box gap={spacing.sm}>
              <Txt variant="h3">No expenses recorded</Txt>
              <Txt variant="body" color={palette.textMuted}>
                Everything the shop pays for that is not stock belongs here: rent, transport, generator fuel, a
                plumber. Recording it is what turns a sales report into a profit report.
              </Txt>
              <Button label="Record the first one" variant="primary" icon="plus" onPress={() => setSheetOpen(true)} />
            </Box>
          </Card>
        ) : (
          <Card padded={false}>
            <Box>
              {rows.slice(0, 200).map((expense, index) => (
                <Box
                  key={expense.id}
                  row
                  gap={spacing.md}
                  style={[styles.row, index > 0 ? styles.rowBorder : null]}
                >
                  <Box style={styles.flex}>
                    <Txt variant="bodyStrong" numberOfLines={1}>
                      {expense.categoryName}
                    </Txt>
                    <Txt variant="caption" color={palette.textFaint} numberOfLines={1}>
                      {expense.description ?? 'no description'} · {new Date(expense.spentAt).toLocaleDateString()}
                    </Txt>
                  </Box>
                  <Badge
                    label={expense.source}
                    toneName={expense.source === 'cash' ? 'warning' : 'info'}
                    compact
                  />
                  <Box style={styles.amount}>
                    <MoneyCell value={expense.amount} />
                  </Box>
                </Box>
              ))}
            </Box>
          </Card>
        )}
      </Page>

      <ExpenseSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onSaved={async () => {
          setSheetOpen(false);
          await reload();
        }}
      />
    </View>
  );
}

function ExpenseSheet({
  visible,
  onClose,
  onSaved,
}: {
  visible: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const app = useApp();
  const [category, setCategory] = useState<string>(DEFAULT_CATEGORIES[0]);
  const [source, setSource] = useState<PaymentMethod>('cash');
  const [amountText, setAmountText] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  React.useEffect(() => {
    if (!visible) return;
    setAmountText('');
    setDescription('');
    setError(null);
    setSource('cash');
  }, [visible]);

  const amount = parseMoney(amountText) ?? (0 as Minor);

  const submit = async () => {
    const { data, business, branch, device, session } = app;
    if (!data || !business || !branch || !device) return;
    if (amount <= 0) {
      setError('Enter an amount greater than zero.');
      return;
    }
    if (source === 'cash' && !app.openShift) {
      setError('Cash left the drawer, but no shift is open. Open a shift first so this reconciles — or record it as a transfer.');
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

      await recordExpense(ctx, {
        amount,
        categoryId: null,
        categoryName: category,
        source,
        description: description.trim() || null,
        shiftId: source === 'cash' ? app.openShift?.id ?? null : null,
      });

      app.pushToast({
        message: 'Expense recorded',
        detail: `${category} · ${formatMoney(amount)} from ${source}`,
        toneName: 'accent',
      });
      void app.engine?.tick();
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not record the expense.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      visible={visible}
      title="Record an expense"
      subtitle="Written locally, queued for the cloud"
      onClose={onClose}
      width={540}
      footer={
        <>
          <Button label="Cancel" variant="ghost" onPress={onClose} />
          <Button label="Record expense" variant="primary" icon="check" loading={busy} onPress={() => void submit()} />
        </>
      }
    >
      <Box gap={spacing.lg}>
        <Box gap={spacing.xs}>
          <Txt variant="label" color={palette.textMuted}>
            Category
          </Txt>
          <Box row gap={spacing.xs} style={styles.wrap}>
            {DEFAULT_CATEGORIES.map((name) => (
              <Chip key={name} label={name} selected={category === name} onPress={() => setCategory(name)} />
            ))}
          </Box>
        </Box>

        <TextField
          label="Amount"
          value={amountText}
          onChangeText={setAmountText}
          placeholder="0.00"
          keyboardType="decimal-pad"
          mono
          autoFocus
        />

        <Box gap={spacing.xs}>
          <Txt variant="label" color={palette.textMuted}>
            Paid from
          </Txt>
          <Box row gap={spacing.xs}>
            {SOURCES.map((option) => (
              <Chip
                key={option.key}
                label={option.label}
                selected={source === option.key}
                onPress={() => setSource(option.key)}
              />
            ))}
          </Box>
          {source === 'cash' ? (
            <Txt variant="caption" color={app.openShift ? palette.textFaint : palette.warning}>
              {app.openShift
                ? `Will be deducted from the open shift's expected drawer (${formatMoney(app.openShift.openingFloat, { compact: true })} float).`
                : 'No shift is open on this terminal — cash expenses cannot be reconciled until you open one.'}
            </Txt>
          ) : null}
        </Box>

        <TextField
          label="Description"
          value={description}
          onChangeText={setDescription}
          placeholder="Optional — what was it for?"
          multiline
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
  wrap: { flexWrap: 'wrap' },
  row: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, alignItems: 'center' },
  rowBorder: { borderTopWidth: 1, borderTopColor: palette.border },
  amount: { minWidth: 110, alignItems: 'flex-end' },
});

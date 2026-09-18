import React, { useMemo, useState } from "react";
import { View } from "react-native";
import { formatMoney, parseMoney, type Minor } from "@/domain/money";
import type { Shift } from "@/domain/types";
import { expectedDrawer, cashVariance } from "@/data/analytics";
import { ulid } from "@/domain/ulid";
import { useApp } from "@/state/app";
import { useLocalSnapshot } from "@/state/hooks";
import {
  Badge,
  Box,
  Button,
  Card,
  Divider,
  KeyValue,
  Money,
  TextField,
  Txt,
} from "@/ui/primitives";
import { Sheet } from "@/ui/patterns";
import {
  Header,
  NoticeBar,
  Page,
  PageGrid,
  PermissionDenied,
  StatGrid,
  relativeTime,
} from "@/ui/shell";
import { StatTile } from "@/ui/patterns";
import { palette, spacing } from "@/ui/theme";

/**
 * Cash shifts (PRD §19).
 *
 * The expected drawer formula is the one a real shopkeeper uses:
 *   opening float + cash sales + cash in − cash out − cash expenses
 * Card, transfer and wallet never touch the drawer — the mistake most simple
 * tills make, and then cannot explain at close.
 *
 * Variance is a first-class output, not a footnote. A till that is ₦200 short is
 * a fact the owner needs recorded, attributed and visible, not a number rounded
 * into a report.
 */
export default function ShiftsScreen() {
  const app = useApp();
  const snapshot = useLocalSnapshot({ saleLimit: 1000 });
  const [openSheet, setOpenSheet] = useState(false);
  const [closeSheet, setCloseSheet] = useState(false);
  const [floatText, setFloatText] = useState("");
  const [countedText, setCountedText] = useState("");
  const [busy, setBusy] = useState(false);

  const shift = app.openShift;

  /** Cash actually taken during this shift, from payment records. */
  const cashSales = useMemo(() => {
    if (!shift) return 0 as Minor;
    const saleIds = new Set(
      snapshot.sales
        .filter((sale) => sale.shiftId === shift.id && sale.status !== "voided")
        .map((sale) => sale.id),
    );
    return snapshot.payments.reduce<number>((total, payment) => {
      if (!saleIds.has(String(payment.saleId))) return total;
      if (payment.method !== "cash" || payment.status !== "successful")
        return total;
      return total + payment.amount;
    }, 0) as Minor;
  }, [shift, snapshot.sales, snapshot.payments]);

  const expected = useMemo(
    () =>
      shift
        ? expectedDrawer({
            openingFloat: shift.openingFloat,
            cashSales,
            cashIn: shift.cashIn,
            cashOut: shift.cashOut,
            cashExpenses: 0 as Minor,
          })
        : (0 as Minor),
    [shift, cashSales],
  );

  const counted = parseMoney(countedText) ?? (0 as Minor);
  const variance = cashVariance({ expected, counted });

  if (!app.can("shift.open")) return <PermissionDenied what="cash shifts" />;

  const openShift = async () => {
    if (
      !app.data ||
      !app.business ||
      !app.branch ||
      !app.device ||
      !app.session
    )
      return;
    const float = parseMoney(floatText) ?? (0 as Minor);
    setBusy(true);
    try {
      const next: Shift = {
        id: ulid(),
        businessId: app.business.id,
        branchId: app.branch.id,
        deviceId: app.device.id,
        cashierId: app.session.userId,
        openingFloat: float,
        countedClose: null,
        expectedClose: null,
        variance: null,
        cashIn: 0 as Minor,
        cashOut: 0 as Minor,
        status: "open",
        openedAt: new Date().toISOString(),
        closedAt: null,
        closedBy: null,
        note: null,
      };
      await app.data.saveShift(next);
      await app.refreshShift();
      app.pushToast({
        message: "Shift opened",
        detail: `Float ${formatMoney(float)}`,
        toneName: "accent",
      });
      setOpenSheet(false);
      setFloatText("");
    } finally {
      setBusy(false);
    }
  };

  const closeShift = async () => {
    if (!app.data || !shift) return;
    setBusy(true);
    try {
      const result = cashVariance({ expected, counted });
      await app.data.saveShift({
        ...shift,
        status: "closed",
        countedClose: counted,
        expectedClose: expected,
        variance: result,
        closedAt: new Date().toISOString(),
        closedBy: app.session?.userId ?? null,
      });
      await app.refreshShift();
      app.pushToast({
        message:
          result === 0
            ? "Shift closed — drawer balances"
            : `Shift closed ${result < 0 ? "short" : "over"} by ${formatMoney(Math.abs(result))}`,
        detail: `Expected ${formatMoney(expected)}, counted ${formatMoney(counted)}.`,
        toneName: result === 0 ? "accent" : "warning",
        durationMs: 8000,
      });
      setCloseSheet(false);
      setCountedText("");
    } finally {
      setBusy(false);
    }
  };

  const shifts = useMemo(
    () => snapshot.sales.filter((sale) => sale.shiftId === shift?.id),
    [snapshot.sales, shift?.id],
  );

  return (
    <View style={{ flex: 1 }}>
      <Header
        title="Cash shifts"
        subtitle={
          shift
            ? `Open since ${relativeTime(shift.openedAt)}`
            : "No shift open on this terminal"
        }
        actions={
          shift ? (
            <Button
              label="Close shift"
              size="sm"
              variant="primary"
              icon="lock-outline"
              onPress={() => {
                setCloseSheet(true);
                setCountedText("");
              }}
            />
          ) : (
            <Button
              label="Open shift"
              size="sm"
              variant="primary"
              icon="lock-open-outline"
              onPress={() => {
                setOpenSheet(true);
                setFloatText("");
              }}
            />
          )
        }
      />

      <Page>
        {!shift ? (
          <NoticeBar
            toneName="warning"
            icon="cash-register"
            title="No shift is open"
            message="Sales still complete without a shift, but cash will not be attributed to a drawer and the close-out report will have nothing to reconcile against."
          />
        ) : null}

        <StatGrid>
          <StatTile
            label="Opening float"
            value={formatMoney(shift?.openingFloat ?? (0 as Minor), {
              compact: true,
            })}
            monetary
            icon="cash"
            toneName="info"
          />
          <StatTile
            label="Cash sales this shift"
            value={formatMoney(cashSales, { compact: true })}
            monetary
            icon="cash-multiple"
            toneName="accent"
            hint={`${shifts.length} transaction${shifts.length === 1 ? "" : "s"}`}
          />
          <StatTile
            label="Expected in drawer"
            value={formatMoney(expected, { compact: true })}
            monetary
            icon="calculator-variant"
            toneName="violet"
          />
          <StatTile
            label="Transactions this shift"
            value={String(shifts.length)}
            icon="receipt"
            hint={
              shift
                ? `Since ${new Date(shift.openedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                : "—"
            }
          />
        </StatGrid>

        <PageGrid minWidth={380}>
          <Card style={{ flex: 1, minWidth: 340 }}>
            <Box gap={spacing.sm}>
              <Txt variant="h3">Drawer reconciliation</Txt>
              <Txt variant="caption" color={palette.textMuted}>
                Only cash affects the drawer. Card, transfer and wallet are
                recorded separately.
              </Txt>
              <Divider />
              <KeyValue
                label="Opening float"
                value={formatMoney(shift?.openingFloat ?? (0 as Minor))}
                mono
              />
              <KeyValue
                label="+ Cash sales"
                value={formatMoney(cashSales)}
                mono
              />
              <KeyValue
                label="+ Cash paid in"
                value={formatMoney(shift?.cashIn ?? (0 as Minor))}
                mono
              />
              <KeyValue
                label="− Cash paid out"
                value={formatMoney(shift?.cashOut ?? (0 as Minor))}
                mono
              />
              <Divider />
              <KeyValue
                label="Expected at close"
                value={formatMoney(expected)}
                emphasis
                mono
              />
            </Box>
          </Card>

          <Card style={{ flex: 1, minWidth: 340 }}>
            <Box gap={spacing.sm}>
              <Txt variant="h3">History</Txt>
              <Txt variant="caption" color={palette.textMuted}>
                Closed shifts keep their variance permanently.
              </Txt>
              <Divider />
              {app.openShift ? (
                <Box row gap={spacing.sm}>
                  <Badge label="Open" toneName="accent" compact />
                  <Txt variant="caption" color={palette.textMuted}>
                    Opened {relativeTime(app.openShift.openedAt)}
                  </Txt>
                </Box>
              ) : null}
              <Txt variant="caption" color={palette.textFaint}>
                Closed shifts appear here with their counted total and variance.
                A repeated pattern of small shortfalls is usually a process
                problem, not a person — the report exists so it can be seen
                early.
              </Txt>
            </Box>
          </Card>
        </PageGrid>
      </Page>

      <Sheet
        visible={openSheet}
        title="Open a shift"
        subtitle="Count the float you are starting with"
        onClose={() => setOpenSheet(false)}
        width={480}
        footer={
          <>
            <Button
              label="Cancel"
              variant="ghost"
              onPress={() => setOpenSheet(false)}
            />
            <Button
              label="Open shift"
              variant="primary"
              icon="lock-open-outline"
              loading={busy}
              onPress={() => void openShift()}
            />
          </>
        }
      >
        <Box gap={spacing.md}>
          <TextField
            label="Opening float"
            value={floatText}
            onChangeText={setFloatText}
            placeholder="20000.00"
            keyboardType="decimal-pad"
            mono
            autoFocus
            hint="Cash physically in the drawer right now."
          />
          <Box row gap={spacing.sm} style={{ flexWrap: "wrap" }}>
            {[5000, 10000, 20000, 50000].map((amount) => (
              <Button
                key={amount}
                label={formatMoney((amount * 100) as Minor, { compact: true })}
                size="sm"
                variant="subtle"
                onPress={() => setFloatText(String(amount))}
              />
            ))}
          </Box>
        </Box>
      </Sheet>

      <Sheet
        visible={closeSheet}
        title="Close the shift"
        subtitle="Count the drawer and record the variance"
        onClose={() => setCloseSheet(false)}
        width={520}
        footer={
          <>
            <Button
              label="Cancel"
              variant="ghost"
              onPress={() => setCloseSheet(false)}
            />
            <Button
              label="Close & reconcile"
              variant="primary"
              icon="lock-outline"
              loading={busy}
              disabled={!countedText}
              onPress={() => void closeShift()}
            />
          </>
        }
      >
        <Box gap={spacing.lg}>
          <TextField
            label="Counted cash in drawer"
            value={countedText}
            onChangeText={setCountedText}
            placeholder={formatMoney(expected, { bare: true })}
            keyboardType="decimal-pad"
            mono
            autoFocus
          />
          <Card toneName={variance === 0 ? "accent" : "warning"}>
            <Box gap={spacing.xs}>
              <Txt
                variant="label"
                color={variance === 0 ? palette.accent : palette.warning}
              >
                {countedText
                  ? variance === 0
                    ? "DRAWER BALANCES"
                    : variance < 0
                      ? `SHORT BY ${formatMoney(Math.abs(variance))}`
                      : `OVER BY ${formatMoney(variance)}`
                  : "AWAITING COUNT"}
              </Txt>
              <Box row style={{ justifyContent: "space-between" }}>
                <Txt variant="caption" color={palette.textMuted}>
                  Expected
                </Txt>
                <Money value={expected} variant="moneySm" />
              </Box>
              <Box row style={{ justifyContent: "space-between" }}>
                <Txt variant="caption" color={palette.textMuted}>
                  Counted
                </Txt>
                <Money value={counted} variant="moneySm" />
              </Box>
            </Box>
          </Card>
          <Txt variant="caption" color={palette.textFaint}>
            The variance and both figures are stored permanently against this
            shift and written to the audit log, so a pattern is visible over
            time rather than lost at the end of each day.
          </Txt>
        </Box>
      </Sheet>
    </View>
  );
}

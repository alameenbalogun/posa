import React, { useState } from "react";
import { StyleSheet, View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { can } from "@/domain/permissions";
import { CURRENCIES } from "@/domain/money";
import { isSupabaseConfigured } from "@/cloud/config";
import { useApp } from "@/state/app";
import {
  Badge,
  Box,
  Button,
  Card,
  Chip,
  Divider,
  KeyValue,
  Txt,
  styles as primitives,
} from "@/ui/primitives";
import { Sheet } from "@/ui/patterns";
import {
  Header,
  NoticeBar,
  Page,
  PageGrid,
  PermissionDenied,
  relativeTime,
} from "@/ui/shell";
import { palette, spacing } from "@/ui/theme";

/**
 * Settings.
 *
 * Cloud credentials are developer-only and never shown to end users.
 * Sync is automatic when the workspace is linked and the device is online.
 */
export default function SettingsScreen() {
  const app = useApp();
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  if (!can(app.subject, "admin.settings"))
    return <PermissionDenied what="settings" />;

  const settings = app.business?.settings;
  const configured = isSupabaseConfigured();
  const linked = app.syncStatus.cloudConfigured;

  const updateSetting = async (
    patch: Partial<NonNullable<typeof settings>>,
  ) => {
    if (!app.data || !app.business || !settings) return;
    const next = { ...app.business, settings: { ...settings, ...patch } };
    await app.data.saveBusiness(next);
    useApp.setState({ business: next });
    app.pushToast({
      message: "Setting saved",
      detail: "Applies to new activity on this terminal.",
      toneName: "accent",
    });
  };

  return (
    <View style={primitives.flex}>
      <Header
        title="Settings"
        subtitle={`${app.business?.name ?? ""} · ${app.storeKind} storage`}
      />

      <Page>
        <PageGrid minWidth={380}>
          <Card style={{ flex: 1, minWidth: 340 }}>
            <Box gap={spacing.md}>
              <Box>
                <Txt variant="h3">Business</Txt>
                <Txt variant="caption" color={palette.textMuted}>
                  Applies across every branch and terminal
                </Txt>
              </Box>
              <Divider />
              <KeyValue
                label="Business name"
                value={app.business?.name ?? "—"}
              />
              <KeyValue
                label="Branch"
                value={`${app.branch?.name ?? "—"} (${app.branch?.code ?? "—"})`}
                mono
              />
              <KeyValue
                label="Terminal"
                value={`${app.device?.name ?? "—"} · ${app.device?.platform ?? ""}`}
              />
              <KeyValue
                label="Device code"
                value={app.device?.id.slice(-6).toUpperCase() ?? "—"}
                mono
              />
              <Divider />

              <Box>
                <Txt
                  variant="label"
                  color={palette.textMuted}
                  style={{ marginBottom: spacing.sm }}
                >
                  Currency
                </Txt>
                <Box row gap={spacing.sm} style={{ flexWrap: "wrap" }}>
                  {["NGN", "USD", "GBP", "GHS", "KES"].map((code) => (
                    <Chip
                      key={code}
                      label={`${code} ${CURRENCIES[code]?.symbol ?? ""}`}
                      selected={settings?.currency === code}
                      onPress={() => void updateSetting({ currency: code })}
                    />
                  ))}
                </Box>
              </Box>

              <Box>
                <Txt
                  variant="label"
                  color={palette.textMuted}
                  style={{ marginBottom: spacing.sm }}
                >
                  Pricing
                </Txt>
                <Box row gap={spacing.sm} style={{ flexWrap: "wrap" }}>
                  <Chip
                    label="Prices include tax"
                    selected={settings?.taxInclusive === true}
                    onPress={() => void updateSetting({ taxInclusive: true })}
                  />
                  <Chip
                    label="Tax added at checkout"
                    selected={settings?.taxInclusive === false}
                    onPress={() => void updateSetting({ taxInclusive: false })}
                  />
                </Box>
                <Txt
                  variant="caption"
                  color={palette.textFaint}
                  style={{ marginTop: spacing.xs }}
                >
                  This changes what a shelf price means, so it is recorded in
                  the audit log.
                </Txt>
              </Box>

              <Box>
                <Txt
                  variant="label"
                  color={palette.textMuted}
                  style={{ marginBottom: spacing.sm }}
                >
                  Stock policy
                </Txt>
                <Box row gap={spacing.sm} style={{ flexWrap: "wrap" }}>
                  <Chip
                    label="Allow negative stock"
                    selected={settings?.allowNegativeStock === true}
                    onPress={() =>
                      void updateSetting({ allowNegativeStock: true })
                    }
                  />
                  <Chip
                    label="Block sales below zero"
                    selected={settings?.allowNegativeStock === false}
                    onPress={() =>
                      void updateSetting({ allowNegativeStock: false })
                    }
                  />
                </Box>
                <Txt
                  variant="caption"
                  color={palette.textFaint}
                  style={{ marginTop: spacing.xs }}
                >
                  Blocking below zero is stricter, but on several offline
                  terminals the local counts can disagree — the guard is
                  advisory and the reconciler settles the difference later.
                </Txt>
              </Box>
            </Box>
          </Card>

          <Card style={{ flex: 1, minWidth: 340 }}>
            <Box gap={spacing.md}>
              <Box
                row
                style={{
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                }}
              >
                <Box>
                  <Txt variant="h3">Cloud &amp; sync</Txt>
                  <Txt variant="caption" color={palette.textMuted}>
                    {linked
                      ? "Changes sync automatically in the background"
                      : configured
                        ? "Credentials configured — link this terminal to start syncing"
                        : "Local-only mode — no cloud project connected"}
                  </Txt>
                </Box>
                <Badge
                  label={linked ? "Syncing" : configured ? "Available" : "Local only"}
                  toneName={linked ? "accent" : configured ? "warning" : "neutral"}
                />
              </Box>
              <Divider />

              {linked ? (
                <>
                  <KeyValue label="Sync state" value={app.syncStatus.state} />
                  <KeyValue
                    label="Pending uploads"
                    value={String(app.syncStatus.pending)}
                    mono
                    emphasis={app.syncStatus.pending > 0}
                  />
                  <KeyValue
                    label="Open conflicts"
                    value={String(app.syncStatus.openConflicts)}
                    mono
                    toneName={
                      app.syncStatus.openConflicts > 0 ? "warning" : undefined
                    }
                  />
                  <KeyValue
                    label="Last exchange"
                    value={relativeTime(app.syncStatus.lastSyncAt)}
                  />
                  <Button
                    label="Sync now"
                    variant="secondary"
                    icon="cloud-sync-outline"
                    size="sm"
                    onPress={() => void app.syncNow()}
                  />
                </>
              ) : (
                <Box gap={spacing.sm}>
                  <NoticeBar
                    toneName={configured ? "info" : "neutral"}
                    icon={configured ? "cloud-outline" : "harddisk"}
                    title={
                      configured
                        ? "Automatic sync is ready"
                        : "Local-only mode"
                    }
                    message={
                      configured
                        ? "When this terminal is linked, syncing happens automatically whenever the device is online. No manual action needed."
                        : "All data stays on this device. Cloud sync activates automatically when credentials are configured by the development team."
                    }
                  />
                  <Button
                    label={configured ? "Open Sync Center" : "See what is queued"}
                    variant="secondary"
                    icon="cloud-sync-outline"
                    onPress={() => void app.syncNow()}
                  />
                </Box>
              )}
            </Box>
          </Card>
        </PageGrid>

        <PageGrid minWidth={380}>
          <Card style={{ flex: 1, minWidth: 340 }}>
            <Box gap={spacing.md}>
              <Box>
                <Txt variant="h3">Roles &amp; approvals</Txt>
                <Txt variant="caption" color={palette.textMuted}>
                  What this terminal will let people do without a second pair of
                  eyes
                </Txt>
              </Box>
              <Divider />
              <KeyValue
                label="Discount ceiling without approval"
                value={`${(settings?.maxDiscountBasisPoints ?? 0) / 100}%`}
                mono
                emphasis
              />
              <KeyValue
                label="Actions needing approval"
                value={
                  (settings?.requireApprovalFor ?? [])
                    .map((key) => key.replace(/\./g, " "))
                    .join(", ") || "none"
                }
              />
              <KeyValue
                label="Offline session limit"
                value={`${settings?.offlineSessionMinutes ?? 0} minutes`}
                mono
              />
              <Txt variant="caption" color={palette.textFaint}>
                A cashier may discount up to the ceiling on their own. Anything
                above it, a void, or an approval-gated action requires a user
                holding the approver permission, and the approver is written
                into the audit trail.
              </Txt>
            </Box>
          </Card>

          <Card style={{ flex: 1, minWidth: 340 }} toneName="danger">
            <Box gap={spacing.md}>
              <Box>
                <Txt variant="h3" color={palette.danger}>
                  Danger zone
                </Txt>
                <Txt variant="caption" color={palette.textMuted}>
                  Irreversible, and only available to an owner
                </Txt>
              </Box>
              <Divider />
              <Txt variant="body" color={palette.textSecondary}>
                Resetting wipes every local sale, stock movement, product,
                customer and staff record. The terminal then returns to real
                workspace onboarding; no placeholder catalogue or staff is
                created. Anything that has not been uploaded is lost.
              </Txt>
              <Button
                label="Reset this terminal"
                variant="danger"
                icon="alert-octagon-outline"
                onPress={() => setConfirmWipe(true)}
              />
            </Box>
          </Card>
        </PageGrid>

        <Card>
          <Box gap={spacing.sm}>
            <Txt variant="h3">About POSA</Txt>
            <Txt variant="caption" color={palette.textMuted}>
              Offline-first point of sale and retail operations. Built so that
              connectivity enhances the shop rather than deciding whether it can
              trade.
            </Txt>
            <Divider />
            <KeyValue label="Version" value="1.0.0" mono />
            <KeyValue label="Storage engine" value={app.storeKind} mono />
            <KeyValue
              label="Signed in as"
              value={`${app.session?.fullName ?? "—"} (${app.session?.role ?? "—"})`}
            />
          </Box>
        </Card>
      </Page>

      <Sheet
        visible={confirmWipe}
        title="Reset this terminal?"
        subtitle="This cannot be undone"
        onClose={() => {
          setConfirmWipe(false);
          setConfirmText("");
        }}
        width={520}
        footer={
          <>
            <Button
              label="Cancel"
              variant="ghost"
              onPress={() => {
                setConfirmWipe(false);
                setConfirmText("");
              }}
            />
            <Button
              label="Wipe and start fresh"
              variant="danger"
              icon="delete-forever-outline"
              disabled={confirmText.trim().toUpperCase() !== "RESET"}
              onPress={() => {
                setConfirmWipe(false);
                setConfirmText("");
                void app.resetTerminal();
              }}
            />
          </>
        }
      >
        <Box gap={spacing.md}>
          <Txt variant="label" color={palette.textMuted}>
            Type RESET to confirm
          </Txt>
          <View
            style={{
              backgroundColor: palette.surfaceRaised,
              borderRadius: 8,
              padding: spacing.md,
            }}
          >
            <Txt variant="mono" color={palette.textSecondary}>
              {confirmText || "Type RESET here..."}
            </Txt>
          </View>
          <Txt variant="caption" color={palette.textMuted}>
            On a connected terminal, sync everything first from the Sync Center
            so nothing is stranded.
          </Txt>
        </Box>
      </Sheet>
    </View>
  );
}

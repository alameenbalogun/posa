/**
 * POSA sign-in — v4.
 *
 * Two entry paths:
 *   1. PIN sign-in (offline, existing device with local users)
 *   2. Cloud sign-in (new device or first-time linking — email + password)
 *
 * When cloud credentials are present but the terminal is not yet linked,
 * the sign-in screen prominently offers a one-click "Connect to cloud" flow.
 * Once linked, sync starts automatically.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { Redirect, useRouter } from "expo-router";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import {
  Box,
  Button,
  Card,
  Divider,
  EmptyState,
  TextField,
  Txt,
  styles as primitives,
} from "@/ui/primitives";
import { NoticeBar, SyncPill } from "@/ui/shell";
import { useApp } from "@/state/app";
import { isSupabaseConfigured } from "@/cloud/config";
import { resendCloudConfirmation } from "@/cloud/identity";
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "@/domain/permissions";
import { palette, radius, spacing, tone } from "@/ui/theme";

export default function SignInScreen() {
  const phase = useApp((state) => state.phase);
  const users = useApp((state) => state.users);
  const business = useApp((state) => state.business);
  const storeKind = useApp((state) => state.storeKind);
  const branch = useApp((state) => state.branch);
  const signInWithPin = useApp((state) => state.signInWithPin);
  const joinCloudWorkspace = useApp((state) => state.joinCloudWorkspace);
  const connectCloud = useApp((state) => state.connectCloud);
  const syncStatus = useApp((state) => state.syncStatus);
  const router = useRouter();

  const [selected, setSelected] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Cloud connection state
  const [showCloudSheet, setShowCloudSheet] = useState(false);
  const [cloudEmail, setCloudEmail] = useState(business?.email ?? "");
  const [cloudPassword, setCloudPassword] = useState("");
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [confirmationPending, setConfirmationPending] = useState(false);
  const [cloudBusy, setCloudBusy] = useState(false);

  const entrance = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(entrance, {
      toValue: 1,
      duration: 560,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [entrance]);

  const activeUsers = useMemo(
    () => users.filter((user) => user.status === "active"),
    [users],
  );

  const cloudConfigured = isSupabaseConfigured();
  const cloudLinked = syncStatus.cloudConfigured;
  const needsLinking = cloudConfigured && !cloudLinked;

  if (phase === "booting") {
    return (
      <View style={styles.page}>
        <View style={styles.loadingState}>
          <Txt variant="h2">Opening this terminal…</Txt>
          <Txt variant="body" color={palette.textMuted}>
            Restoring local accounts and preparing cloud sync.
          </Txt>
        </View>
      </View>
    );
  }

  if (phase === "ready") return <Redirect href={"(app)" as never} />;

  const submitPin = async () => {
    if (!selected) {
      setError("Choose your name first.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await signInWithPin(selected, pin);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      setPin("");
      return;
    }
    router.replace("/(app)" as never);
  };

  const press = (digit: string) => {
    setError(null);
    if (digit === "del") {
      setPin((current) => current.slice(0, -1));
      return;
    }
    if (pin.length >= 8) return;
    const next = pin + digit;
    setPin(next);
    if (selected && next.length >= 4 && next.length <= 6) {
      setTimeout(() => {
        void (async () => {
          setBusy(true);
          const result = await signInWithPin(selected, next);
          setBusy(false);
          if (!result.ok) {
            setError(result.error);
            setPin("");
          }
        })();
      }, 120);
    }
  };

  const handleCloudConnect = async () => {
    if (!cloudEmail.trim() || cloudPassword.length < 8) {
      setCloudError(
        "Enter the workspace email and a password of at least 8 characters.",
      );
      return;
    }
    setCloudBusy(true);
    setCloudError(null);
    setConfirmationPending(false);
    try {
      if (users.length === 0) {
        await joinCloudWorkspace(cloudEmail.trim(), cloudPassword);
      } else {
        await connectCloud(cloudEmail.trim(), cloudPassword);
      }
      setShowCloudSheet(false);
      // Engine is now linked and syncing
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Cloud connection failed.";
      setConfirmationPending(
        message.startsWith("EMAIL_CONFIRMATION_REQUIRED:"),
      );
      setCloudError(message.replace(/^EMAIL_CONFIRMATION_REQUIRED:\s*/, ""));
    } finally {
      setCloudBusy(false);
    }
  };

  return (
    <View style={styles.page}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Animated.View
          style={[
            styles.column,
            {
              opacity: entrance,
              transform: [
                {
                  translateY: entrance.interpolate({
                    inputRange: [0, 1],
                    outputRange: [18, 0],
                  }),
                },
              ],
            },
          ]}
        >
          {/* Brand */}
          <Box gap={spacing.lg} style={styles.brandHeader}>
            <View style={styles.mark}>
              <Image
                source={require("../assets/icon.png")}
                style={styles.brandImage}
              />
            </View>
            <Box>
              <Txt variant="h1">Welcome back</Txt>
              <Txt variant="body" color={palette.textMuted}>
                {business?.name ?? "POSA"} · {branch?.name ?? "Your terminal"}
              </Txt>
            </Box>
          </Box>

          {/* Cloud status — prominent when not linked */}
          {needsLinking ? (
            <Card toneName="warning" style={styles.cloudBanner}>
              <Box gap={spacing.md}>
                <Box row gap={spacing.md} style={styles.alignStart}>
                  <MaterialCommunityIcons
                    name="cloud-upload-outline"
                    size={22}
                    color={palette.warning}
                  />
                  <Box style={primitives.flex} gap={spacing.xs}>
                    <Txt variant="bodyStrong" color={palette.warning}>
                      This terminal is not synced to the cloud
                    </Txt>
                    <Txt variant="caption" color={palette.textSecondary}>
                      Cloud credentials are configured but this device has not
                      been linked yet. Connect now to upload all local data and
                      enable automatic syncing with other devices.
                    </Txt>
                  </Box>
                </Box>
                <Button
                  label="Connect to cloud now"
                  variant="primary"
                  icon="cloud-sync-outline"
                  onPress={() => setShowCloudSheet(true)}
                  size="sm"
                />
              </Box>
            </Card>
          ) : cloudLinked ? (
            <NoticeBar
              toneName="accent"
              icon="cloud-check-outline"
              title="Cloud sync active"
              message="This terminal is linked and syncing automatically."
            />
          ) : null}
          {syncStatus.lastError ? (
            <NoticeBar
              toneName="warning"
              icon="alert-circle-outline"
              title="Cloud sync needs attention"
              message={syncStatus.lastError}
            />
          ) : null}
          {storeKind === "memory" ? (
            <NoticeBar
              toneName="warning"
              icon="database-alert-outline"
              title="Temporary browser storage"
              message="IndexedDB is unavailable. Data will not survive a reload; enable browser site storage before using this terminal."
            />
          ) : null}

          <Card padded={false} style={styles.card} elevated>
            {!selected ? (
              <Box padding={spacing.xl} gap={spacing.lg}>
                <Box gap={spacing.xs}>
                  <Txt variant="overline" color={palette.accent}>
                    YOUR TEAM
                  </Txt>
                  <Txt variant="h2">Who is at the till?</Txt>
                  <Txt variant="body" color={palette.textMuted}>
                    Choose your profile, then enter your private PIN.
                  </Txt>
                </Box>
                {activeUsers.length === 0 ? (
                  <EmptyState
                    icon="account-off-outline"
                    title="No users on this terminal"
                    message={
                      cloudConfigured
                        ? "Sign in with your workspace account to download staff accounts and enable automatic sync."
                        : "This device has no staff accounts yet. Create the workspace here or configure cloud sync."
                    }
                    action={
                      cloudConfigured ? (
                        <Button
                          label="Sign in to workspace"
                          variant="primary"
                          icon="cloud-download-outline"
                          onPress={() => setShowCloudSheet(true)}
                        />
                      ) : undefined
                    }
                    compact
                  />
                ) : (
                  <Box gap={spacing.sm}>
                    {activeUsers.map((user) => {
                      const t = tone(
                        user.role === "owner"
                          ? "accent"
                          : user.role === "manager"
                            ? "violet"
                            : "info",
                      );
                      return (
                        <Pressable
                          key={user.id}
                          onPress={() => {
                            setSelected(user.id);
                            setPin("");
                            setError(null);
                          }}
                          style={({ pressed }) => [
                            styles.userRow,
                            pressed && styles.userRowPressed,
                          ]}
                        >
                          <View style={[styles.avatar, { borderColor: t.fg }]}>
                            <Txt variant="label" color={t.fg}>
                              {initialsOf(user.fullName)}
                            </Txt>
                          </View>
                          <Box style={primitives.flex}>
                            <Txt variant="h3">{user.fullName}</Txt>
                            <Txt
                              variant="caption"
                              color={palette.textMuted}
                              numberOfLines={1}
                            >
                              {ROLE_LABELS[user.role]} ·{" "}
                              {ROLE_DESCRIPTIONS[user.role]}
                            </Txt>
                          </Box>
                          <MaterialCommunityIcons
                            name="chevron-right"
                            size={20}
                            color={palette.textFaint}
                          />
                        </Pressable>
                      );
                    })}
                  </Box>
                )}
                <Divider />
                <Box row gap={spacing.sm} style={styles.offlineNote}>
                  <MaterialCommunityIcons
                    name="wifi-off"
                    size={16}
                    color={palette.accent}
                  />
                  <Txt
                    variant="caption"
                    color={palette.textSecondary}
                    style={primitives.flex}
                  >
                    Offline sign-in is ready. Your PIN stays on this device.
                  </Txt>
                </Box>
              </Box>
            ) : (
              <Box padding={spacing.xl} gap={spacing.lg}>
                <Box row gap={spacing.md}>
                  <Button
                    label="Back"
                    variant="ghost"
                    icon="arrow-left"
                    size="sm"
                    onPress={() => {
                      setSelected(null);
                      setPin("");
                      setError(null);
                    }}
                  />
                  <Box style={primitives.flex}>
                    <Txt variant="h2">
                      {
                        activeUsers.find((user) => user.id === selected)
                          ?.fullName
                      }
                    </Txt>
                    <Txt variant="body" color={palette.textMuted}>
                      Enter your private PIN
                    </Txt>
                  </Box>
                </Box>

                <View style={styles.pinRow}>
                  {Array.from({ length: Math.max(4, pin.length) }).map(
                    (_, index) => (
                      <View
                        key={index}
                        style={[
                          styles.pinDot,
                          index < pin.length ? styles.pinDotFilled : null,
                          error ? styles.pinDotError : null,
                        ]}
                      />
                    ),
                  )}
                </View>
                {pin.length > 0 && pin.length < 4 ? (
                  <Txt
                    variant="caption"
                    color={palette.textFaint}
                    align="center"
                  >
                    {4 - pin.length} more digit{4 - pin.length === 1 ? "" : "s"}
                  </Txt>
                ) : null}

                {error ? (
                  <Box row gap={spacing.xs} style={styles.errorRow}>
                    <MaterialCommunityIcons
                      name="alert-circle-outline"
                      size={14}
                      color={palette.danger}
                    />
                    <Txt variant="caption" color={palette.danger}>
                      {error}
                    </Txt>
                  </Box>
                ) : null}

                <View style={styles.pad}>
                  {[
                    "1",
                    "2",
                    "3",
                    "4",
                    "5",
                    "6",
                    "7",
                    "8",
                    "9",
                    "",
                    "0",
                    "del",
                  ].map((key) => {
                    if (key === "") {
                      return <View key="empty" style={styles.padCell} />;
                    }
                    return (
                      <View key={key} style={styles.padCell}>
                        <Button
                          label={key === "del" ? "⌫" : key}
                          variant={key === "del" ? "ghost" : "subtle"}
                          size="lg"
                          mono
                          fullWidth
                          onPress={() => press(key)}
                        />
                      </View>
                    );
                  })}
                </View>

                <Button
                  label="Sign in"
                  variant="primary"
                  size="lg"
                  icon="login"
                  fullWidth
                  loading={busy}
                  disabled={pin.length < 4}
                  onPress={() => void submitPin()}
                />
              </Box>
            )}
          </Card>

          {/* Footer */}
          <Box row style={styles.footer}>
            <SyncPill />
            <Txt variant="caption" color={palette.textFaint}>
              POSA v1.0 · works without internet
            </Txt>
          </Box>
        </Animated.View>
      </ScrollView>

      {/* Cloud connection sheet */}
      {showCloudSheet ? (
        <View style={styles.sheetOverlay}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => {
              setShowCloudSheet(false);
              setCloudError(null);
            }}
          />
          <View style={styles.sheet}>
            <Box gap={spacing.lg}>
              <Box gap={spacing.xs}>
                <Txt variant="h2">
                  {users.length === 0
                    ? "Sign in to workspace"
                    : "Connect to cloud"}
                </Txt>
                <Txt variant="body" color={palette.textMuted}>
                  {users.length === 0
                    ? "Use the workspace account to register this terminal and download staff, products and stock."
                    : "Sign in with the owner account to link this terminal. All local data will upload automatically."}
                </Txt>
              </Box>
              <TextField
                label={users.length === 0 ? "Workspace email" : "Owner email"}
                value={cloudEmail}
                onChangeText={setCloudEmail}
                keyboardType="email-address"
                placeholder="owner@shop.com"
                icon="email-outline"
              />
              <TextField
                label={
                  users.length === 0 ? "Workspace password" : "Owner password"
                }
                value={cloudPassword}
                onChangeText={setCloudPassword}
                secureTextEntry
                placeholder="At least 8 characters"
                icon="cloud-lock-outline"
              />
              {cloudError ? (
                <Box row gap={spacing.sm} style={styles.errorBox}>
                  <MaterialCommunityIcons
                    name="alert-circle-outline"
                    size={16}
                    color={palette.danger}
                  />
                  <Txt
                    variant="caption"
                    color={palette.danger}
                    style={{ flex: 1 }}
                  >
                    {cloudError}
                  </Txt>
                </Box>
              ) : null}
              {confirmationPending ? (
                <Card toneName="info">
                  <Box gap={spacing.sm}>
                    <Txt variant="bodyStrong" color={palette.info}>
                      Confirm your email before continuing
                    </Txt>
                    <Txt variant="caption" color={palette.textSecondary}>
                      Supabase sent a confirmation link to {cloudEmail}. Open it
                      first, then return here and press Connect again.
                    </Txt>
                    <Button
                      label="Resend confirmation email"
                      variant="secondary"
                      icon="email-fast-outline"
                      loading={cloudBusy}
                      onPress={() => {
                        setCloudBusy(true);
                        void (async () => {
                          try {
                            await resendCloudConfirmation(cloudEmail.trim());
                            setCloudError("A new confirmation email was sent.");
                          } catch (caught) {
                            setCloudError(
                              caught instanceof Error
                                ? caught.message
                                : "Could not resend the confirmation email.",
                            );
                          } finally {
                            setCloudBusy(false);
                          }
                        })();
                      }}
                    />
                  </Box>
                </Card>
              ) : null}
              <Txt variant="caption" color={palette.textFaint}>
                {users.length === 0
                  ? "After sign-in, the terminal downloads the current staff directory and operational data. Staff then use their local PINs."
                  : "If this is the first time, a cloud account is created automatically. On other devices, use the same email and password to access the same business data."}
              </Txt>
              <Box row gap={spacing.sm}>
                <Button
                  label="Cancel"
                  variant="ghost"
                  onPress={() => {
                    setShowCloudSheet(false);
                    setCloudError(null);
                  }}
                  style={{ flex: 1 }}
                />
                <Button
                  label={
                    cloudBusy
                      ? "Signing in…"
                      : users.length === 0
                        ? "Sign in"
                        : "Connect"
                  }
                  variant="primary"
                  icon="cloud-sync-outline"
                  loading={cloudBusy}
                  onPress={() => void handleCloudConnect()}
                  style={{ flex: 1 }}
                />
              </Box>
            </Box>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

const styles = StyleSheet.create({
  loadingState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    padding: spacing.xl,
  },
  page: {
    flex: 1,
    backgroundColor: palette.bg,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
  },
  column: { width: "100%", maxWidth: 520, gap: spacing.xl },
  brandHeader: { alignItems: "center" },
  mark: {
    width: 56,
    height: 56,
    borderRadius: radius.lg,
    backgroundColor: palette.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  brandImage: { width: 38, height: 38, borderRadius: 10 },
  card: { overflow: "hidden" },
  cloudBanner: { borderWidth: 1 },
  alignStart: { alignItems: "flex-start" },
  userRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.surface,
  },
  userRowPressed: {
    backgroundColor: palette.accentSoft,
    borderColor: palette.accentBorder,
    transform: [{ scale: 0.99 }],
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.surfaceRaised,
  },
  pinRow: {
    flexDirection: "row",
    gap: spacing.md,
    justifyContent: "center",
    paddingVertical: spacing.sm,
  },
  pinDot: {
    width: 16,
    height: 16,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: palette.borderStrong,
    backgroundColor: "transparent",
  },
  pinDotFilled: {
    backgroundColor: palette.accent,
    borderColor: palette.accent,
  },
  pinDotError: {
    borderColor: palette.danger,
    backgroundColor: palette.dangerSoft,
  },
  errorRow: { justifyContent: "center" },
  pad: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  padCell: { width: `${(100 - 6) / 3}%` },
  footer: { justifyContent: "space-between" },
  offlineNote: {
    alignItems: "center",
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: palette.accentSofter,
  },
  // Cloud sheet
  sheetOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
    zIndex: 100,
  },
  sheet: {
    backgroundColor: palette.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    padding: spacing.xl,
    width: "100%",
    maxWidth: 440,
  },
  errorBox: {
    backgroundColor: "rgba(239, 68, 68, 0.1)",
    borderRadius: 8,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.3)",
  },
});

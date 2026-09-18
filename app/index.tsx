import React from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Redirect } from "expo-router";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { Box, Button, Card, Txt } from "@/ui/primitives";
import { useApp } from "@/state/app";
import { palette, radius, spacing } from "@/ui/theme";

/**
 * Boot gate.
 *
 * The terminal opens to a usable local state without waiting for anything
 * external (PRD §39). Concretely: this screen only ever awaits local storage.
 * There is no network call, no auth round trip and no remote config fetch on the
 * critical path — so a shop with no internet still reaches the sign-in screen in
 * the time it takes SQLite or IndexedDB to open.
 */
export default function BootScreen() {
  const phase = useApp((state) => state.phase);
  const bootError = useApp((state) => state.bootError);
  const bootstrap = useApp((state) => state.bootstrap);

  if (phase === "failed") {
    return (
      <View style={styles.center}>
        <Card style={styles.card} toneName="danger">
          <Box gap={spacing.md}>
            <Box row gap={spacing.sm}>
              <MaterialCommunityIcons
                name="database-alert-outline"
                size={22}
                color={palette.danger}
              />
              <Txt variant="h2">Storage could not be opened</Txt>
            </Box>
            <Txt variant="body" color={palette.textSecondary}>
              POSA stores every sale on this device, so it cannot start without
              local storage. On the web this usually means the browser is
              blocking site data — check that cookies and site data are allowed,
              then try again.
            </Txt>
            {bootError ? (
              <Txt variant="mono" color={palette.danger}>
                {bootError}
              </Txt>
            ) : null}
            <Button
              label="Try again"
              variant="primary"
              icon="refresh"
              onPress={() => void bootstrap()}
            />
          </Box>
        </Card>
      </View>
    );
  }

  if (phase === "ready") return <Redirect href={"/(app)" as never} />;
  if (phase === "signin") return <Redirect href={"/sign-in" as never} />;
  // First run: a shop with no local business record sets itself up rather than
  // being handed demo data and having to work out what is real.
  if (phase === "onboarding") return <Redirect href={"/onboarding" as never} />;

  return (
    <View style={styles.center}>
      <Box gap={spacing.lg} style={styles.splash}>
        <View style={styles.mark}>
          <MaterialCommunityIcons
            name="storefront-outline"
            size={34}
            color={palette.textInverse}
          />
        </View>
        <Box gap={4}>
          <Txt variant="display">POSA</Txt>
          <Txt variant="body" color={palette.textMuted}>
            Point of Sale &amp; Retail Operations
          </Txt>
        </Box>
        <Box row gap={spacing.sm} style={styles.status}>
          <ActivityIndicator size="small" color={palette.accent} />
          <Txt variant="caption" color={palette.textMuted}>
            Opening local database…
          </Txt>
        </Box>
      </Box>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
    backgroundColor: palette.bg,
  },
  splash: { alignItems: "center" },
  mark: {
    width: 72,
    height: 72,
    borderRadius: radius.xl,
    backgroundColor: palette.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  status: { marginTop: spacing.sm },
  card: { maxWidth: 520 },
});

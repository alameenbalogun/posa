import React, { useEffect, useState } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { Redirect, Stack } from "expo-router";
import { Sidebar } from "@/ui/shell";
import { useApp } from "@/state/app";
import { useCart } from "@/state/cart";
import { palette, layout, spacing } from "@/ui/theme";

/**
 * Authenticated shell.
 *
 * Guards the whole route group in one place rather than per screen — a permission
 * check that each screen has to remember is a permission check that will
 * eventually be forgotten.
 *
 * The navigation rail collapses automatically on narrower viewports. There is no
 * "mobile app" and "desktop app"; there is one till that adapts, which is what
 * lets a shop move between a tablet and a counter PC without re-training staff.
 */
export default function AppLayout() {
  const phase = useApp((state) => state.phase);
  const subject = useApp((state) => state.subject);
  const syncStatus = useApp((state) => state.syncStatus);
  const beginSale = useCart((state) => state.beginSale);
  const { width } = useWindowDimensions();
  const [manualCollapse, setManualCollapse] = useState<boolean | null>(null);

  const narrow = width < 1024;
  const collapsed = manualCollapse ?? narrow;

  // A till should always have a cart open and ready. Beginning the sale on entry
  // means a scan works instantly without the operator pressing anything first.
  useEffect(() => {
    if (phase === "ready") beginSale();
  }, [phase, beginSale]);

  if (phase === "booting" || phase === "onboarding")
    return <Redirect href={"/sign-in" as never} />;
  if (phase !== "ready" || !subject)
    return <Redirect href={"/sign-in" as never} />;

  return (
    <View style={styles.shell}>
      {!narrow ? <Sidebar collapsed={collapsed} /> : null}
      <View style={styles.content}>
        {!syncStatus.cloudConfigured ? (
          <View style={styles.localOnlyStrip} />
        ) : null}
        <Stack
          screenOptions={{
            headerShown: false,
            // Keep the navigator scene inside the viewport between the rail and
            // the top status strip. Without an explicit minimum height, web
            // layout can let the scene grow with its contents, which makes a
            // child ScrollView look stuck instead of giving it scroll space.
            contentStyle: {
              flex: 1,
              minHeight: 0,
              backgroundColor: palette.bg,
            },
            animation: "fade",
          }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
    backgroundColor: palette.bg,
  },
  content: { flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden" },
  /** A 3px rule reminds the operator that nothing is leaving the building. */
  localOnlyStrip: {
    height: 3,
    backgroundColor: palette.info,
    opacity: 0.7,
  },
});

export const LAYOUT = { sidebarWidth: layout.sidebarWidth, gap: spacing.md };

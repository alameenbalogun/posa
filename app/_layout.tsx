import React, { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { ToastStack } from "@/ui/patterns";
import { useApp } from "@/state/app";
import { palette } from "@/ui/theme";

/**
 * Root layout.
 *
 * Renders the navigation stack plus the two things that must sit above every
 * screen regardless of route: the status bar treatment and the toast overlay.
 * Keeping the toaster here means a screen can raise a notification and navigate
 * away without the message vanishing.
 */
export default function RootLayout() {
  const toasts = useApp((state) => state.toasts);
  const dismissToast = useApp((state) => state.dismissToast);
  const phase = useApp((state) => state.phase);
  const bootstrap = useApp((state) => state.bootstrap);

  // Bootstrap belongs to the root navigator, not only to `/`. Users can open
  // `/sign-in` directly or refresh that route, so relying on app/index.tsx
  // leaves the local store unset and produces "Local storage is not ready yet".
  useEffect(() => {
    if (phase === "booting") void bootstrap();
  }, [bootstrap, phase]);

  return (
    <SafeAreaProvider>
      <View style={styles.root}>
        <StatusBar style="dark" />
        <SafeAreaView style={styles.root} edges={["top", "left", "right"]}>
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: palette.bg },
              animation: "fade",
            }}
          >
            <Stack.Screen name="landing" options={{ animation: "fade" }} />
          </Stack>
        </SafeAreaView>
        <ToastStack toasts={toasts} onDismiss={dismissToast} />
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.bg },
});

import React, { useEffect, useRef } from "react";
import {
  Animated,
  Easing,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { Box, Button, Card, Txt } from "@/ui/primitives";
import { palette, radius, spacing, tone } from "@/ui/theme";

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>["name"];

const PILLARS: Array<{
  icon: IconName;
  title: string;
  text: string;
  toneName: "accent" | "info" | "violet";
}> = [
  {
    icon: "barcode-scan",
    title: "Checkout that never waits",
    text: "Search, scan, price and take payment locally. The till stays fast even when the internet disappears.",
    toneName: "accent",
  },
  {
    icon: "warehouse",
    title: "Stock you can trust",
    text: "Every movement is recorded in an append-only ledger, from opening stock to the last item sold.",
    toneName: "info",
  },
  {
    icon: "cloud-sync-outline",
    title: "Cloud when you need it",
    text: "Work offline first, then sync branches safely with an auditable queue and conflict handling.",
    toneName: "violet",
  },
];

const FLOW = [
  {
    number: "01",
    title: "Open the till",
    text: "Sign in locally and start a shift in seconds.",
  },
  {
    number: "02",
    title: "Sell naturally",
    text: "Scan or search products, then take cash, card or transfer.",
  },
  {
    number: "03",
    title: "Keep moving",
    text: "Sales and stock are durable now; sync is handled in the background.",
  },
];

export default function LandingScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const compact = width < 860;
  const intro = useRef(new Animated.Value(0)).current;
  const float = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(intro, {
      toValue: 1,
      duration: 700,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(float, {
          toValue: 1,
          duration: 2600,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(float, {
          toValue: 0,
          duration: 2600,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [float, intro]);

  const introStyle = {
    opacity: intro,
    transform: [
      {
        translateY: intro.interpolate({
          inputRange: [0, 1],
          outputRange: [24, 0],
        }),
      },
    ],
  };
  const floatStyle = {
    transform: [
      {
        translateY: float.interpolate({
          inputRange: [0, 1],
          outputRange: [0, -10],
        }),
      },
    ],
  };

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={styles.pageContent}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.navbar}>
        <Box row gap={spacing.sm} style={styles.logoRow}>
          <View style={styles.logo}>
            <MaterialCommunityIcons
              name="storefront-outline"
              size={18}
              color={palette.textInverse}
            />
          </View>
          <Box gap={2}>
            <Txt variant="h3">POSA</Txt>
            <Txt variant="caption" color={palette.textMuted}>
              Retail, without the drama.
            </Txt>
          </Box>
        </Box>
        <Box row gap={spacing.sm} style={styles.navActions}>
          <Button
            label="Sign in"
            variant="ghost"
            size="sm"
            onPress={() => router.push("/sign-in" as never)}
          />
          <Button
            label="Create workspace"
            variant="primary"
            size="sm"
            icon="arrow-right"
            onPress={() => router.push("/onboarding" as never)}
          />
        </Box>
      </View>

      <View style={[styles.hero, compact && styles.heroCompact]}>
        <View style={styles.heroGlow} />
        <Animated.View style={[styles.heroCopy, introStyle]}>
          <View style={styles.eyebrow}>
            <View style={styles.liveDot} />
            <Txt variant="label" color="#B6F2E8">
              BUILT FOR THE BUSY COUNTER
            </Txt>
          </View>
          <Txt
            variant="display"
            color={palette.textInverse}
            style={styles.heroTitle}
          >
            Your shop should keep selling.
          </Txt>
          <Txt variant="body" color="#C6D5E8" style={styles.heroText}>
            POSA is the calm, dependable operating system for retail—fast at the
            till, clear in the back office, and ready when the connection is
            not.
          </Txt>
          <Box
            row
            gap={spacing.md}
            style={[styles.heroButtons, compact && styles.stackButtons]}
          >
            <Button
              label="Set up your shop"
              variant="primary"
              size="lg"
              icon="storefront-outline"
              onPress={() => router.push("/onboarding" as never)}
            />
            <Button
              label="Explore the workflow"
              variant="secondary"
              size="lg"
              icon="play-circle-outline"
              onPress={() => undefined}
            />
          </Box>
          <Box row gap={spacing.md} style={styles.trustRow}>
            <MaterialCommunityIcons name="wifi-off" size={16} color="#B6F2E8" />
            <Txt variant="caption" color="#C6D5E8">
              Works offline from day one
            </Txt>
            <View style={styles.trustDivider} />
            <MaterialCommunityIcons
              name="shield-check-outline"
              size={16}
              color="#B6F2E8"
            />
            <Txt variant="caption" color="#C6D5E8">
              Every sale is durable
            </Txt>
          </Box>
        </Animated.View>

        <Animated.View
          style={[
            styles.previewWrap,
            compact && styles.previewCompact,
            floatStyle,
          ]}
        >
          <View style={styles.previewShadow} />
          <View style={styles.previewWindow}>
            <View style={styles.previewTop}>
              <View style={styles.windowDots}>
                <View />
                <View />
                <View />
              </View>
              <Txt variant="caption" color={palette.textMuted}>
                POSA · Checkout
              </Txt>
              <MaterialCommunityIcons
                name="wifi-off"
                size={15}
                color={palette.warning}
              />
            </View>
            <View style={styles.previewBody}>
              <Box row style={styles.previewHeader}>
                <Box gap={4}>
                  <Txt variant="caption" color={palette.textMuted}>
                    CURRENT SALE
                  </Txt>
                  <Txt variant="h3">Good morning, Amina</Txt>
                </Box>
                <View style={styles.previewAvatar}>
                  <Txt variant="caption" color={palette.accent}>
                    AY
                  </Txt>
                </View>
              </Box>
              <View style={styles.searchMock}>
                <MaterialCommunityIcons
                  name="magnify"
                  size={16}
                  color={palette.textMuted}
                />
                <Txt variant="caption" color={palette.textFaint}>
                  Scan or search a product...
                </Txt>
              </View>
              <Box row gap={spacing.sm} style={styles.productMocks}>
                <MockProduct
                  icon="coffee-outline"
                  label="Coffee 100g"
                  price="₦3,600"
                />
                <MockProduct
                  icon="bottle-soda-outline"
                  label="Malt Drink"
                  price="₦450"
                />
                <MockProduct icon="rice" label="Rice 5kg" price="₦7,500" />
              </Box>
              <View style={styles.previewTotal}>
                <Box gap={3}>
                  <Txt variant="caption" color={palette.textMuted}>
                    3 items · saved locally
                  </Txt>
                  <Txt variant="h2">₦11,550</Txt>
                </Box>
                <View style={styles.payMock}>
                  <Txt variant="label" color={palette.textInverse}>
                    PAY NOW
                  </Txt>
                </View>
              </View>
            </View>
          </View>
        </Animated.View>
      </View>

      <View style={styles.proofStrip}>
        {[
          ["∞", "No lost sales"],
          ["<100ms", "Local lookup"],
          ["100%", "Auditable"],
          ["24/7", "Ready to trade"],
        ].map(([value, label]) => (
          <Box key={label} gap={2} style={styles.proofItem}>
            <Txt variant="h2" color={palette.accent}>
              {value}
            </Txt>
            <Txt variant="caption" color={palette.textMuted}>
              {label}
            </Txt>
          </Box>
        ))}
      </View>

      <View style={styles.section}>
        <View style={styles.sectionInner}>
          <Box gap={spacing.sm} style={styles.sectionHeading}>
            <Txt variant="overline" color={palette.accent}>
              THE WHOLE OPERATION
            </Txt>
            <Txt variant="h1">Simple at the front. Serious underneath.</Txt>
            <Txt
              variant="body"
              color={palette.textSecondary}
              style={styles.headingText}
            >
              The best retail software disappears into the rhythm of the shop.
              POSA gives your team speed without sacrificing control.
            </Txt>
          </Box>
          <View style={[styles.pillars, compact && styles.pillarsCompact]}>
            {PILLARS.map((pillar) => {
              const t = tone(pillar.toneName);
              return (
                <Card key={pillar.title} style={styles.pillar}>
                  <View
                    style={[
                      styles.pillarIcon,
                      { backgroundColor: t.bg, borderColor: t.border },
                    ]}
                  >
                    <MaterialCommunityIcons
                      name={pillar.icon}
                      size={22}
                      color={t.fg}
                    />
                  </View>
                  <Txt variant="h2">{pillar.title}</Txt>
                  <Txt variant="body" color={palette.textSecondary}>
                    {pillar.text}
                  </Txt>
                  <Txt variant="label" color={t.fg}>
                    LEARN MORE{" "}
                    <MaterialCommunityIcons
                      name="arrow-right"
                      size={13}
                      color={t.fg}
                    />
                  </Txt>
                </Card>
              );
            })}
          </View>
        </View>
      </View>

      <View style={styles.workflowSection}>
        <View style={styles.sectionInner}>
          <Box gap={spacing.sm} style={styles.sectionHeading}>
            <Txt variant="overline" color={palette.accent}>
              A BETTER DAILY RHYTHM
            </Txt>
            <Txt variant="h1">From first scan to close-out.</Txt>
          </Box>
          <View style={[styles.flow, compact && styles.flowCompact]}>
            {FLOW.map((item, index) => (
              <View key={item.number} style={styles.flowItem}>
                <View style={styles.flowNumber}>
                  <Txt variant="label" color={palette.textInverse}>
                    {item.number}
                  </Txt>
                </View>
                {index < FLOW.length - 1 ? (
                  <View style={styles.flowLine} />
                ) : null}
                <Txt variant="h2">{item.title}</Txt>
                <Txt variant="body" color={palette.textSecondary}>
                  {item.text}
                </Txt>
              </View>
            ))}
          </View>
        </View>
      </View>

      <View style={styles.finalCta}>
        <View style={styles.finalCtaGlow} />
        <Box gap={spacing.md} style={styles.finalCtaInner}>
          <Txt variant="overline" color="#B6F2E8" align="center">
            READY WHEN YOU ARE
          </Txt>
          <Txt variant="h1" color={palette.textInverse} align="center">
            Open a better kind of till.
          </Txt>
          <Txt
            variant="body"
            color="#C6D5E8"
            align="center"
            style={styles.ctaText}
          >
            Set up your workspace in a few minutes. No card, no cloud account,
            no internet required.
          </Txt>
          <Button
            label="Start selling with POSA"
            variant="primary"
            size="lg"
            icon="arrow-right"
            onPress={() => router.push("/onboarding" as never)}
          />
        </Box>
      </View>

      <View style={styles.footer}>
        <Box row gap={spacing.sm} style={styles.logoRow}>
          <View style={styles.logo}>
            <MaterialCommunityIcons
              name="storefront-outline"
              size={16}
              color={palette.textInverse}
            />
          </View>
          <Txt variant="h3">POSA</Txt>
        </Box>
        <Txt variant="caption" color={palette.textFaint}>
          Point of Sale & Retail Operations · Offline-first, always ready.
        </Txt>
      </View>
    </ScrollView>
  );
}

function MockProduct({
  icon,
  label,
  price,
}: {
  icon: IconName;
  label: string;
  price: string;
}) {
  return (
    <View style={styles.mockProduct}>
      <View style={styles.mockIcon}>
        <MaterialCommunityIcons name={icon} size={17} color={palette.accent} />
      </View>
      <Txt variant="caption" numberOfLines={1}>
        {label}
      </Txt>
      <Txt variant="label" color={palette.accent}>
        {price}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.bg },
  pageContent: { paddingBottom: 0 },
  navbar: {
    width: "100%",
    maxWidth: 1240,
    alignSelf: "center",
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  logoRow: { alignItems: "center" },
  logo: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    backgroundColor: palette.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  navActions: { alignItems: "center" },
  hero: {
    position: "relative",
    overflow: "hidden",
    width: "100%",
    maxWidth: 1240,
    minHeight: 590,
    alignSelf: "center",
    borderRadius: radius.xxl,
    padding: spacing.xxxxl,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xxxl,
    backgroundColor: "#0B1F35",
  },
  heroCompact: {
    flexDirection: "column",
    alignItems: "stretch",
    padding: spacing.xl,
    minHeight: 0,
    borderRadius: radius.xl,
  },
  heroGlow: {
    position: "absolute",
    width: 520,
    height: 520,
    borderRadius: 260,
    right: -130,
    top: -180,
    backgroundColor: "rgba(20, 184, 166, 0.16)",
  },
  heroCopy: { flex: 1, zIndex: 1 },
  eyebrow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    alignSelf: "flex-start",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: "rgba(182,242,232,0.25)",
    backgroundColor: "rgba(182,242,232,0.08)",
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: palette.accentBright,
  },
  heroTitle: {
    maxWidth: 600,
    marginTop: spacing.xl,
    fontSize: 56,
    lineHeight: 60,
    letterSpacing: -2,
  },
  heroText: {
    maxWidth: 530,
    fontSize: 17,
    lineHeight: 27,
    marginTop: spacing.lg,
  },
  heroButtons: { marginTop: spacing.xl },
  stackButtons: { flexDirection: "column", alignItems: "stretch" },
  trustRow: { alignItems: "center", marginTop: spacing.xl },
  trustDivider: {
    width: 1,
    height: 16,
    backgroundColor: "rgba(198,213,232,0.3)",
  },
  previewWrap: { width: 500, marginRight: spacing.lg, zIndex: 1 },
  previewCompact: { width: "100%", marginRight: 0, marginTop: spacing.xl },
  previewShadow: {
    position: "absolute",
    left: 18,
    right: -12,
    top: 18,
    bottom: -12,
    borderRadius: radius.xl,
    backgroundColor: "rgba(20,184,166,0.18)",
  },
  previewWindow: {
    borderRadius: radius.xl,
    overflow: "hidden",
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.5)",
  },
  previewTop: {
    height: 38,
    paddingHorizontal: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: palette.surfaceRaised,
    borderBottomWidth: 1,
    borderBottomColor: palette.borderSubtle,
  },
  windowDots: { flexDirection: "row", gap: 5 },
  previewBody: { padding: spacing.lg, gap: spacing.md },
  previewHeader: { justifyContent: "space-between", alignItems: "center" },
  previewAvatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: palette.accentSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  searchMock: {
    height: 42,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.bgSubtle,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  productMocks: { flexWrap: "wrap" },
  mockProduct: {
    flex: 1,
    minWidth: 100,
    padding: spacing.sm,
    gap: 5,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: palette.borderSubtle,
    backgroundColor: palette.surfaceRaised,
  },
  mockIcon: {
    width: 28,
    height: 28,
    borderRadius: radius.sm,
    backgroundColor: palette.accentSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  previewTotal: {
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: palette.borderSubtle,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  payMock: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: palette.accent,
  },
  proofStrip: {
    width: "100%",
    maxWidth: 1100,
    alignSelf: "center",
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxl,
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    gap: spacing.xl,
  },
  proofItem: { minWidth: 130 },
  section: { paddingVertical: spacing.xxxxl, backgroundColor: palette.surface },
  sectionInner: {
    width: "100%",
    maxWidth: 1100,
    alignSelf: "center",
    paddingHorizontal: spacing.xl,
    gap: spacing.xxxl,
  },
  sectionHeading: { maxWidth: 680 },
  headingText: { maxWidth: 600 },
  pillars: { flexDirection: "row", gap: spacing.lg },
  pillarsCompact: { flexDirection: "column" },
  pillar: { flex: 1, gap: spacing.md, minHeight: 250 },
  pillarIcon: {
    width: 48,
    height: 48,
    borderRadius: radius.lg,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  workflowSection: {
    paddingVertical: spacing.xxxxl,
    backgroundColor: palette.bg,
  },
  flow: { flexDirection: "row", gap: spacing.lg },
  flowCompact: { flexDirection: "column" },
  flowItem: { flex: 1, position: "relative", gap: spacing.md },
  flowNumber: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: palette.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  flowLine: {
    position: "absolute",
    height: 1,
    left: 48,
    right: -spacing.lg,
    top: 20,
    backgroundColor: palette.accentBorder,
  },
  finalCta: {
    position: "relative",
    overflow: "hidden",
    width: "100%",
    backgroundColor: "#0B1F35",
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxxxl,
    alignItems: "center",
  },
  finalCtaGlow: {
    position: "absolute",
    width: 420,
    height: 420,
    borderRadius: 210,
    backgroundColor: "rgba(20,184,166,0.12)",
    top: -200,
  },
  finalCtaInner: { alignItems: "center", maxWidth: 620, zIndex: 1 },
  ctaText: { maxWidth: 500 },
  footer: {
    width: "100%",
    maxWidth: 1100,
    alignSelf: "center",
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxl,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
});

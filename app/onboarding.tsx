import React, { useRef, useState } from "react";
import {
  Animated,
  Easing,
  Image,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { CURRENCIES } from "@/domain/money";
import { validatePin } from "@/services/credentials";
import { useApp } from "@/state/app";
import {
  Box,
  Button,
  Card,
  Chip,
  ProgressBar,
  TextField,
  Txt,
} from "@/ui/primitives";
import { palette, radius, spacing } from "@/ui/theme";

const STEPS = [
  { label: "Business", icon: "storefront-outline" as const },
  { label: "Location", icon: "map-marker-outline" as const },
  { label: "Owner", icon: "account-lock-outline" as const },
  { label: "Operations", icon: "tune-variant" as const },
];

export default function OnboardingScreen() {
  const router = useRouter();
  const completeOnboarding = useApp((state) => state.completeOnboarding);
  const joinCloudWorkspace = useApp((state) => state.joinCloudWorkspace);
  const cloudLabel = useApp((state) => state.cloudLabel);
  const [step, setStep] = useState(0);
  const [businessName, setBusinessName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [businessPhone, setBusinessPhone] = useState("");
  const [businessEmail, setBusinessEmail] = useState("");
  const [businessAddress, setBusinessAddress] = useState("");
  const [branchName, setBranchName] = useState("Main Shop");
  const [branchCode, setBranchCode] = useState("MAIN");
  const [branchPhone, setBranchPhone] = useState("");
  const [branchAddress, setBranchAddress] = useState("");
  const [deviceName, setDeviceName] = useState("Front Counter");
  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerPhone, setOwnerPhone] = useState("");
  const [ownerPin, setOwnerPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [cloudPassword, setCloudPassword] = useState("");
  const [currency, setCurrency] = useState("NGN");
  const [taxInclusive, setTaxInclusive] = useState(true);
  const [allowNegativeStock, setAllowNegativeStock] = useState(true);
  const [offlineSessionMinutes, setOfflineSessionMinutes] = useState(720);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [joinEmail, setJoinEmail] = useState("");
  const [joinPassword, setJoinPassword] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joinBusy, setJoinBusy] = useState(false);
  const transition = useRef(new Animated.Value(1)).current;

  const cloudReady = cloudLabel.configured;

  const validEmail = (value: string) =>
    !value.trim() || /^\S+@\S+\.\S+$/.test(value.trim());

  const validateStep = () => {
    if (step === 0) {
      if (!businessName.trim())
        return "Add the trading name customers will see on receipts.";
      if (!businessPhone.trim())
        return "Add a business phone number for receipts and support.";
      if (!businessAddress.trim())
        return "Add the shop address so receipts identify the business.";
      if (!validEmail(businessEmail))
        return "Enter a valid business email or leave it blank.";
    }
    if (step === 1) {
      if (!branchName.trim() || !branchCode.trim())
        return "Add a branch name and a short receipt code.";
      if (!deviceName.trim())
        return "Name this terminal for sync and audit records.";
    }
    if (step === 2) {
      if (!ownerName.trim()) return "Add the owner or primary operator name.";
      const pinError = validatePin(ownerPin);
      if (pinError)
        return pinError === "Choose a PIN between 4 and 6 digits."
          ? "Choose an owner PIN between 4 and 6 digits."
          : pinError;
      if (ownerPin !== confirmPin) return "The two PIN entries do not match.";
      if (!validEmail(ownerEmail))
        return "Enter a valid owner email or leave it blank.";
      // When cloud credentials are present, require email + password for Supabase Auth
      if (cloudReady) {
        if (!ownerEmail.trim())
          return "Cloud sync is enabled. Add the owner email to link this business to the cloud.";
        if (cloudPassword.length < 8)
          return "Set a cloud password of at least 8 characters. This is used once to create the cloud account.";
      }
    }
    return null;
  };

  const next = () => {
    setError(null);
    const validationError = validateStep();
    if (validationError) {
      setError(validationError);
      return;
    }
    if (step < STEPS.length - 1) {
      moveToStep(step + 1);
      return;
    }
    void finish();
  };

  const moveToStep = (nextStep: number) => {
    Animated.timing(transition, {
      toValue: 0,
      duration: 140,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(() => {
      setStep(nextStep);
      Animated.timing(transition, {
        toValue: 1,
        duration: 260,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    });
  };

  const finish = async () => {
    setBusy(true);
    try {
      await completeOnboarding({
        businessName: businessName.trim(),
        legalName: legalName.trim(),
        businessPhone: businessPhone.trim(),
        businessEmail: businessEmail.trim(),
        businessAddress: businessAddress.trim(),
        branchName: branchName.trim(),
        branchCode: branchCode.trim().toUpperCase().slice(0, 5),
        branchPhone: branchPhone.trim(),
        branchAddress: branchAddress.trim(),
        deviceName: deviceName.trim(),
        ownerName: ownerName.trim(),
        ownerEmail: ownerEmail.trim(),
        ownerPhone: ownerPhone.trim(),
        ownerPin,
        cloudPassword,
        offlineSessionMinutes,
        allowNegativeStock,
        currency,
        taxInclusive,
      });
      router.replace("/sign-in" as never);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Setup could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  };

  const join = async () => {
    if (!joinEmail.trim() || joinPassword.length < 8) {
      setJoinError("Enter your workspace email and cloud password.");
      return;
    }
    setJoinBusy(true);
    setJoinError(null);
    try {
      await joinCloudWorkspace(joinEmail.trim(), joinPassword);
      router.replace("/sign-in" as never);
    } catch (caught) {
      setJoinError(
        caught instanceof Error
          ? caught.message
          : "Could not join the workspace.",
      );
    } finally {
      setJoinBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.panel}>
          <Box row gap={spacing.lg} style={styles.brand}>
            <View style={styles.mark}>
              <Image
                source={require("../assets/icon.png")}
                style={styles.brandImage}
              />
            </View>
            <Box style={styles.flex} gap={spacing.xs}>
              <Txt variant="h1">Set up your workspace</Txt>
              <Txt variant="body" color={palette.textMuted}>
                A few thoughtful details now make receipts, audits, stock and
                offline sign-in work properly later.
              </Txt>
            </Box>
          </Box>

          {cloudReady ? (
            <Card toneName="accent">
              <Box row gap={spacing.md} style={styles.alignStart}>
                <MaterialCommunityIcons
                  name="cloud-check-outline"
                  size={20}
                  color={palette.accent}
                />
                <Box style={styles.flex} gap={spacing.xs}>
                  <Txt variant="bodyStrong" color={palette.accent}>
                    Cloud sync is enabled
                  </Txt>
                  <Txt variant="caption" color={palette.textSecondary}>
                    Your development team has configured cloud credentials.
                    After setup, this terminal will sync automatically whenever
                    it is online. No manual configuration needed.
                  </Txt>
                </Box>
              </Box>
            </Card>
          ) : null}

          {cloudReady ? (
            <Card toneName="info">
              <Box gap={spacing.md}>
                <Box row gap={spacing.md} style={styles.alignStart}>
                  <MaterialCommunityIcons
                    name="login-variant"
                    size={20}
                    color={palette.info}
                  />
                  <Box style={styles.flex} gap={spacing.xs}>
                    <Txt variant="bodyStrong" color={palette.info}>
                      Already have a POSA workspace?
                    </Txt>
                    <Txt variant="caption" color={palette.textSecondary}>
                      Join it from this terminal. Staff, products and stock will
                      download automatically after cloud sign-in.
                    </Txt>
                  </Box>
                </Box>
                <Box row gap={spacing.md}>
                  <TextField
                    label="Workspace email"
                    value={joinEmail}
                    onChangeText={setJoinEmail}
                    keyboardType="email-address"
                    icon="email-outline"
                    style={styles.flex}
                  />
                  <TextField
                    label="Cloud password"
                    value={joinPassword}
                    onChangeText={setJoinPassword}
                    secureTextEntry
                    icon="cloud-lock-outline"
                    style={styles.flex}
                  />
                </Box>
                {joinError ? (
                  <Txt variant="caption" color={palette.danger}>
                    {joinError}
                  </Txt>
                ) : null}
                <Button
                  label="Join existing workspace"
                  variant="secondary"
                  icon="cloud-download-outline"
                  loading={joinBusy}
                  onPress={() => void join()}
                />
              </Box>
            </Card>
          ) : null}

          <Card padded={false} style={styles.stepCard}>
            <Box row gap={spacing.sm} style={styles.stepRail}>
              {STEPS.map((item, index) => (
                <Box key={item.label} gap={spacing.xs} style={styles.stepItem}>
                  <View
                    style={[
                      styles.stepIcon,
                      index <= step && styles.stepIconActive,
                    ]}
                  >
                    <MaterialCommunityIcons
                      name={item.icon}
                      size={17}
                      color={
                        index <= step ? palette.textInverse : palette.textFaint
                      }
                    />
                  </View>
                  <Txt
                    variant="caption"
                    color={index === step ? palette.accent : palette.textMuted}
                  >
                    {item.label}
                  </Txt>
                </Box>
              ))}
            </Box>
            <ProgressBar
              value={(step + 1) / STEPS.length}
              height={4}
              toneName="accent"
            />
          </Card>

          <Animated.View
            style={{
              opacity: transition,
              transform: [
                {
                  translateX: transition.interpolate({
                    inputRange: [0, 1],
                    outputRange: [18, 0],
                  }),
                },
              ],
            }}
          >
            <Card style={styles.formCard}>
              {step === 0 ? (
                <Box gap={spacing.lg}>
                  <StepHeading
                    eyebrow="BUSINESS PROFILE"
                    title="Tell us about the shop"
                    subtitle="These details identify the business on receipts, exports and audit records."
                  />
                  <TextField
                    label="Trading name"
                    value={businessName}
                    onChangeText={setBusinessName}
                    placeholder="Amina Stores"
                    icon="storefront-outline"
                    autoFocus
                  />
                  <TextField
                    label="Registered / legal name"
                    value={legalName}
                    onChangeText={setLegalName}
                    placeholder="Optional — e.g. Amina Retail Ltd"
                    icon="file-document-outline"
                  />
                  <Box row gap={spacing.md}>
                    <TextField
                      label="Business phone"
                      value={businessPhone}
                      onChangeText={setBusinessPhone}
                      placeholder="0803 000 0000"
                      keyboardType="phone-pad"
                      icon="phone-outline"
                      style={styles.flex}
                    />
                    <TextField
                      label="Business email"
                      value={businessEmail}
                      onChangeText={setBusinessEmail}
                      placeholder="owner@shop.com"
                      keyboardType="email-address"
                      icon="email-outline"
                      style={styles.flex}
                    />
                  </Box>
                  <TextField
                    label="Business address"
                    value={businessAddress}
                    onChangeText={setBusinessAddress}
                    placeholder="12 Market Road, Lagos"
                    icon="map-marker-outline"
                    multiline
                    hint="Used to identify the issuing business on receipts."
                  />
                </Box>
              ) : null}

              {step === 1 ? (
                <Box gap={spacing.lg}>
                  <StepHeading
                    eyebrow="LOCATION & TERMINAL"
                    title="Where will this till operate?"
                    subtitle="A branch and terminal identity keep stock movements and audit trails traceable."
                  />
                  <Box row gap={spacing.md}>
                    <TextField
                      label="Branch name"
                      value={branchName}
                      onChangeText={setBranchName}
                      placeholder="Main Shop"
                      icon="store-marker-outline"
                      style={styles.flex}
                    />
                    <TextField
                      label="Branch code"
                      value={branchCode}
                      onChangeText={(value) =>
                        setBranchCode(value.toUpperCase().slice(0, 5))
                      }
                      placeholder="MAIN"
                      mono
                      icon="tag-outline"
                      style={styles.codeField}
                      hint="Up to 5 characters"
                    />
                  </Box>
                  <TextField
                    label="Branch address"
                    value={branchAddress}
                    onChangeText={setBranchAddress}
                    placeholder="Leave blank to use the business address"
                    icon="map-marker-radius-outline"
                    multiline
                  />
                  <Box row gap={spacing.md}>
                    <TextField
                      label="Branch phone"
                      value={branchPhone}
                      onChangeText={setBranchPhone}
                      placeholder="Optional"
                      keyboardType="phone-pad"
                      icon="phone-outline"
                      style={styles.flex}
                    />
                    <TextField
                      label="Terminal name"
                      value={deviceName}
                      onChangeText={setDeviceName}
                      placeholder="Front Counter"
                      icon="tablet-cellphone"
                      style={styles.flex}
                    />
                  </Box>
                  <Card toneName="info">
                    <Box row gap={spacing.md} style={styles.alignStart}>
                      <MaterialCommunityIcons
                        name="information-outline"
                        size={20}
                        color={palette.info}
                      />
                      <Txt
                        variant="caption"
                        color={palette.textSecondary}
                        style={styles.flex}
                      >
                        POSA detects this device timezone automatically for
                        shift and day-boundary reporting.
                      </Txt>
                    </Box>
                  </Card>
                </Box>
              ) : null}

              {step === 2 ? (
                <Box gap={spacing.lg}>
                  <StepHeading
                    eyebrow="OWNER & SECURITY"
                    title="Create the primary operator"
                    subtitle="The owner account is available offline and protected by a local PIN hash."
                  />
                  <TextField
                    label="Owner full name"
                    value={ownerName}
                    onChangeText={setOwnerName}
                    placeholder="Amina Yusuf"
                    icon="account-outline"
                    autoFocus
                  />
                  <Box row gap={spacing.md}>
                    <TextField
                      label="Owner email"
                      value={ownerEmail}
                      onChangeText={setOwnerEmail}
                      placeholder={
                        cloudReady ? "Required for cloud sync" : "Optional"
                      }
                      keyboardType="email-address"
                      icon="email-outline"
                      style={styles.flex}
                      hint={
                        cloudReady
                          ? "Used to create the cloud account"
                          : undefined
                      }
                    />
                    <TextField
                      label="Owner phone"
                      value={ownerPhone}
                      onChangeText={setOwnerPhone}
                      placeholder="Optional"
                      keyboardType="phone-pad"
                      icon="phone-outline"
                      style={styles.flex}
                    />
                  </Box>
                  <Box row gap={spacing.md}>
                    <TextField
                      label="Owner PIN"
                      value={ownerPin}
                      onChangeText={(value) =>
                        setOwnerPin(value.replace(/[^0-9]/g, "").slice(0, 6))
                      }
                      keyboardType="numeric"
                      mono
                      secureTextEntry
                      icon="key-outline"
                      style={styles.flex}
                      hint="4–6 digits"
                    />
                    <TextField
                      label="Confirm PIN"
                      value={confirmPin}
                      onChangeText={(value) =>
                        setConfirmPin(value.replace(/[^0-9]/g, "").slice(0, 6))
                      }
                      keyboardType="numeric"
                      mono
                      secureTextEntry
                      icon="shield-check-outline"
                      style={styles.flex}
                    />
                  </Box>
                  {cloudReady ? (
                    <Box gap={spacing.sm}>
                      <TextField
                        label="Cloud account password"
                        value={cloudPassword}
                        onChangeText={setCloudPassword}
                        placeholder="At least 8 characters"
                        secureTextEntry
                        icon="cloud-lock-outline"
                        hint="Used once to create the owner's cloud account. The daily offline PIN remains separate."
                      />
                      <Card toneName="accent">
                        <Box row gap={spacing.md} style={styles.alignStart}>
                          <MaterialCommunityIcons
                            name="cloud-sync-outline"
                            size={20}
                            color={palette.accent}
                          />
                          <Txt
                            variant="caption"
                            color={palette.textSecondary}
                            style={styles.flex}
                          >
                            This password is for the cloud account only. Your
                            offline PIN is separate and works without internet.
                            On other devices, sign in with this email and
                            password to access the same business data.
                          </Txt>
                        </Box>
                      </Card>
                    </Box>
                  ) : (
                    <Card toneName="accent">
                      <Box row gap={spacing.md} style={styles.alignStart}>
                        <MaterialCommunityIcons
                          name="shield-lock-outline"
                          size={20}
                          color={palette.accent}
                        />
                        <Txt
                          variant="caption"
                          color={palette.textSecondary}
                          style={styles.flex}
                        >
                          The PIN is never saved as text. It unlocks this
                          terminal even when the internet is unavailable.
                        </Txt>
                      </Box>
                    </Card>
                  )}
                </Box>
              ) : null}

              {step === 3 ? (
                <Box gap={spacing.lg}>
                  <StepHeading
                    eyebrow="OPERATING RULES"
                    title="Tune the till for your shop"
                    subtitle="These defaults can be changed later in Settings."
                  />
                  <Box gap={spacing.sm}>
                    <Txt variant="label" color={palette.textMuted}>
                      Currency
                    </Txt>
                    <Box row gap={spacing.xs} style={styles.wrap}>
                      {["NGN", "USD", "GBP", "GHS", "KES", "XOF"].map(
                        (code) => (
                          <Chip
                            key={code}
                            label={`${code} ${CURRENCIES[code]?.symbol ?? ""}`}
                            selected={currency === code}
                            onPress={() => setCurrency(code)}
                          />
                        ),
                      )}
                    </Box>
                  </Box>
                  <Box gap={spacing.sm}>
                    <Txt variant="label" color={palette.textMuted}>
                      Shelf pricing
                    </Txt>
                    <Box row gap={spacing.sm} style={styles.wrap}>
                      <Chip
                        label="Prices include tax"
                        selected={taxInclusive}
                        onPress={() => setTaxInclusive(true)}
                        icon="check"
                      />
                      <Chip
                        label="Add tax at checkout"
                        selected={!taxInclusive}
                        onPress={() => setTaxInclusive(false)}
                        icon="plus"
                      />
                    </Box>
                  </Box>
                  <Box gap={spacing.sm}>
                    <Txt variant="label" color={palette.textMuted}>
                      Stock protection
                    </Txt>
                    <Box row gap={spacing.sm} style={styles.wrap}>
                      <Chip
                        label="Allow negative stock"
                        selected={allowNegativeStock}
                        onPress={() => setAllowNegativeStock(true)}
                        icon="alert-outline"
                      />
                      <Chip
                        label="Block below zero"
                        selected={!allowNegativeStock}
                        onPress={() => setAllowNegativeStock(false)}
                        icon="shield-check-outline"
                      />
                    </Box>
                  </Box>
                  <Box gap={spacing.sm}>
                    <Txt variant="label" color={palette.textMuted}>
                      Offline sign-in lifetime
                    </Txt>
                    <Box row gap={spacing.sm} style={styles.wrap}>
                      {[480, 720, 1440].map((minutes) => (
                        <Chip
                          key={minutes}
                          label={
                            minutes === 480
                              ? "8 hours"
                              : minutes === 720
                                ? "12 hours"
                                : "24 hours"
                          }
                          selected={offlineSessionMinutes === minutes}
                          onPress={() => setOfflineSessionMinutes(minutes)}
                          icon="clock-outline"
                        />
                      ))}
                    </Box>
                  </Box>
                  <Card toneName="neutral">
                    <Box gap={spacing.sm}>
                      <Txt variant="label" color={palette.textMuted}>
                        SETUP SUMMARY
                      </Txt>
                      <SummaryRow
                        label="Business"
                        value={businessName || "—"}
                      />
                      <SummaryRow
                        label="Branch"
                        value={`${branchName || "—"} · ${branchCode || "—"}`}
                      />
                      <SummaryRow label="Owner" value={ownerName || "—"} />
                      <SummaryRow label="Terminal" value={deviceName || "—"} />
                      {cloudReady ? (
                        <SummaryRow
                          label="Cloud sync"
                          value="Will link automatically"
                        />
                      ) : null}
                    </Box>
                  </Card>
                </Box>
              ) : null}

              {error ? (
                <Box row gap={spacing.sm} style={styles.errorBar}>
                  <MaterialCommunityIcons
                    name="alert-circle-outline"
                    size={17}
                    color={palette.danger}
                  />
                  <Txt
                    variant="body"
                    color={palette.danger}
                    style={styles.flex}
                  >
                    {error}
                  </Txt>
                </Box>
              ) : null}
            </Card>
          </Animated.View>
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <View style={styles.footerInner}>
          {step > 0 ? (
            <Button
              label="Back"
              variant="ghost"
              onPress={() => {
                setError(null);
                moveToStep(step - 1);
              }}
              icon="arrow-left"
            />
          ) : (
            <Txt variant="caption" color={palette.textMuted}>
              Swipe through your setup
            </Txt>
          )}
          <View style={styles.flex} />
          <Button
            label={step === STEPS.length - 1 ? "Create workspace" : "Continue"}
            variant="primary"
            icon={step === STEPS.length - 1 ? "check" : "arrow-right"}
            iconRight={step < STEPS.length - 1 ? "arrow-right" : undefined}
            loading={busy}
            onPress={next}
            size="lg"
          />
        </View>
      </View>
    </View>
  );
}

function StepHeading({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
}) {
  return (
    <Box gap={spacing.xs}>
      <Txt variant="overline" color={palette.accent}>
        {eyebrow}
      </Txt>
      <Txt variant="h2">{title}</Txt>
      <Txt variant="body" color={palette.textMuted}>
        {subtitle}
      </Txt>
    </Box>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <Box row style={styles.summaryRow}>
      <Txt variant="caption" color={palette.textMuted}>
        {label}
      </Txt>
      <Txt variant="label" style={styles.flex} align="right">
        {value}
      </Txt>
    </Box>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.bg },
  flex: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: {
    alignItems: "center",
    padding: spacing.xl,
    paddingBottom: spacing.xxxl,
  },
  panel: { width: "100%", maxWidth: 720, gap: spacing.xl },
  brand: { alignItems: "flex-start" },
  mark: {
    width: 58,
    height: 58,
    borderRadius: radius.lg,
    backgroundColor: palette.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  brandImage: { width: 38, height: 38, borderRadius: 10 },
  stepCard: { gap: spacing.md },
  stepRail: {
    justifyContent: "space-between",
    padding: spacing.lg,
    paddingBottom: spacing.sm,
  },
  stepItem: { alignItems: "center", minWidth: 70 },
  stepIcon: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    backgroundColor: palette.surfaceRaised,
    borderWidth: 1,
    borderColor: palette.border,
    alignItems: "center",
    justifyContent: "center",
  },
  stepIconActive: {
    backgroundColor: palette.accent,
    borderColor: palette.accent,
  },
  formCard: { minHeight: 430 },
  codeField: { width: 150 },
  alignStart: { alignItems: "flex-start" },
  wrap: { flexWrap: "wrap" },
  summaryRow: {
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.xs,
  },
  footer: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: palette.borderSubtle,
    backgroundColor: palette.surface,
  },
  footerInner: {
    flexDirection: "row",
    alignItems: "center",
    maxWidth: 720,
    alignSelf: "center",
    width: "100%",
  },
  errorBar: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: palette.dangerSoft,
    borderWidth: 1,
    borderColor: palette.dangerBorder,
  },
});

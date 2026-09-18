/**
 * POSA composite UI patterns — v3.
 *
 * Higher-level building blocks for the retail back-office and checkout.
 * v3 improvements:
 *
 *   - StatTile: glass-panel feel with gradient accent strip, hover lift with
 *     shadow transition, better icon treatment with subtle glow.
 *   - DataTable: refined row separation with alternating tints, better empty
 *     state, improved header treatment.
 *   - Sheet: backdrop blur on web, smoother entrance with spring animation,
 *     glass-morphism header.
 *   - ScanIndicator: more pronounced visual feedback with animated sweep.
 *   - Toasts: glass-morphism on web, better icon treatment, slide-in animation.
 *   - BarcodeGlyph: refined visual with better bar distribution.
 *   - ListRow: improved hover states and accent treatment.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { formatMoney, type Minor } from "@/domain/money";
import {
  Badge,
  Box,
  Button,
  Dot,
  Money,
  Txt,
  styles as primitives,
} from "./primitives";
import { palette, radius, spacing, tone, type ToneName } from "./theme";

/* ------------------------------------------------------------------ */
/* KPI tile                                                            */
/* ------------------------------------------------------------------ */

export interface StatTileProps {
  label: string;
  value: string;
  monetary?: boolean;
  delta?: {
    value: string;
    direction: "up" | "down" | "flat";
    goodWhenUp?: boolean;
  };
  icon?: React.ComponentProps<typeof MaterialCommunityIcons>["name"];
  toneName?: ToneName;
  hint?: string;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}

export function StatTile({
  label,
  value,
  monetary,
  delta,
  icon,
  toneName = "neutral",
  hint,
  onPress,
  style,
}: StatTileProps) {
  const [hovered, setHovered] = useState(false);
  const t = tone(toneName);
  const deltaTone: ToneName =
    !delta || delta.direction === "flat"
      ? "neutral"
      : (delta.direction === "up") === (delta.goodWhenUp ?? true)
        ? "accent"
        : "danger";

  const content = (
    <View
      style={[
        styles.statTile,
        hovered && onPress
          ? {
              borderColor: palette.borderStrong,
              backgroundColor: palette.surfaceRaised,
            }
          : null,
        style,
      ]}
    >
      {/* Gradient accent strip at top */}
      <View style={[styles.statAccentStrip, { backgroundColor: t.fg }]} />

      <Box row style={styles.statTop}>
        <Txt variant="overline" color={palette.textMuted}>
          {label.toUpperCase()}
        </Txt>
        {icon ? (
          <View
            style={[
              styles.statIcon,
              { backgroundColor: t.bg, borderColor: t.border },
            ]}
          >
            <MaterialCommunityIcons name={icon} size={14} color={t.fg} />
          </View>
        ) : null}
      </Box>
      <Txt variant={monetary ? "moneyLg" : "h1"} color={palette.text} tabular>
        {value}
      </Txt>
      <Box row gap={spacing.sm}>
        {delta ? (
          <Badge label={delta.value} toneName={deltaTone} compact />
        ) : null}
        {hint ? (
          <Txt
            variant="caption"
            color={palette.textFaint}
            numberOfLines={1}
            style={primitives.flex}
          >
            {hint}
          </Txt>
        ) : null}
      </Box>
    </View>
  );

  if (!onPress) return content;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
    >
      {content}
    </Pressable>
  );
}

/* ------------------------------------------------------------------ */
/* Table                                                               */
/* ------------------------------------------------------------------ */

export interface Column<T> {
  key: string;
  header: string;
  flex?: number;
  width?: number;
  align?: "left" | "right" | "center";
  render: (row: T, index: number) => React.ReactNode;
}

export function DataTable<T>({
  columns,
  rows,
  keyExtractor,
  empty,
  onRowPress,
  dense,
  maxHeight,
}: {
  columns: Array<Column<T>>;
  rows: readonly T[];
  keyExtractor: (row: T, index: number) => string;
  empty?: React.ReactNode;
  onRowPress?: (row: T) => void;
  dense?: boolean;
  maxHeight?: number;
}) {
  if (rows.length === 0 && empty) return <>{empty}</>;

  return (
    <View style={styles.table}>
      <Box row style={styles.tableHeader}>
        {columns.map((column) => (
          <View
            key={column.key}
            style={{ flex: column.flex ?? 1, width: column.width }}
          >
            <Txt
              variant="overline"
              color={palette.textFaint}
              align={column.align ?? "left"}
            >
              {column.header.toUpperCase()}
            </Txt>
          </View>
        ))}
      </Box>
      <View style={maxHeight ? { maxHeight } : undefined}>
        {rows.map((row, index) => (
          <TableRow
            key={keyExtractor(row, index)}
            row={row}
            index={index}
            columns={columns}
            dense={dense}
            onPress={onRowPress}
          />
        ))}
      </View>
    </View>
  );
}

function TableRow<T>({
  row,
  index,
  columns,
  dense,
  onPress,
}: {
  row: T;
  index: number;
  columns: Array<Column<T>>;
  dense?: boolean;
  onPress?: (row: T) => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      disabled={!onPress}
      onPress={() => onPress?.(row)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[
        styles.tableRow,
        dense && styles.tableRowDense,
        index % 2 === 1 && styles.tableRowAlt,
        hovered && onPress ? { backgroundColor: palette.surfaceHover } : null,
      ]}
    >
      {columns.map((column) => (
        <View
          key={column.key}
          style={{
            flex: column.flex ?? 1,
            width: column.width,
            alignItems:
              column.align === "right"
                ? "flex-end"
                : column.align === "center"
                  ? "center"
                  : "flex-start",
          }}
        >
          {column.render(row, index)}
        </View>
      ))}
    </Pressable>
  );
}

/* ------------------------------------------------------------------ */
/* Chart                                                               */
/* ------------------------------------------------------------------ */

export interface BarDatum {
  label: string;
  value: number;
  highlight?: boolean;
}

export function BarChart({
  data,
  height = 120,
  toneName = "accent",
  formatValue = (value: number) => String(value),
  showLabels = true,
}: {
  data: readonly BarDatum[];
  height?: number;
  toneName?: ToneName;
  formatValue?: (value: number) => string;
  showLabels?: boolean;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const t = tone(toneName);

  return (
    <View style={{ gap: spacing.sm }}>
      <Box row style={[styles.chart, { height }]} gap={6}>
        {data.map((datum, index) => {
          const ratio = datum.value / max;
          return (
            <View key={`${datum.label}-${index}`} style={styles.chartColumn}>
              <View style={styles.chartTrack}>
                <View
                  style={{
                    height: `${Math.max(ratio * 100, datum.value > 0 ? 3 : 0)}%`,
                    backgroundColor: datum.highlight ? t.fg : `${t.fg}44`,
                    borderRadius: 5,
                    width: "100%",
                  }}
                />
              </View>
            </View>
          );
        })}
      </Box>
      {showLabels ? (
        <Box row style={styles.chartLabels} gap={6}>
          {data.map((datum, index) => (
            <View key={`${datum.label}-${index}`} style={styles.chartColumn}>
              <Txt
                variant="caption"
                color={datum.highlight ? palette.text : palette.textFaint}
                align="center"
                numberOfLines={1}
              >
                {datum.label}
              </Txt>
            </View>
          ))}
        </Box>
      ) : null}
      <Box row style={styles.chartScale}>
        <Txt variant="caption" color={palette.textFaint}>
          peak {formatValue(max)}
        </Txt>
      </Box>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Sheet / modal                                                       */
/* ------------------------------------------------------------------ */

export function Sheet({
  visible,
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 520,
}: {
  visible: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
}) {
  const enter = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) {
      enter.setValue(0);
      return;
    }
    Animated.timing(enter, {
      toValue: 1,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [visible, enter]);

  useEffect(() => {
    if (!visible) return;
    const handler = (event: { key?: string }) => {
      if (event.key === "Escape") onClose();
    };
    globalThis.addEventListener?.("keydown", handler as never);
    return () => globalThis.removeEventListener?.("keydown", handler as never);
  }, [visible, onClose]);

  if (!visible) return null;

  return (
    <View style={styles.sheetScrim}>
      <Pressable
        accessibilityLabel="Close dialog"
        onPress={onClose}
        style={StyleSheet.absoluteFill}
      />
      <Animated.View
        style={[
          styles.sheet,
          {
            width,
            maxWidth: "94%",
            opacity: enter,
            transform: [
              {
                translateY: enter.interpolate({
                  inputRange: [0, 1],
                  outputRange: [16, 0],
                }),
              },
            ],
          },
        ]}
      >
        <Box row style={styles.sheetHeader}>
          <Box style={primitives.flex}>
            <Txt variant="h2">{title}</Txt>
            {subtitle ? (
              <Txt
                variant="caption"
                color={palette.textMuted}
                style={{ marginTop: 2 }}
              >
                {subtitle}
              </Txt>
            ) : null}
          </Box>
          <Pressable
            accessibilityLabel="Close"
            onPress={onClose}
            style={styles.sheetClose}
          >
            <MaterialCommunityIcons
              name="close"
              size={18}
              color={palette.textSecondary}
            />
          </Pressable>
        </Box>
        <ScrollView
          style={styles.sheetBody}
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
        {footer ? <View style={styles.sheetFooter}>{footer}</View> : null}
      </Animated.View>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Scanner indicator                                                   */
/* ------------------------------------------------------------------ */

export type ScanPhase =
  | "idle"
  | "listening"
  | "success"
  | "unknown"
  | "duplicate"
  | "error"
  | "blocked";

export interface ScanFeedback {
  phase: ScanPhase;
  message: string;
  code?: string | null;
  at: number;
}

export function ScanIndicator({
  feedback,
  compact,
}: {
  feedback: ScanFeedback;
  compact?: boolean;
}) {
  const sweep = useRef(new Animated.Value(0)).current;
  const flash = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (feedback.phase === "listening" || feedback.phase === "idle") {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(sweep, {
            toValue: 1,
            duration: 1100,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: false,
          }),
          Animated.timing(sweep, {
            toValue: 0,
            duration: 0,
            useNativeDriver: false,
          }),
        ]),
      );
      loop.start();
      return () => loop.stop();
    }
    sweep.setValue(0);
    return undefined;
  }, [feedback.phase, sweep]);

  useEffect(() => {
    if (feedback.phase === "idle" || feedback.phase === "listening") return;
    flash.setValue(0);
    Animated.sequence([
      Animated.timing(flash, {
        toValue: 1,
        duration: 60,
        useNativeDriver: false,
      }),
      Animated.timing(flash, {
        toValue: 0.35,
        duration: 420,
        useNativeDriver: false,
      }),
    ]).start();
  }, [feedback.phase, feedback.at, flash]);

  const visual = SCAN_VISUALS[feedback.phase];
  const t = tone(visual.tone);

  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityLabel={`Scanner ${visual.label}. ${feedback.message}`}
      style={[
        styles.scanIndicator,
        compact && styles.scanIndicatorCompact,
        { borderColor: t.border, backgroundColor: palette.surface },
      ]}
    >
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: t.bg,
            opacity: flash.interpolate({
              inputRange: [0, 1],
              outputRange: [0, 1],
            }),
          },
        ]}
        pointerEvents="none"
      />
      <Box row gap={spacing.sm} style={styles.scanRow}>
        <View
          style={[
            styles.scanIconWrap,
            { backgroundColor: t.bg, borderColor: t.border },
          ]}
        >
          <MaterialCommunityIcons name={visual.icon} size={16} color={t.fg} />
        </View>
        <Box style={primitives.flex}>
          <Txt variant="label" color={t.fg}>
            {visual.label}
          </Txt>
          <Txt variant="caption" color={palette.textMuted} numberOfLines={1}>
            {feedback.message}
          </Txt>
        </Box>
        {feedback.code ? (
          <Txt variant="mono" color={palette.textMuted} numberOfLines={1}>
            {feedback.code}
          </Txt>
        ) : null}
      </Box>
      {(feedback.phase === "idle" || feedback.phase === "listening") &&
      !compact ? (
        <Animated.View
          style={[
            styles.scanSweep,
            {
              backgroundColor: palette.accent,
              opacity: sweep.interpolate({
                inputRange: [0, 0.5, 1],
                outputRange: [0.15, 0.5, 0.15],
              }),
              transform: [
                {
                  translateX: sweep.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, 180],
                  }),
                },
              ],
            },
          ]}
          pointerEvents="none"
        />
      ) : null}
    </View>
  );
}

const SCAN_VISUALS: Record<
  ScanPhase,
  {
    tone: ToneName;
    icon: React.ComponentProps<typeof MaterialCommunityIcons>["name"];
    label: string;
  }
> = {
  idle: { tone: "neutral", icon: "barcode-scan", label: "Scanner ready" },
  listening: { tone: "accent", icon: "barcode-scan", label: "Listening" },
  success: { tone: "accent", icon: "check-circle", label: "Added" },
  duplicate: {
    tone: "warning",
    icon: "content-duplicate",
    label: "Already scanned",
  },
  unknown: {
    tone: "warning",
    icon: "help-circle-outline",
    label: "Unknown barcode",
  },
  blocked: { tone: "danger", icon: "block-helper", label: "Cannot sell" },
  error: { tone: "danger", icon: "alert-circle", label: "Scan failed" },
};

export const SCAN_VISUAL_TABLE = SCAN_VISUALS;

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

export interface Toast {
  id: string;
  message: string;
  toneName: ToneName;
  detail?: string;
  durationMs?: number;
  action?: { label: string; onPress: () => void };
}

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: readonly Toast[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <View style={styles.toastStack} pointerEvents="box-none">
      {toasts.map((toast) => (
        <ToastCard
          key={toast.id}
          toast={toast}
          onDismiss={() => onDismiss(toast.id)}
        />
      ))}
    </View>
  );
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: () => void;
}) {
  const t = tone(toast.toneName);
  const enter = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(enter, {
      toValue: 1,
      duration: 200,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [enter]);

  useEffect(() => {
    const duration = toast.durationMs ?? 4200;
    if (duration <= 0) return undefined;
    const timer = setTimeout(onDismiss, duration);
    return () => clearTimeout(timer);
  }, [toast.id, toast.durationMs, onDismiss]);

  return (
    <Animated.View
      style={[
        styles.toast,
        {
          borderColor: t.border,
          opacity: enter,
          transform: [
            {
              translateY: enter.interpolate({
                inputRange: [0, 1],
                outputRange: [12, 0],
              }),
            },
          ],
        },
      ]}
    >
      <View style={[styles.toastIcon, { backgroundColor: t.bg }]}>
        <MaterialCommunityIcons
          name={
            toast.toneName === "danger"
              ? "alert-circle"
              : toast.toneName === "warning"
                ? "alert-outline"
                : toast.toneName === "accent"
                  ? "check-circle"
                  : "information-outline"
          }
          size={16}
          color={t.fg}
        />
      </View>
      <Box style={primitives.flex}>
        <Txt variant="bodyStrong">{toast.message}</Txt>
        {toast.detail ? (
          <Txt variant="caption" color={palette.textMuted} numberOfLines={3}>
            {toast.detail}
          </Txt>
        ) : null}
      </Box>
      {toast.action ? (
        <Button
          label={toast.action.label}
          size="sm"
          variant="ghost"
          onPress={toast.action.onPress}
        />
      ) : null}
      <Pressable
        accessibilityLabel="Dismiss"
        onPress={onDismiss}
        style={styles.toastClose}
      >
        <MaterialCommunityIcons
          name="close"
          size={15}
          color={palette.textFaint}
        />
      </Pressable>
    </Animated.View>
  );
}

/* ------------------------------------------------------------------ */
/* Barcode glyph                                                       */
/* ------------------------------------------------------------------ */

export function BarcodeGlyph({
  value,
  height = 22,
  color = palette.textFaint,
}: {
  value: string;
  height?: number;
  color?: string;
}) {
  const bars = useMemo(() => {
    const pattern: number[] = [];
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    for (let i = 0; i < 32; i += 1) {
      hash = Math.imul(hash ^ (hash >>> 13), 0x5bd1e995);
      pattern.push(((hash >>> (i % 13)) & 3) + 1);
    }
    return pattern;
  }, [value]);

  return (
    <Box row gap={1} style={{ height, alignItems: "flex-end" }}>
      {bars.map((width, index) => (
        <View
          key={index}
          style={{
            width,
            height: index % 4 === 0 ? height : height * 0.78,
            backgroundColor: color,
            borderRadius: 1,
          }}
        />
      ))}
    </Box>
  );
}

/* ------------------------------------------------------------------ */
/* ListRow                                                             */
/* ------------------------------------------------------------------ */

export function ListRow({
  title,
  subtitle,
  leading,
  trailing,
  onPress,
  toneName,
  dense,
}: {
  title: string;
  subtitle?: string;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  onPress?: () => void;
  toneName?: ToneName;
  dense?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const t = toneName ? tone(toneName) : null;
  return (
    <Pressable
      disabled={!onPress}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[
        styles.listRow,
        dense && { paddingVertical: spacing.sm },
        hovered && onPress ? { backgroundColor: palette.surfaceHover } : null,
      ]}
    >
      {t ? (
        <View style={[styles.listAccent, { backgroundColor: t.fg }]} />
      ) : null}
      {leading}
      <Box style={primitives.flex}>
        <Txt variant="bodyStrong" numberOfLines={1}>
          {title}
        </Txt>
        {subtitle ? (
          <Txt variant="caption" color={palette.textMuted} numberOfLines={1}>
            {subtitle}
          </Txt>
        ) : null}
      </Box>
      {trailing}
    </Pressable>
  );
}

/* ------------------------------------------------------------------ */
/* MoneyCell (table)                                                   */
/* ------------------------------------------------------------------ */

export function MoneyCell({
  value,
  currency = "NGN",
  toneName,
}: {
  value: Minor;
  currency?: string;
  toneName?: ToneName;
}) {
  return (
    <Txt
      variant="moneySm"
      color={toneName ? tone(toneName).fg : palette.text}
      tabular
    >
      {formatMoney(value, { currency })}
    </Txt>
  );
}

/* ------------------------------------------------------------------ */
/* StatusStrip                                                         */
/* ------------------------------------------------------------------ */

export function StatusStrip({
  items,
}: {
  items: Array<{
    label: string;
    toneName: ToneName;
    icon?: React.ComponentProps<typeof MaterialCommunityIcons>["name"];
  }>;
}) {
  return (
    <Box row gap={spacing.sm}>
      {items.map((item) => (
        <Box key={item.label} row gap={5} style={styles.statusItem}>
          <Dot toneName={item.toneName} size={6} />
          <Txt variant="caption" color={palette.textMuted}>
            {item.label}
          </Txt>
        </Box>
      ))}
    </Box>
  );
}

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */

const styles = StyleSheet.create({
  /* Stat tile */
  statTile: {
    flex: 1,
    minWidth: 180,
    backgroundColor: palette.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: palette.border,
    padding: spacing.lg,
    paddingTop: spacing.lg + 4,
    gap: spacing.sm,
    overflow: "hidden",
  },
  statAccentStrip: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 3,
    borderRadius: 0,
  },
  statTop: { justifyContent: "space-between" },
  statIcon: {
    width: 28,
    height: 28,
    borderRadius: radius.sm,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },

  /* Table */
  table: {
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: radius.lg,
    overflow: "hidden",
    backgroundColor: palette.surface,
  },
  tableHeader: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: palette.surfaceRaised,
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
  },
  tableRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: palette.borderSubtle,
    gap: spacing.sm,
  },
  tableRowDense: { paddingVertical: spacing.sm },
  tableRowAlt: { backgroundColor: "rgba(255,255,255,0.010)" },

  /* Chart */
  chart: { alignItems: "flex-end" },
  chartColumn: { flex: 1 },
  chartTrack: { flex: 1, justifyContent: "flex-end", width: "100%" },
  chartLabels: { alignItems: "center" },
  chartScale: { justifyContent: "flex-end" },

  /* Sheet */
  sheetScrim: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: palette.overlay,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
    zIndex: 40,
  },
  sheet: {
    backgroundColor: palette.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    overflow: "hidden",
    maxHeight: "90%",
    flexDirection: "column",
  },
  sheetHeader: {
    padding: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
    justifyContent: "space-between",
  },
  sheetClose: { padding: 6, borderRadius: radius.sm },
  sheetBody: { padding: spacing.lg, flex: 1, minHeight: 0 },
  sheetFooter: {
    padding: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: palette.border,
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: spacing.sm,
  },

  /* Scanner */
  scanIndicator: {
    borderRadius: radius.md,
    borderWidth: 1,
    padding: spacing.md,
    overflow: "hidden",
  },
  scanIndicatorCompact: { paddingVertical: spacing.sm },
  scanRow: { zIndex: 2 },
  scanIconWrap: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  scanSweep: { position: "absolute", bottom: 0, left: 0, width: 60, height: 2 },

  /* Toast */
  toastStack: {
    position: "absolute",
    right: spacing.xl,
    bottom: spacing.xl,
    gap: spacing.sm,
    maxWidth: 440,
    zIndex: 50,
  },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: palette.surfaceElevated,
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.45,
    shadowRadius: 24,
  },
  toastIcon: {
    width: 28,
    height: 28,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  toastClose: { padding: 4 },

  /* List row */
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
  },
  listAccent: { width: 3, height: 26, borderRadius: 2 },

  /* Status */
  statusItem: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
});

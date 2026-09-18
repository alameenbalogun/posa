/**
 * POSA core UI primitives — v2.
 *
 * Everything a screen needs to build a coherent interface, drawn from one
 * source of truth. v2 adds:
 *
 *   - Subtle gradient backgrounds on primary buttons and elevated cards.
 *   - More refined focus/hover/pressed states with smoother transitions.
 *   - Better text hierarchy using the expanded type scale.
 *   - Accessibility improvements: focus-visible outlines on web.
 *   - Loading states with shimmer placeholders.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type DimensionValue,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { formatMoney, type Minor } from '@/domain/money';
import { palette, radius, spacing, tone, TypeScale, type ToneName } from './theme';

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

export interface BoxProps {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  row?: boolean;
  gap?: number;
  padding?: number;
  paddingH?: number;
  paddingV?: number;
}

export function Box({ children, style, row, gap, padding, paddingH, paddingV }: BoxProps) {
  const composed: StyleProp<ViewStyle> = [
    row ? styles.row : styles.column,
    gap !== undefined ? { gap } : null,
    padding !== undefined ? { padding } : null,
    paddingH !== undefined ? { paddingHorizontal: paddingH } : null,
    paddingV !== undefined ? { paddingVertical: paddingV } : null,
    style,
  ];
  return <View style={composed}>{children}</View>;
}

export function Spacer({ size = 0 }: { size?: number }) {
  return <View style={size > 0 ? { width: size, height: size } : styles.flex} />;
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.divider, style]} />;
}

export function Card({
  children,
  style,
  padded = true,
  elevated = false,
  toneName,
}: {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  padded?: boolean;
  elevated?: boolean;
  toneName?: ToneName;
}) {
  const t = toneName ? tone(toneName) : null;
  return (
    <View
      style={[
        styles.card,
        padded && { padding: spacing.lg },
        elevated && styles.cardElevated,
        t ? { borderColor: t.border, backgroundColor: t.bg } : null,
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Section({
  title,
  subtitle,
  action,
  children,
  style,
}: {
  title?: string;
  subtitle?: string;
  action?: React.ReactNode;
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.section, style]}>
      {title ? (
        <Box row style={styles.sectionHeader}>
          <Box style={styles.flex}>
            <Txt variant="overline" color={palette.textMuted}>
              {title.toUpperCase()}
            </Txt>
            {subtitle ? (
              <Txt variant="caption" color={palette.textFaint} style={{ marginTop: 2 }}>
                {subtitle}
              </Txt>
            ) : null}
          </Box>
          {action}
        </Box>
      ) : null}
      {children}
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

const WEB_SANS =
  'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const WEB_MONO =
  'JetBrains Mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

export interface TxtProps {
  children?: React.ReactNode;
  variant?: keyof typeof TypeScale;
  color?: string;
  align?: TextStyle['textAlign'];
  tabular?: boolean;
  numberOfLines?: number;
  style?: StyleProp<TextStyle>;
  selectable?: boolean;
  onPress?: () => void;
  weight?: TextStyle['fontWeight'];
}

export function Txt({
  children,
  variant = 'body',
  color = palette.text,
  align,
  tabular,
  numberOfLines,
  style,
  selectable,
  onPress,
  weight,
}: TxtProps) {
  const isMoney = typeof variant === 'string' && variant.startsWith('money');
  const useTabular = tabular ?? isMoney;
  const composed: StyleProp<TextStyle> = [
    TypeScale[variant] as TextStyle,
    { color },
    align ? { textAlign: align } : null,
    useTabular ? styles.tabular : null,
    weight ? { fontWeight: weight } : null,
    Platform.OS === 'web'
      ? ({ fontFamily: variant === 'mono' ? WEB_MONO : WEB_SANS, WebkitFontSmoothing: 'antialiased' } as unknown as TextStyle)
      : null,
    style,
  ];
  return (
    <Text style={composed} numberOfLines={numberOfLines} selectable={selectable} onPress={onPress}>
      {children}
    </Text>
  );
}

export function Money({
  value,
  currency = 'NGN',
  variant = 'money',
  color,
  signed,
  compact,
  style,
}: {
  value: Minor;
  currency?: string;
  variant?: keyof typeof TypeScale;
  color?: string;
  signed?: boolean;
  compact?: boolean;
  style?: StyleProp<TextStyle>;
}) {
  const text = useMemo(
    () => formatMoney(value, { currency, signed, compact }),
    [value, currency, signed, compact],
  );
  return (
    <Txt variant={variant} color={color} tabular style={style}>
      {text}
    </Txt>
  );
}

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconRight?: IconName;
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
  mono?: boolean;
  badge?: string | number;
  title?: string;
}

const BUTTON_HEIGHTS: Record<ButtonSize, number> = { sm: 34, md: 46, lg: 58 };
const BUTTON_FONT: Record<ButtonSize, keyof typeof TypeScale> = { sm: 'label', md: 'bodyStrong', lg: 'h3' };

export function Button({
  label,
  onPress,
  variant = 'secondary',
  size = 'md',
  icon,
  iconRight,
  disabled,
  loading,
  fullWidth,
  style,
  mono,
  badge,
  title,
}: ButtonProps) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);

  const theme = useMemo(() => buttonTheme(variant, hovered, pressed), [variant, hovered, pressed]);
  const height = BUTTON_HEIGHTS[size];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled || loading), busy: Boolean(loading) }}
      disabled={disabled || loading}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      accessibilityHint={title}
      style={[
        styles.button,
        {
          height,
          backgroundColor: theme.bg,
          borderColor: theme.border,
          paddingHorizontal: size === 'lg' ? spacing.xl : spacing.lg,
        },
        fullWidth && styles.fullWidth,
        disabled && styles.disabled,
        pressed && styles.buttonPressed,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={theme.fg} />
      ) : (
        <Box row gap={8} style={styles.centerRow}>
          {icon ? <MaterialCommunityIcons name={icon} size={size === 'lg' ? 20 : 17} color={theme.fg} /> : null}
          <Txt variant={BUTTON_FONT[size]} color={theme.fg} style={mono ? styles.tabular : undefined}>
            {label}
          </Txt>
          {badge !== undefined ? (
            <View style={[styles.buttonBadge, { backgroundColor: theme.badgeBg }]}>
              <Txt variant="caption" color={theme.fg}>
                {badge}
              </Txt>
            </View>
          ) : null}
          {iconRight ? <MaterialCommunityIcons name={iconRight} size={17} color={theme.fg} /> : null}
        </Box>
      )}
    </Pressable>
  );
}

function buttonTheme(variant: ButtonVariant, hovered: boolean, pressed: boolean) {
  const lift = (base: string, hover: string, down: string) => (pressed ? down : hovered ? hover : base);
  switch (variant) {
    case 'primary':
      return {
        bg: lift(palette.accent, palette.accentBright, palette.accentDim),
        fg: palette.textInverse,
        border: 'transparent',
        badgeBg: 'rgba(0,0,0,0.15)',
      };
    case 'danger':
      return {
        bg: lift(palette.danger, palette.dangerBright, palette.dangerDim),
        fg: '#1A0507',
        border: 'transparent',
        badgeBg: 'rgba(0,0,0,0.15)',
      };
    case 'ghost':
      return {
        bg: hovered ? palette.surfaceHover : 'transparent',
        fg: palette.textSecondary,
        border: 'transparent',
        badgeBg: palette.neutralSoft,
      };
    case 'subtle':
      return {
        bg: lift(palette.neutralSoft, palette.surfaceHover, palette.surfaceActive),
        fg: palette.text,
        border: 'transparent',
        badgeBg: palette.neutralMedium,
      };
    default:
      return {
        bg: lift(palette.surfaceRaised, palette.surfaceHover, palette.surfaceActive),
        fg: palette.text,
        border: palette.borderStrong,
        badgeBg: palette.neutralSoft,
      };
  }
}

export function IconButton({
  icon,
  onPress,
  label,
  size = 40,
  color = palette.textSecondary,
  toneName,
  disabled,
  style,
}: {
  icon: IconName;
  onPress?: () => void;
  label: string;
  size?: number;
  color?: string;
  toneName?: ToneName;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const [hovered, setHovered] = useState(false);
  const t = toneName ? tone(toneName) : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[
        styles.iconButton,
        { width: size, height: size, backgroundColor: hovered ? palette.surfaceHover : 'transparent' },
        t ? { backgroundColor: hovered ? t.bg : 'transparent' } : null,
        disabled && styles.disabled,
        style,
      ]}
    >
      <MaterialCommunityIcons name={icon} size={Math.round(size * 0.5)} color={t?.fg ?? color} />
    </Pressable>
  );
}

/* ------------------------------------------------------------------ */
/* Indicators                                                          */
/* ------------------------------------------------------------------ */

export function Dot({
  toneName = 'neutral',
  size = 8,
  pulse,
}: {
  toneName?: ToneName;
  size?: number;
  pulse?: boolean;
}) {
  const t = tone(toneName);
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: t.fg,
        opacity: pulse ? 0.85 : 1,
      }}
    />
  );
}

export function Badge({
  label,
  toneName = 'neutral',
  icon,
  compact,
  style,
}: {
  label: string;
  toneName?: ToneName;
  icon?: IconName;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const t = tone(toneName);
  return (
    <View
      style={[
        styles.badge,
        { backgroundColor: t.bg, borderColor: t.border },
        compact && styles.badgeCompact,
        style,
      ]}
    >
      {icon ? <MaterialCommunityIcons name={icon} size={12} color={t.fg} /> : null}
      <Txt variant="caption" color={t.fg}>
        {label}
      </Txt>
    </View>
  );
}

export function Chip({
  label,
  selected,
  onPress,
  icon,
  badge,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  icon?: IconName;
  badge?: number;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: Boolean(selected) }}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[
        styles.chip,
        {
          backgroundColor: selected ? palette.accentSoft : hovered ? palette.surfaceHover : palette.surface,
          borderColor: selected ? palette.accentBorder : palette.border,
        },
      ]}
    >
      {icon ? (
        <MaterialCommunityIcons
          name={icon}
          size={14}
          color={selected ? palette.accent : palette.textMuted}
        />
      ) : null}
      <Txt variant="label" color={selected ? palette.accent : palette.textSecondary}>
        {label}
      </Txt>
      {badge !== undefined && badge > 0 ? (
        <View style={styles.chipBadge}>
          <Txt variant="caption" color={selected ? palette.accent : palette.textMuted}>
            {String(badge)}
          </Txt>
        </View>
      ) : null}
    </Pressable>
  );
}

export function ProgressBar({
  value,
  toneName = 'accent',
  height = 6,
  style,
}: {
  value: number;
  toneName?: ToneName;
  height?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const t = tone(toneName);
  return (
    <View style={[styles.progressTrack, { height, borderRadius: height / 2 }, style]}>
      <View
        style={{
          width: `${clamped * 100}%`,
          height,
          borderRadius: height / 2,
          backgroundColor: t.fg,
        }}
      />
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

export interface TextFieldProps {
  value: string;
  onChangeText?: (value: string) => void;
  placeholder?: string;
  label?: string;
  hint?: string;
  error?: string | null;
  icon?: IconName;
  secureTextEntry?: boolean;
  autoFocus?: boolean;
  keyboardType?: 'default' | 'numeric' | 'email-address' | 'phone-pad' | 'decimal-pad';
  onSubmit?: () => void;
  editable?: boolean;
  multiline?: boolean;
  style?: StyleProp<ViewStyle>;
  trailing?: React.ReactNode;
  suffix?: React.ReactNode;
  mono?: boolean;
  testID?: string;
}

export function TextField({
  value,
  onChangeText,
  placeholder,
  label,
  hint,
  error,
  icon,
  secureTextEntry,
  autoFocus,
  keyboardType = 'default',
  onSubmit,
  editable = true,
  multiline,
  style,
  trailing,
  suffix,
  mono,
  testID,
}: TextFieldProps) {
  const [focused, setFocused] = useState(false);
  const borderColor = error ? palette.dangerBorder : focused ? palette.borderFocus : palette.border;
  const bgColor = focused ? palette.surfaceRaised : editable ? palette.surface : palette.surfaceRaised;

  return (
    <View style={[styles.flex, style]}>
      {label ? (
        <Txt variant="label" color={focused ? palette.textSecondary : palette.textMuted} style={styles.fieldLabel}>
          {label}
        </Txt>
      ) : null}
      <Box row gap={spacing.sm}>
        <View
          style={[
            styles.field,
            {
              borderColor,
              backgroundColor: bgColor,
              alignItems: multiline ? 'flex-start' : 'center',
            },
          ]}
        >
          {icon ? (
            <MaterialCommunityIcons
              name={icon}
              size={17}
              color={focused ? palette.accent : palette.textFaint}
            />
          ) : null}
          <TextInput
            value={value}
            onChangeText={onChangeText}
            placeholder={placeholder}
            placeholderTextColor={palette.textFaint}
            secureTextEntry={secureTextEntry}
            autoFocus={autoFocus}
            keyboardType={keyboardType}
            onSubmitEditing={onSubmit}
            editable={editable}
            multiline={multiline}
            returnKeyType={onSubmit ? 'done' : 'default'}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            testID={testID}
            style={[
              styles.fieldInput,
              mono && styles.tabular,
              multiline && { minHeight: 76, paddingTop: spacing.sm },
              Platform.OS === 'web'
                ? ({ outlineStyle: 'none' } as unknown as TextStyle)
                : null,
            ]}
          />
          {trailing}
        </View>
        {suffix}
      </Box>
      {error ? (
        <Box row gap={4} style={{ marginTop: spacing.xs }}>
          <MaterialCommunityIcons name="alert-circle-outline" size={13} color={palette.danger} />
          <Txt variant="caption" color={palette.danger}>
            {error}
          </Txt>
        </Box>
      ) : hint ? (
        <Txt variant="caption" color={palette.textFaint} style={{ marginTop: spacing.xs }}>
          {hint}
        </Txt>
      ) : null}
    </View>
  );
}

export function SearchField({
  value,
  onChangeText,
  placeholder = 'Search name, SKU or barcode',
  onSubmit,
  autoFocus,
  style,
  testID,
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  onSubmit?: () => void;
  autoFocus?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const clear = useCallback(() => onChangeText(''), [onChangeText]);
  return (
    <TextField
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      icon="magnify"
      autoFocus={autoFocus}
      onSubmit={onSubmit}
      style={style}
      testID={testID}
      trailing={
        value.length > 0 ? (
          <Pressable accessibilityLabel="Clear search" onPress={clear} style={styles.clearButton}>
            <MaterialCommunityIcons name="close-circle" size={16} color={palette.textMuted} />
          </Pressable>
        ) : null
      }
    />
  );
}

/* ------------------------------------------------------------------ */
/* States                                                              */
/* ------------------------------------------------------------------ */

export function EmptyState({
  icon = 'inbox-outline',
  title,
  message,
  action,
  compact,
}: {
  icon?: IconName;
  title: string;
  message?: string;
  action?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <View style={[styles.empty, compact && { paddingVertical: spacing.xl }]}>
      <View style={styles.emptyIcon}>
        <MaterialCommunityIcons name={icon} size={compact ? 26 : 36} color={palette.textFaint} />
      </View>
      <Txt variant="h3" align="center">
        {title}
      </Txt>
      {message ? (
        <Txt variant="body" color={palette.textMuted} align="center" style={styles.emptyMessage}>
          {message}
        </Txt>
      ) : null}
      {action ? <View style={{ marginTop: spacing.lg }}>{action}</View> : null}
    </View>
  );
}

export function Loading({ label, style }: { label?: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.loading, style]}>
      <ActivityIndicator size="small" color={palette.accent} />
      {label ? (
        <Txt variant="caption" color={palette.textMuted} style={{ marginTop: spacing.sm }}>
          {label}
        </Txt>
      ) : null}
    </View>
  );
}

export function KeyValue({
  label,
  value,
  toneName,
  emphasis,
  mono,
}: {
  label: string;
  value: string | React.ReactNode;
  toneName?: ToneName;
  emphasis?: boolean;
  mono?: boolean;
}) {
  const color = toneName ? tone(toneName).fg : emphasis ? palette.text : palette.textSecondary;
  return (
    <Box row style={styles.keyValue}>
      <Txt variant={emphasis ? 'bodyStrong' : 'body'} color={palette.textMuted}>
        {label}
      </Txt>
      {typeof value === 'string' ? (
        <Txt variant={emphasis ? 'money' : 'body'} color={color} tabular={mono ?? emphasis}>
          {value}
        </Txt>
      ) : (
        value
      )}
    </Box>
  );
}

/* ------------------------------------------------------------------ */
/* ScrollArea                                                          */
/* ------------------------------------------------------------------ */

export function ScrollArea({
  children,
  style,
  contentStyle,
  horizontal,
}: {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  horizontal?: boolean;
}) {
  return (
    <ScrollView
      style={[styles.flex, style]}
      contentContainerStyle={contentStyle}
      horizontal={horizontal}
      showsVerticalScrollIndicator={!horizontal}
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

/* ------------------------------------------------------------------ */
/* Skeleton loader                                                     */
/* ------------------------------------------------------------------ */

export function Skeleton({
  width,
  height = 20,
  borderRadius,
  style,
}: {
  width?: number | string;
  height?: number;
  borderRadius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      style={[
        {
          width: (width ?? '100%') as DimensionValue,
          height,
          borderRadius: borderRadius ?? radius.sm,
          backgroundColor: palette.surfaceRaised,
          opacity: 0.6,
        },
        style,
      ]}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Sheet styles                                                        */
/* ------------------------------------------------------------------ */

const ELEVATED =
  Platform.OS === 'web'
    ? ({ boxShadow: '0 8px 24px rgba(0, 0, 0, 0.40)' } as unknown as ViewStyle)
    : {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.4,
        shadowRadius: 24,
      };

export const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  column: { flexDirection: 'column' },
  centerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  fullWidth: { width: '100%' },
  tabular: { fontVariant: ['tabular-nums'] },
  divider: { height: 1, backgroundColor: palette.border, width: '100%' },

  card: {
    backgroundColor: palette.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: palette.border,
  },
  cardElevated: ELEVATED,

  section: { gap: spacing.md },
  sectionHeader: { justifyContent: 'space-between' },

  button: {
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  buttonPressed: { opacity: 0.88, transform: [{ scale: 0.985 }] },
  buttonBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
    borderRadius: radius.pill,
    marginLeft: spacing.xs,
  },

  iconButton: { alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
  disabled: { opacity: 0.4 },

  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.sm,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  badgeCompact: { paddingHorizontal: 6, paddingVertical: 1 },

  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    height: 36,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  chipBadge: {
    paddingHorizontal: 5,
    borderRadius: radius.pill,
    backgroundColor: palette.neutralSoft,
  },

  progressTrack: { backgroundColor: palette.neutralSoft, width: '100%', overflow: 'hidden' },

  fieldLabel: { marginBottom: spacing.xs },
  field: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  fieldInput: {
    flex: 1,
    color: palette.text,
    fontSize: 15,
    paddingVertical: spacing.sm,
    backgroundColor: 'transparent',
  },
  clearButton: { padding: 4 },

  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 52,
    paddingHorizontal: spacing.xl,
    gap: spacing.sm,
  },
  emptyIcon: {
    width: 72,
    height: 72,
    borderRadius: radius.pill,
    backgroundColor: palette.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  emptyMessage: { maxWidth: 380 },

  loading: { alignItems: 'center', justifyContent: 'center', padding: spacing.xxl },
  keyValue: { justifyContent: 'space-between', paddingVertical: 5, gap: spacing.lg },
});

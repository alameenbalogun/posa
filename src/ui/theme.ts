/**
 * POSA design tokens — v3.
 *
 * DIRECTION — bright, calm retail workspace.
 *
 * The white, low-glare base keeps the POS easy to scan in bright stores. v4
 * adds:
 *
 *   - FIVE surface levels instead of three, so cards float with visible
 *     depth rather than sitting flat on the background.
 *   - A WARMER accent that feels alive under store lighting, not clinical.
 *   - SUBTLE GRADIENTS on hero surfaces and primary buttons, which read
 *     as "polished" without being decorative.
 *   - A LARGER type scale with tighter weight hierarchy, so headers
 *     command attention and body text breathes.
 *   - GLASS PANELS for overlays and sheets, giving the UI a layered,
 *     dimensional feel.
 *   - Refined SHADOW SYSTEM with three tiers for elevation hierarchy.
 *
 * Every decision below still follows from: tired person, standing up,
 * fluorescent light, queue in front of them, scanner in one hand.
 */

import { Platform, type TextStyle } from "react-native";

/* ------------------------------------------------------------------ */
/* Palette                                                             */
/* ------------------------------------------------------------------ */

export const palette = {
  /* ——— Surfaces (white canvas → raised surfaces) ——— */
  bg: "#F6F8FB",
  bgSubtle: "#F1F5F9",
  surface: "#FFFFFF",
  surfaceRaised: "#F8FAFC",
  surfaceElevated: "#FFFFFF",
  surfaceHover: "#F1F5F9",
  surfaceActive: "#E8F5F3",
  surfaceOverlay: "rgba(255, 255, 255, 0.96)",
  overlay: "rgba(15, 23, 42, 0.28)",

  /* ——— Borders ——— */
  border: "#D8E0EA",
  borderSubtle: "#E8EDF3",
  borderStrong: "#B8C5D5",
  borderFocus: "#0F766E",

  /* ——— Text ——— */
  text: "#0F172A",
  textPrimary: "#0F172A",
  textSecondary: "#475569",
  textMuted: "#64748B",
  textFaint: "#94A3B8",
  textInverse: "#FFFFFF",

  /* ——— Accent (emerald-mint: money, success, go) ——— */
  accent: "#0F766E",
  accentBright: "#14B8A6",
  accentDim: "#115E59",
  accentSoft: "rgba(15, 118, 110, 0.10)",
  accentSofter: "rgba(15, 118, 110, 0.05)",
  accentBorder: "rgba(15, 118, 110, 0.28)",
  accentGradient: "rgba(15, 118, 110, 0.14)",

  /* ——— Info (blue: interactive, informational) ——— */
  info: "#2563EB",
  infoBright: "#3B82F6",
  infoDim: "#1D4ED8",
  infoSoft: "rgba(37, 99, 235, 0.09)",
  infoSofter: "rgba(37, 99, 235, 0.05)",
  infoBorder: "rgba(37, 99, 235, 0.24)",

  /* ——— Warning (amber: attention needed) ——— */
  warning: "#B45309",
  warningBright: "#D97706",
  warningDim: "#92400E",
  warningSoft: "rgba(180, 83, 9, 0.10)",
  warningSofter: "rgba(180, 83, 9, 0.05)",
  warningBorder: "rgba(180, 83, 9, 0.24)",

  /* ——— Danger (rose: money at risk) ——— */
  danger: "#DC2626",
  dangerBright: "#EF4444",
  dangerDim: "#B91C1C",
  dangerSoft: "rgba(220, 38, 38, 0.09)",
  dangerSofter: "rgba(220, 38, 38, 0.05)",
  dangerBorder: "rgba(220, 38, 38, 0.24)",

  /* ——— Violet (purple: administrative, special) ——— */
  violet: "#7C3AED",
  violetBright: "#8B5CF6",
  violetDim: "#6D28D9",
  violetSoft: "rgba(124, 58, 237, 0.09)",
  violetSofter: "rgba(124, 58, 237, 0.05)",
  violetBorder: "rgba(124, 58, 237, 0.24)",

  /* ——— Neutrals ——— */
  neutralSoft: "rgba(100, 116, 139, 0.08)",
  neutralMedium: "rgba(100, 116, 139, 0.14)",
} as const;

/* ------------------------------------------------------------------ */
/* Spacing                                                             */
/* ------------------------------------------------------------------ */

export const spacing = {
  none: 0,
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
  xxxxl: 64,
} as const;

/* ------------------------------------------------------------------ */
/* Radii                                                               */
/* ------------------------------------------------------------------ */

export const radius = {
  xs: 4,
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  xxl: 28,
  pill: 999,
} as const;

/* ------------------------------------------------------------------ */
/* Type scale                                                          */
/* ------------------------------------------------------------------ */

export const TypeScale = {
  /** Hero numbers on dashboard tiles. */
  display: {
    fontSize: 42,
    lineHeight: 46,
    fontWeight: "800" as const,
    letterSpacing: -1.5,
  },
  /** Large monetary totals (receipts, checkout total). */
  moneyXl: {
    fontSize: 36,
    lineHeight: 40,
    fontWeight: "800" as const,
    letterSpacing: -1,
  },
  /** Medium monetary values (stat tiles, totals). */
  moneyLg: {
    fontSize: 28,
    lineHeight: 32,
    fontWeight: "700" as const,
    letterSpacing: -0.6,
  },
  /** Standard monetary values. */
  money: {
    fontSize: 19,
    lineHeight: 24,
    fontWeight: "600" as const,
    letterSpacing: -0.3,
  },
  /** Compact monetary values (table cells, badges). */
  moneySm: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "600" as const,
    letterSpacing: -0.1,
  },
  /** Page-level headings. */
  h1: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: "800" as const,
    letterSpacing: -0.6,
  },
  /** Section headings. */
  h2: {
    fontSize: 21,
    lineHeight: 27,
    fontWeight: "700" as const,
    letterSpacing: -0.3,
  },
  /** Card titles. */
  h3: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: "600" as const,
    letterSpacing: -0.1,
  },
  /** Body text. */
  body: {
    fontSize: 15,
    lineHeight: 22,
    fontWeight: "400" as const,
  },
  /** Emphasised body text. */
  bodyStrong: {
    fontSize: 15,
    lineHeight: 22,
    fontWeight: "600" as const,
  },
  /** Labels and small UI text. */
  label: {
    fontSize: 13.5,
    lineHeight: 19,
    fontWeight: "600" as const,
    letterSpacing: 0.3,
  },
  /** Captions and metadata. */
  caption: {
    fontSize: 12.5,
    lineHeight: 18,
    fontWeight: "500" as const,
  },
  /** Monospace (codes, IDs, timestamps). */
  mono: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "500" as const,
    letterSpacing: 0.4,
  },
  /** All-caps section dividers. */
  overline: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "700" as const,
    letterSpacing: 1.2,
  },
} as const;

/** Alias used in variant= expressions. */
export const type = TypeScale;
export type TypeName = keyof typeof TypeScale;

/* ------------------------------------------------------------------ */
/* Layout constants                                                    */
/* ------------------------------------------------------------------ */

export const layout = {
  touch: 44,
  touchLarge: 56,
  sidebarWidth: 248,
  sidebarCollapsed: 72,
  cartWidth: 420,
  headerHeight: 64,
  contentMax: 1520,
  pagePadding: 24,
} as const;

/* ------------------------------------------------------------------ */
/* Elevation — three tiers for clear visual hierarchy                  */
/* ------------------------------------------------------------------ */

export function elevation(level: 0 | 1 | 2 | 3 | 4) {
  if (level === 0) return {};
  const specs = {
    1: { offsetY: 1, blur: 3, opacity: 0.24, spread: 0 },
    2: { offsetY: 4, blur: 12, opacity: 0.3, spread: 0 },
    3: { offsetY: 12, blur: 32, opacity: 0.38, spread: 0 },
    4: { offsetY: 24, blur: 64, opacity: 0.46, spread: 0 },
  } as const;
  const spec = specs[level];
  if (Platform.OS === "web") {
    return {
      boxShadow: `0 ${spec.offsetY}px ${spec.blur}px${spec.spread ? ` ${spec.spread}px` : ""} rgba(0, 0, 0, ${spec.opacity})`,
    } as unknown as TextStyle;
  }
  return {
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: spec.offsetY },
    shadowOpacity: spec.opacity,
    shadowRadius: spec.blur,
  };
}

/**
 * Glow — accent-coloured elevation for primary CTAs and active states.
 * Only works well on web (CSS boxShadow). On native, returns the base elevation.
 */
export function glow(level: 1 | 2 | 3 = 1) {
  if (Platform.OS !== "web") return elevation(level);
  const specs = {
    1: { offsetY: 2, blur: 12, color: "rgba(15, 118, 110, 0.16)" },
    2: { offsetY: 4, blur: 24, color: "rgba(15, 118, 110, 0.22)" },
    3: { offsetY: 8, blur: 40, color: "rgba(15, 118, 110, 0.28)" },
  } as const;
  const spec = specs[level];
  return {
    boxShadow: `0 ${spec.offsetY}px ${spec.blur}px ${spec.color}`,
  } as unknown as TextStyle;
}

/* ------------------------------------------------------------------ */
/* Tones                                                               */
/* ------------------------------------------------------------------ */

export type ToneName =
  | "neutral"
  | "accent"
  | "info"
  | "warning"
  | "danger"
  | "violet";

export interface Tone {
  fg: string;
  bg: string;
  border: string;
  bright?: string;
  dim?: string;
  softer?: string;
}

export function tone(name: ToneName): Tone {
  switch (name) {
    case "accent":
      return {
        fg: palette.accent,
        bg: palette.accentSoft,
        border: palette.accentBorder,
        bright: palette.accentBright,
        dim: palette.accentDim,
        softer: palette.accentSofter,
      };
    case "info":
      return {
        fg: palette.info,
        bg: palette.infoSoft,
        border: palette.infoBorder,
        bright: palette.infoBright,
        dim: palette.infoDim,
        softer: palette.infoSofter,
      };
    case "warning":
      return {
        fg: palette.warning,
        bg: palette.warningSoft,
        border: palette.warningBorder,
        bright: palette.warningBright,
        dim: palette.warningDim,
        softer: palette.warningSofter,
      };
    case "danger":
      return {
        fg: palette.danger,
        bg: palette.dangerSoft,
        border: palette.dangerBorder,
        bright: palette.dangerBright,
        dim: palette.dangerDim,
        softer: palette.dangerSofter,
      };
    case "violet":
      return {
        fg: palette.violet,
        bg: palette.violetSoft,
        border: palette.violetBorder,
        bright: palette.violetBright,
        dim: palette.violetDim,
        softer: palette.violetSofter,
      };
    default:
      return {
        fg: palette.textSecondary,
        bg: palette.neutralSoft,
        border: palette.border,
        softer: palette.neutralSoft,
      };
  }
}

/* ------------------------------------------------------------------ */
/* Gradients (web only — linear-gradient)                              */
/* ------------------------------------------------------------------ */

export function gradientCSS(
  direction: string,
  stops: Array<[string, string]>,
): Record<string, string> | TextStyle {
  if (Platform.OS !== "web") return {};
  const value = `linear-gradient(${direction}, ${stops.map(([c, p]) => `${c} ${p}`).join(", ")})`;
  return { backgroundImage: value } as unknown as TextStyle;
}

/* ------------------------------------------------------------------ */
/* Font stack                                                          */
/* ------------------------------------------------------------------ */

export const fonts = {
  sans: undefined,
  mono: undefined,
} as const;

/* ------------------------------------------------------------------ */
/* Composite theme                                                     */
/* ------------------------------------------------------------------ */

export const theme = {
  palette,
  spacing,
  radius,
  type,
  layout,
  elevation,
  glow,
  tone,
};
export type Theme = typeof theme;

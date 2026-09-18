/**
 * POSA application shell — v2.
 *
 * The sidebar, header, page layout and navigation primitives that every
 * authenticated screen uses. v2 improvements:
 *
 *   - Sidebar: glass-panel feel with accent glow on active items.
 *   - Header: cleaner layout with better status indicators.
 *   - Page: tighter spacing system with better max-width handling.
 *   - PermissionDenied: more helpful with a visual identity.
 */

import React, { useMemo, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { usePathname, useRouter } from "expo-router";
import { NAV_CAPABILITIES, can as canDo } from "@/domain/permissions";
import { formatMoney } from "@/domain/money";
import { useApp } from "@/state/app";
import {
  Badge,
  Box,
  Button,
  Dot,
  IconButton,
  Money,
  Txt,
  styles as primitives,
} from "./primitives";
import { palette, layout, radius, spacing, tone, type ToneName } from "./theme";

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>["name"];

/* ------------------------------------------------------------------ */
/* Navigation metadata                                                 */
/* ------------------------------------------------------------------ */

const NAV_META: Record<string, { href: string; icon: IconName }> = {
  dashboard: { href: "/(app)", icon: "view-dashboard-outline" },
  pos: { href: "/(app)/checkout", icon: "point-of-sale" },
  held: { href: "/(app)/held", icon: "pause-circle-outline" },
  products: { href: "/(app)/products", icon: "package-variant-closed" },
  inventory: { href: "/(app)/inventory", icon: "warehouse" },
  count: { href: "/(app)/count", icon: "clipboard-list-outline" },
  purchases: { href: "/(app)/purchases", icon: "truck-delivery-outline" },
  suppliers: { href: "/(app)/suppliers", icon: "account-tie-outline" },
  customers: { href: "/(app)/customers", icon: "account-group-outline" },
  returns: { href: "/(app)/returns", icon: "backup-restore" },
  shifts: { href: "/(app)/shifts", icon: "cash-register" },
  expenses: { href: "/(app)/expenses", icon: "receipt-text-outline" },
  reports: { href: "/(app)/reports", icon: "chart-box-outline" },
  staff: { href: "/(app)/staff", icon: "badge-account-outline" },
  branches: { href: "/(app)/branches", icon: "store-marker-outline" },
  devices: { href: "/(app)/devices", icon: "tablet-cellphone" },
  sync: { href: "/(app)/sync", icon: "cloud-sync-outline" },
  audit: { href: "/(app)/audit", icon: "shield-search" },
  settings: { href: "/(app)/settings", icon: "cog-outline" },
};

const NAV_GROUPS: readonly {
  key: string;
  label: string;
  icon: IconName;
  items: readonly string[];
}[] = [
  {
    key: "sell",
    label: "Sell",
    icon: "point-of-sale",
    items: ["pos", "held", "returns", "shifts"],
  },
  {
    key: "catalog",
    label: "Catalog & stock",
    icon: "warehouse",
    items: ["products", "inventory", "count", "purchases", "suppliers"],
  },
  {
    key: "customers",
    label: "Customers",
    icon: "account-group-outline",
    items: ["customers"],
  },
  {
    key: "insights",
    label: "Insights",
    icon: "chart-box-outline",
    items: ["expenses", "reports"],
  },
  {
    key: "admin",
    label: "Manage",
    icon: "tune-variant",
    items: ["staff", "branches", "devices", "sync", "audit", "settings"],
  },
];

export function useNavigationItems() {
  const subject = useApp((state) => state.subject);
  return useMemo(
    () =>
      NAV_CAPABILITIES.filter(
        (capability) =>
          canDo(subject, capability.permission) ||
          (capability.viewPermission
            ? canDo(subject, capability.viewPermission)
            : false),
      )
        .map((capability) => ({
          key: capability.key,
          label: capability.label,
          ...(NAV_META[capability.key] ?? {
            href: "/(app)",
            icon: "circle-outline" as IconName,
          }),
        }))
        .filter((item) => item.href !== "/(app)" || item.key === "dashboard"),
    [subject],
  );
}

/* ------------------------------------------------------------------ */
/* Sidebar                                                             */
/* ------------------------------------------------------------------ */

export function Sidebar({ collapsed }: { collapsed: boolean }) {
  const items = useNavigationItems();
  const router = useRouter();
  const pathname = usePathname();
  const business = useApp((state) => state.business);
  const pending = useApp((state) => state.syncStatus.pending);
  const itemByKey = useMemo(
    () => new Map(items.map((item) => [item.key, item])),
    [items],
  );
  const activeGroup = NAV_GROUPS.find((group) =>
    group.items.some((key) => {
      const item = itemByKey.get(key);
      return item ? pathname.includes(item.href.replace("/(app)/", "")) : false;
    }),
  )?.key;
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => ({
    sell: true,
    catalog: true,
    customers: true,
    insights: false,
    admin: false,
  }));

  const isActive = (href: string) => {
    if (href === "/(app)")
      return (
        pathname === "/" || pathname === "/(app)" || pathname.endsWith("/(app)")
      );
    return pathname.includes(href.replace("/(app)/", ""));
  };

  return (
    <View style={[styles.sidebar, collapsed && styles.sidebarCollapsed]}>
      {/* Brand */}
      <Box row gap={spacing.sm} style={styles.brand}>
        <View style={styles.brandMark}>
          <MaterialCommunityIcons
            name="storefront-outline"
            size={18}
            color={palette.textInverse}
          />
        </View>
        {!collapsed ? (
          <Box style={primitives.flex}>
            <Txt variant="h3">POSA</Txt>
            <Txt variant="caption" color={palette.textFaint} numberOfLines={1}>
              {business?.name ?? "Retail operations"}
            </Txt>
          </Box>
        ) : null}
      </Box>

      {/* Primary navigation */}
      <ScrollView
        style={styles.navScroll}
        contentContainerStyle={styles.navScrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.navList}>
          {itemByKey.has("dashboard") ? (
            <NavItem
              label="Overview"
              icon={itemByKey.get("dashboard")!.icon}
              active={isActive(itemByKey.get("dashboard")!.href)}
              collapsed={collapsed}
              badge={null}
              onPress={() =>
                router.push(itemByKey.get("dashboard")!.href as never)
              }
            />
          ) : null}

          {NAV_GROUPS.map((group) => {
            const groupItems = group.items
              .map((key) => itemByKey.get(key))
              .filter(Boolean) as typeof items;
            if (groupItems.length === 0) return null;
            const isGroupActive = groupItems.some((item) =>
              isActive(item.href),
            );
            const isExpanded = expanded[group.key] || activeGroup === group.key;
            return (
              <View key={group.key} style={styles.navGroup}>
                {!collapsed ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded: isExpanded }}
                    onPress={() =>
                      setExpanded((current) => ({
                        ...current,
                        [group.key]: !isExpanded,
                      }))
                    }
                    style={[
                      styles.groupHeader,
                      isGroupActive && styles.groupHeaderActive,
                    ]}
                  >
                    <MaterialCommunityIcons
                      name={group.icon}
                      size={14}
                      color={isGroupActive ? palette.accent : palette.textMuted}
                    />
                    <Txt
                      variant="overline"
                      color={isGroupActive ? palette.accent : palette.textMuted}
                      style={primitives.flex}
                    >
                      {group.label}
                    </Txt>
                    <MaterialCommunityIcons
                      name={isExpanded ? "chevron-up" : "chevron-down"}
                      size={16}
                      color={palette.textFaint}
                    />
                  </Pressable>
                ) : null}
                {isExpanded || collapsed ? (
                  <View style={!collapsed ? styles.subNav : undefined}>
                    {groupItems.map((item) => (
                      <NavItem
                        key={item.key}
                        label={item.label}
                        icon={item.icon}
                        active={isActive(item.href)}
                        collapsed={collapsed}
                        badge={
                          item.key === "sync" && pending > 0 ? pending : null
                        }
                        onPress={() => router.push(item.href as never)}
                        nested={!collapsed}
                      />
                    ))}
                  </View>
                ) : null}
              </View>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

function NavItem({
  label,
  icon,
  active,
  collapsed,
  badge,
  nested = false,
  onPress,
}: {
  label: string;
  icon: IconName;
  active: boolean;
  collapsed: boolean;
  badge: number | null;
  nested?: boolean;
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[
        styles.navItem,
        collapsed && styles.navItemCollapsed,
        nested && styles.navItemNested,
        active && styles.navItemActive,
        !active && hovered ? styles.navItemHover : null,
      ]}
    >
      {active ? <View style={styles.navAccent} /> : null}
      <MaterialCommunityIcons
        name={icon}
        size={18}
        color={active ? palette.accent : palette.textMuted}
      />
      {!collapsed ? (
        <Txt
          variant="label"
          color={active ? palette.text : palette.textSecondary}
          style={primitives.flex}
          numberOfLines={1}
        >
          {label}
        </Txt>
      ) : null}
      {badge !== null ? (
        <View style={styles.navBadge}>
          <Txt variant="caption" color={palette.textInverse}>
            {badge > 99 ? "99+" : String(badge)}
          </Txt>
        </View>
      ) : null}
    </Pressable>
  );
}

/* ------------------------------------------------------------------ */
/* Sync pill                                                           */
/* ------------------------------------------------------------------ */

export function SyncPill({ onPress }: { onPress?: () => void }) {
  const status = useApp((state) => state.syncStatus);
  const cloud = useApp((state) => state.cloudLabel);
  const [syncHovered, setSyncHovered] = useState(false);

  const { toneName, icon, label, detail } = syncAppearance(
    status,
    cloud.configured,
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Sync status: ${label}`}
      onPress={onPress}
      onHoverIn={() => setSyncHovered(true)}
      onHoverOut={() => setSyncHovered(false)}
      style={[
        styles.syncPill,
        {
          borderColor: tone(toneName).border,
          backgroundColor: tone(toneName).bg,
        },
        syncHovered ? { opacity: 0.86 } : null,
      ]}
    >
      <Dot toneName={toneName} size={7} />
      <MaterialCommunityIcons name={icon} size={14} color={tone(toneName).fg} />
      <Box>
        <Txt variant="label" color={tone(toneName).fg}>
          {label}
        </Txt>
        <Txt variant="caption" color={palette.textMuted} numberOfLines={1}>
          {detail}
        </Txt>
      </Box>
    </Pressable>
  );
}

function syncAppearance(
  status: ReturnType<typeof useApp.getState>["syncStatus"],
  configured: boolean,
): { toneName: ToneName; icon: IconName; label: string; detail: string } {
  if (!configured) {
    return {
      toneName: "neutral",
      icon: "harddisk",
      label: "Local only",
      detail:
        status.pending > 0
          ? `${status.pending} waiting to upload`
          : "All changes on this device",
    };
  }
  if (status.state === "error") {
    return {
      toneName: "danger",
      icon: "cloud-alert",
      label: "Sync problem",
      detail: status.lastError ?? "Retrying",
    };
  }
  if (!status.online) {
    return {
      toneName: "warning",
      icon: "cloud-off-outline",
      label: "Offline",
      detail: "Selling locally",
    };
  }
  if (status.pending > 0) {
    return {
      toneName: "info",
      icon: "cloud-upload-outline",
      label: "Syncing",
      detail: `${status.pending} in queue`,
    };
  }
  if (status.openConflicts > 0) {
    return {
      toneName: "warning",
      icon: "cloud-question",
      label: "Conflicts",
      detail: `${status.openConflicts} need review`,
    };
  }
  return {
    toneName: "accent",
    icon: "cloud-check-outline",
    label: "Synced",
    detail: status.lastSyncAt ? relativeTime(status.lastSyncAt) : "Up to date",
  };
}

export function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const delta = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(delta)) return "unknown";
  const seconds = Math.round(delta / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/* ------------------------------------------------------------------ */
/* Header                                                              */
/* ------------------------------------------------------------------ */

export function Header({
  title,
  subtitle,
  actions,
  showMenuButton,
  onToggleMenu,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  showMenuButton?: boolean;
  onToggleMenu?: () => void;
}) {
  const router = useRouter();
  const session = useApp((state) => state.session);
  const branch = useApp((state) => state.branch);
  const openShift = useApp((state) => state.openShift);
  const signOut = useApp((state) => state.signOut);

  return (
    <View style={styles.header}>
      {showMenuButton ? (
        <IconButton
          icon="menu"
          label="Toggle navigation"
          onPress={onToggleMenu}
        />
      ) : null}
      <Box style={primitives.flex}>
        <Txt variant="h2" numberOfLines={1}>
          {title}
        </Txt>
        {subtitle ? (
          <Txt variant="caption" color={palette.textMuted} numberOfLines={1}>
            {subtitle}
          </Txt>
        ) : null}
      </Box>

      <Box row gap={spacing.sm}>
        {actions}
        <SyncPill onPress={() => router.push("/(app)/sync" as never)} />
        {openShift ? (
          <Badge
            label={`Shift open · ${formatMoney(openShift.openingFloat, { compact: true })} float`}
            toneName="accent"
            icon="cash-register"
          />
        ) : (
          <Badge label="No shift" toneName="warning" icon="cash-register" />
        )}
      </Box>

      <Box row gap={spacing.sm} style={styles.userChip}>
        <View style={styles.avatar}>
          <Txt variant="label" color={palette.textInverse}>
            {initials(session?.fullName ?? "?")}
          </Txt>
        </View>
        <Box>
          <Txt variant="label" numberOfLines={1}>
            {session?.fullName ?? "Not signed in"}
          </Txt>
          <Txt variant="caption" color={palette.textMuted} numberOfLines={1}>
            {branch?.name ?? "No branch"}
          </Txt>
        </Box>
        <IconButton
          icon="logout"
          label="Sign out"
          onPress={() => void signOut()}
          size={34}
        />
      </Box>
    </View>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

/* ------------------------------------------------------------------ */
/* Page layout                                                         */
/* ------------------------------------------------------------------ */

export function Page({
  children,
  style,
  maxWidth = layout.contentMax,
  gap = spacing.lg,
}: {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  maxWidth?: number | null;
  gap?: number;
}) {
  return (
    <ScrollView
      style={[
        styles.page,
        maxWidth === null ? null : ({ maxWidth, width: "100%" } as ViewStyle),
        style,
      ]}
      contentContainerStyle={[styles.pageContent, { gap }]}
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  );
}

export function PageGrid({
  children,
  minWidth = 300,
  gap = spacing.lg,
}: {
  children?: React.ReactNode;
  minWidth?: number;
  gap?: number;
}) {
  return <View style={[styles.grid, { gap }]}>{children}</View>;
}

export function StatGrid({
  children,
  gap = spacing.md,
}: {
  children?: React.ReactNode;
  gap?: number;
}) {
  return <View style={[styles.statGrid, { gap }]}>{children}</View>;
}

/* ------------------------------------------------------------------ */
/* Permission denied                                                   */
/* ------------------------------------------------------------------ */

export function PermissionDenied({ what }: { what: string }) {
  const router = useRouter();
  return (
    <Page>
      <Box style={styles.denied}>
        <View style={styles.deniedIcon}>
          <MaterialCommunityIcons
            name="lock-outline"
            size={32}
            color={palette.textFaint}
          />
        </View>
        <Txt variant="h1" align="center">
          Access restricted
        </Txt>
        <Txt
          variant="body"
          color={palette.textMuted}
          align="center"
          style={{ maxWidth: 400 }}
        >
          You do not have permission to access {what}. Ask an owner or manager
          to update your role — permission changes apply the next time this
          terminal signs in.
        </Txt>
        <Button
          label="Back to checkout"
          variant="primary"
          icon="point-of-sale"
          onPress={() => router.push("/(app)/checkout" as never)}
        />
      </Box>
    </Page>
  );
}

/* ------------------------------------------------------------------ */
/* NoticeBar                                                           */
/* ------------------------------------------------------------------ */

export function NoticeBar({
  toneName,
  icon,
  title,
  message,
  action,
}: {
  toneName: ToneName;
  icon: IconName;
  title: string;
  message: string;
  action?: React.ReactNode;
}) {
  const t = tone(toneName);
  return (
    <View
      style={[styles.notice, { borderColor: t.border, backgroundColor: t.bg }]}
    >
      <View style={[styles.noticeIcon, { backgroundColor: t.bg }]}>
        <MaterialCommunityIcons name={icon} size={18} color={t.fg} />
      </View>
      <Box style={primitives.flex}>
        <Txt variant="bodyStrong" color={t.fg}>
          {title}
        </Txt>
        <Txt variant="caption" color={palette.textSecondary}>
          {message}
        </Txt>
      </Box>
      {action}
    </View>
  );
}

export { Money };

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */

const styles = StyleSheet.create({
  /* Sidebar */
  sidebar: {
    width: layout.sidebarWidth,
    backgroundColor: palette.surface,
    borderRightWidth: 1,
    borderRightColor: palette.borderSubtle,
    paddingVertical: spacing.md,
  },
  sidebarCollapsed: { width: layout.sidebarCollapsed, alignItems: "center" },
  brand: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    alignItems: "center",
  },
  brandMark: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: palette.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  navList: { paddingHorizontal: spacing.sm, gap: 2 },
  navScroll: { flex: 1, minHeight: 0 },
  navScrollContent: { paddingBottom: spacing.lg },
  navGroup: { gap: 2 },
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: 36,
    paddingHorizontal: spacing.md,
    marginTop: spacing.sm,
    borderRadius: radius.sm,
  },
  groupHeaderActive: { backgroundColor: palette.accentSofter },
  subNav: { paddingLeft: spacing.sm },
  navItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    height: 44,
    borderRadius: radius.md,
    overflow: "hidden",
  },
  navItemNested: { height: 40, paddingLeft: spacing.lg },
  navItemCollapsed: {
    justifyContent: "center",
    paddingHorizontal: 0,
    width: 44,
    alignSelf: "center",
  },
  navItemActive: { backgroundColor: palette.accentSoft },
  navItemHover: { backgroundColor: palette.surfaceHover },
  navAccent: {
    position: "absolute",
    left: 0,
    top: 6,
    bottom: 6,
    width: 3,
    borderRadius: 2,
    backgroundColor: palette.accent,
  },
  navBadge: {
    minWidth: 22,
    paddingHorizontal: 5,
    height: 18,
    borderRadius: radius.pill,
    backgroundColor: palette.info,
    alignItems: "center",
    justifyContent: "center",
  },

  /* Sync pill */
  syncPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    maxWidth: 240,
  },

  /* Header */
  header: {
    height: layout.headerHeight,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    borderBottomWidth: 1,
    borderBottomColor: palette.borderSubtle,
    backgroundColor: palette.surface,
  },
  userChip: {
    paddingLeft: spacing.md,
    borderLeftWidth: 1,
    borderLeftColor: palette.border,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    backgroundColor: palette.accent,
    alignItems: "center",
    justifyContent: "center",
  },

  /* Page */
  page: {
    flex: 1,
    minHeight: 0,
    padding: spacing.xl,
    alignSelf: "center",
  },
  pageContent: { flexGrow: 1 },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  statGrid: { flexDirection: "row", flexWrap: "wrap" },

  /* Permission denied */
  denied: {
    alignItems: "center",
    gap: spacing.lg,
    paddingVertical: spacing.xxxxl,
    maxWidth: 460,
    alignSelf: "center",
  },
  deniedIcon: {
    width: 80,
    height: 80,
    borderRadius: radius.xxl,
    backgroundColor: palette.surfaceRaised,
    alignItems: "center",
    justifyContent: "center",
  },

  /* Notice */
  notice: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  noticeIcon: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
});

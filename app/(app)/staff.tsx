import React, { useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { ulid } from "@/domain/ulid";
import type { PermissionKey, RoleKey } from "@/domain/permissions";
import {
  ALL_PERMISSIONS,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  effectivePermissions,
} from "@/domain/permissions";
import type { User } from "@/domain/types";
import { outboxEvent } from "@/data/mutations";
import { createSalt, hashPin, validatePin } from "@/services/credentials";
import { useApp } from "@/state/app";
import {
  Badge,
  Box,
  Button,
  Card,
  Chip,
  Divider,
  EmptyState,
  SearchField,
  TextField,
  Txt,
  styles as primitives,
} from "@/ui/primitives";
import { Sheet } from "@/ui/patterns";
import { Header, NoticeBar, Page, PermissionDenied } from "@/ui/shell";
import { palette, radius, spacing, tone } from "@/ui/theme";

const TASK_GROUPS: Array<{
  label: string;
  icon: React.ComponentProps<typeof MaterialCommunityIcons>["name"];
  tasks: PermissionKey[];
}> = [
  {
    label: "Selling & customers",
    icon: "point-of-sale",
    tasks: [
      "sale.create",
      "sale.hold",
      "sale.resume_other",
      "sale.void",
      "sale.discount",
      "sale.discount.unlimited",
      "sale.price_override",
      "return.create",
      "return.approve",
      "customer.view",
      "customer.manage",
    ],
  },
  {
    label: "Products & inventory",
    icon: "warehouse",
    tasks: [
      "product.view",
      "product.create",
      "product.update",
      "product.archive",
      "product.price_change",
      "barcode.manage",
      "inventory.view",
      "inventory.adjust",
      "inventory.receive",
      "inventory.transfer",
      "inventory.count",
    ],
  },
  {
    label: "Purchasing & finance",
    icon: "cash-multiple",
    tasks: [
      "supplier.manage",
      "purchase.create",
      "purchase.receive",
      "finance.expense",
      "finance.expense.approve",
      "finance.cash_movement",
      "shift.open",
      "shift.close",
      "shift.close_other",
    ],
  },
  {
    label: "Reports & administration",
    icon: "shield-outline",
    tasks: [
      "report.sales",
      "report.inventory",
      "report.finance",
      "report.staff",
      "report.audit",
      "admin.branch",
      "admin.staff",
      "admin.device",
      "admin.settings",
      "admin.sync",
      "admin.conflict_resolve",
      "admin.integration",
    ],
  },
];

const TASK_LABELS: Record<PermissionKey, string> = Object.fromEntries(
  ALL_PERMISSIONS.map((permission) => [
    permission,
    permission
      .replace(/\./g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase()),
  ]),
) as Record<PermissionKey, string>;

export default function StaffScreen() {
  const app = useApp();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<User | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  if (!app.can("admin.staff"))
    return <PermissionDenied what="staff and roles" />;

  const filtered = app.users.filter((user) =>
    `${user.fullName} ${user.email ?? ""} ${user.role}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const openNew = () => {
    setEditing(null);
    setFormOpen(true);
  };

  return (
    <View style={styles.page}>
      <Header
        title="Staff & roles"
        subtitle={`${app.users.length} accounts · assign exactly what each person can do`}
        actions={
          <Button
            label="Add staff"
            variant="primary"
            icon="account-plus-outline"
            onPress={openNew}
          />
        }
      />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <Page maxWidth={1400}>
          <NoticeBar
            toneName="info"
            icon="shield-key-outline"
            title="Roles are starting points, not limits"
            message="Choose a role bundle, then add or remove individual tasks for this person. Their effective permissions apply offline and are recorded in the audit trail."
          />
          <Box row gap={spacing.md} style={styles.toolbar}>
            <SearchField
              value={query}
              onChangeText={setQuery}
              placeholder="Search staff by name, role or contact"
              style={primitives.flex}
            />
            <Button
              label="Role guide"
              variant="secondary"
              icon="help-circle-outline"
              onPress={() => undefined}
            />
          </Box>
          {filtered.length === 0 ? (
            <EmptyState
              icon="badge-account-outline"
              title="No staff match"
              message="Add a staff account or try a different search."
              action={
                <Button label="Add staff" variant="primary" onPress={openNew} />
              }
            />
          ) : (
            <Box gap={spacing.md}>
              {filtered.map((user) => (
                <StaffCard
                  key={user.id}
                  user={user}
                  onEdit={() => {
                    setEditing(user);
                    setFormOpen(true);
                  }}
                />
              ))}
            </Box>
          )}
        </Page>
      </ScrollView>
      <StaffForm
        visible={formOpen}
        user={editing}
        onClose={() => setFormOpen(false)}
      />
    </View>
  );
}

function StaffCard({ user, onEdit }: { user: User; onEdit: () => void }) {
  const subject = {
    role: user.role,
    branchIds: user.branchIds,
    status: user.status,
    granted: user.granted,
    revoked: user.revoked,
  };
  const permissions = effectivePermissions(subject);
  const toneName =
    user.role === "owner"
      ? "accent"
      : user.role === "manager"
        ? "violet"
        : user.role === "admin"
          ? "danger"
          : "info";
  return (
    <Card>
      <Box row gap={spacing.lg} style={styles.cardTop}>
        <View
          style={[
            styles.avatar,
            {
              backgroundColor: tone(toneName).bg,
              borderColor: tone(toneName).border,
            },
          ]}
        >
          <Txt variant="h3" color={tone(toneName).fg}>
            {initials(user.fullName)}
          </Txt>
        </View>
        <Box style={primitives.flex} gap={spacing.xs}>
          <Box row gap={spacing.sm} style={styles.cardName}>
            <Txt variant="h3" numberOfLines={1}>
              {user.fullName}
            </Txt>
            <Badge
              label={user.status}
              toneName={
                user.status === "active"
                  ? "accent"
                  : user.status === "invited"
                    ? "info"
                    : "danger"
              }
              compact
            />
          </Box>
          <Txt variant="caption" color={palette.textMuted}>
            {ROLE_LABELS[user.role]} ·{" "}
            {user.email ?? user.phone ?? "No contact added"}
          </Txt>
          <Txt variant="caption" color={palette.textFaint}>
            {permissions.size} active tasks ·{" "}
            {user.branchIds.length === 0
              ? "All branches"
              : `${user.branchIds.length} branch scope`}
          </Txt>
        </Box>
        <Button
          label="Manage"
          variant="secondary"
          size="sm"
          icon="account-edit-outline"
          onPress={onEdit}
        />
      </Box>
      <Divider />
      <Box row gap={spacing.sm} style={styles.taskPreview}>
        {[...permissions].slice(0, 5).map((permission) => (
          <Chip
            key={permission}
            label={TASK_LABELS[permission]}
            selected
            onPress={() => undefined}
          />
        ))}
        {permissions.size > 5 ? (
          <Txt
            variant="caption"
            color={palette.textMuted}
            style={styles.moreTasks}
          >
            +{permissions.size - 5} more tasks
          </Txt>
        ) : null}
      </Box>
    </Card>
  );
}

function StaffForm({
  visible,
  user,
  onClose,
}: {
  visible: boolean;
  user: User | null;
  onClose: () => void;
}) {
  const app = useApp();
  const [name, setName] = useState(user?.fullName ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [phone, setPhone] = useState(user?.phone ?? "");
  const [role, setRole] = useState<RoleKey>(user?.role ?? "cashier");
  const [status, setStatus] = useState<User["status"]>(
    user?.status ?? "active",
  );
  const [pin, setPin] = useState("");
  const [granted, setGranted] = useState<PermissionKey[]>(user?.granted ?? []);
  const [revoked, setRevoked] = useState<PermissionKey[]>(user?.revoked ?? []);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  React.useEffect(() => {
    setName(user?.fullName ?? "");
    setEmail(user?.email ?? "");
    setPhone(user?.phone ?? "");
    setRole(user?.role ?? "cashier");
    setStatus(user?.status ?? "active");
    setPin("");
    setGranted(user?.granted ?? []);
    setRevoked(user?.revoked ?? []);
    setError(null);
  }, [user, visible]);

  const base = new Set(ROLE_PERMISSIONS[role]);
  const effective = new Set(
    [...base, ...granted].filter((permission) => !revoked.includes(permission)),
  );
  const toggleTask = (permission: PermissionKey) => {
    if (base.has(permission))
      setRevoked((current) =>
        current.includes(permission)
          ? current.filter((item) => item !== permission)
          : [...current, permission],
      );
    else
      setGranted((current) =>
        current.includes(permission)
          ? current.filter((item) => item !== permission)
          : [...current, permission],
      );
  };
  const save = async () => {
    if (!name.trim()) {
      setError("Enter the staff member’s full name.");
      return;
    }
    if (!app.business || !app.data || !app.branch) return;
    const device = app.device;
    if (!device) return;
    if (!user) {
      const pinError = validatePin(pin);
      if (pinError) {
        setError(pinError);
        return;
      }
    }
    setSaving(true);
    try {
      const next: User = {
        id: user?.id ?? ulid(),
        businessId: app.business.id,
        fullName: name.trim(),
        email: email.trim() || null,
        phone: phone.trim() || null,
        credentialHash: user?.credentialHash ?? null,
        offlineVerifier: user?.offlineVerifier ?? null,
        pinHash:
          user?.pinHash ?? (pin ? await hashPin(pin, createSalt()) : null),
        role,
        branchIds: user?.branchIds ?? [app.branch.id],
        granted,
        revoked,
        status,
        authorizationVersion: (user?.authorizationVersion ?? 0) + 1,
        lastLoginAt: user?.lastLoginAt ?? null,
        createdAt: user?.createdAt ?? new Date().toISOString(),
      };
      await app.data.saveUser(
        next,
        outboxEvent({
          businessId: next.businessId,
          branchId: next.branchIds[0] ?? null,
          deviceId: device.id,
          entity: "user",
          entityId: next.id,
          payload: next,
          baseRevision: user ? 1 : 0,
        }),
      );
      useApp.setState({
        users: [...app.users.filter((item) => item.id !== next.id), next],
      });
      app.pushToast({
        message: user ? "Staff account updated" : "Staff account created",
        detail: `${next.fullName} · ${ROLE_LABELS[next.role]} · ${effective.size} tasks`,
        toneName: "accent",
      });
      onClose();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not save staff account.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      visible={visible}
      title={user ? "Manage staff account" : "Add staff member"}
      subtitle="Role, task access and offline sign-in"
      onClose={onClose}
      width={680}
      footer={
        <>
          <Button label="Cancel" variant="ghost" onPress={onClose} />
          <Button
            label={user ? "Save changes" : "Create account"}
            variant="primary"
            loading={saving}
            onPress={() => void save()}
          />
        </>
      }
    >
      <Box gap={spacing.lg}>
        <Box row gap={spacing.md}>
          <TextField
            label="Full name"
            value={name}
            onChangeText={setName}
            placeholder="Amina Yusuf"
            icon="account-outline"
            style={primitives.flex}
          />
          <TextField
            label="Phone"
            value={phone}
            onChangeText={setPhone}
            placeholder="Optional"
            keyboardType="phone-pad"
            icon="phone-outline"
            style={primitives.flex}
          />
        </Box>
        <TextField
          label="Email"
          value={email}
          onChangeText={setEmail}
          placeholder="Optional"
          keyboardType="email-address"
          icon="email-outline"
        />
        <Box gap={spacing.sm}>
          <Txt variant="label" color={palette.textMuted}>
            ROLE PRESET
          </Txt>
          <Box row gap={spacing.sm} style={styles.wrap}>
            {(
              [
                "cashier",
                "inventory",
                "accountant",
                "manager",
                "admin",
              ] as RoleKey[]
            ).map((key) => (
              <Chip
                key={key}
                label={ROLE_LABELS[key]}
                selected={role === key}
                onPress={() => {
                  setRole(key);
                  setGranted([]);
                  setRevoked([]);
                }}
              />
            ))}
          </Box>
          <Txt variant="caption" color={palette.textMuted}>
            {ROLE_DESCRIPTIONS[role]}
          </Txt>
        </Box>
        <Box gap={spacing.sm}>
          <Txt variant="label" color={palette.textMuted}>
            ACCOUNT STATUS
          </Txt>
          <Box row gap={spacing.sm}>
            <Chip
              label="Active"
              selected={status === "active"}
              onPress={() => setStatus("active")}
              icon="check"
            />
            <Chip
              label="Invited"
              selected={status === "invited"}
              onPress={() => setStatus("invited")}
              icon="email-edit-outline"
            />
            <Chip
              label="Suspended"
              selected={status === "suspended"}
              onPress={() => setStatus("suspended")}
              icon="pause-circle-outline"
            />
          </Box>
        </Box>
        {!user ? (
          <TextField
            label="Offline PIN"
            value={pin}
            onChangeText={(value) =>
              setPin(value.replace(/[^0-9]/g, "").slice(0, 6))
            }
            placeholder="4–6 digits"
            keyboardType="numeric"
            secureTextEntry
            mono
            icon="key-outline"
            hint="The staff member will use this PIN on this terminal."
          />
        ) : null}
        <Divider />
        <Box row style={styles.taskHeading}>
          <Box style={primitives.flex}>
            <Txt variant="h3">What can this person do?</Txt>
            <Txt variant="caption" color={palette.textMuted}>
              {effective.size} tasks enabled
            </Txt>
          </Box>
          <Button
            label="Reset to role"
            variant="ghost"
            size="sm"
            onPress={() => {
              setGranted([]);
              setRevoked([]);
            }}
          />
        </Box>
        {TASK_GROUPS.map((group) => (
          <Card key={group.label} toneName="neutral">
            <Box gap={spacing.sm}>
              <Box row gap={spacing.sm}>
                <MaterialCommunityIcons
                  name={group.icon}
                  size={18}
                  color={palette.accent}
                />
                <Txt variant="bodyStrong">{group.label}</Txt>
              </Box>
              <Box row gap={spacing.xs} style={styles.wrap}>
                {group.tasks.map((permission) => (
                  <Chip
                    key={permission}
                    label={TASK_LABELS[permission]}
                    selected={effective.has(permission)}
                    onPress={() => toggleTask(permission)}
                  />
                ))}
              </Box>
            </Box>
          </Card>
        ))}
        {error ? (
          <Txt variant="caption" color={palette.danger}>
            {error}
          </Txt>
        ) : null}
      </Box>
    </Sheet>
  );
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.length > 1
    ? `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
    : (parts[0]?.slice(0, 2).toUpperCase() ?? "?");
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.bg },
  scroll: { flex: 1 },
  content: { flexGrow: 1 },
  toolbar: { alignItems: "center" },
  cardTop: { alignItems: "center" },
  cardName: { alignItems: "center" },
  avatar: {
    width: 50,
    height: 50,
    borderRadius: radius.pill,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  taskPreview: { flexWrap: "wrap", alignItems: "center" },
  moreTasks: { marginLeft: spacing.xs },

  wrap: { flexWrap: "wrap" },
  taskHeading: { alignItems: "center" },
});

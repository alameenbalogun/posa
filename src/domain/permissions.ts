/**
 * Role-based access control (PRD §8).
 *
 * Design notes:
 *  - Permissions are a flat set of strings. Roles are just named bundles, so a
 *    business can later define custom roles without a schema change.
 *  - `can()` is pure and used by BOTH the offline UI and (mirrored) the server.
 *    The UI check is a convenience; the server check is the law (PRD §47).
 *  - The offline terminal evaluates permissions from the *last synchronised*
 *    authorization state, so a revoked manager can't keep approving refunds
 *    forever just because the store lost internet (PRD §22).
 */

import type { PermissionKey, RoleKey, BusinessSettings } from './types';

// Re-exported so callers can talk about capabilities without reaching into the
// entity module — permissions and their names belong together.
export type { PermissionKey, RoleKey };

export const ALL_PERMISSIONS: readonly PermissionKey[] = [
  'sale.create',
  'sale.hold',
  'sale.resume_other',
  'sale.void',
  'sale.discount',
  'sale.discount.unlimited',
  'sale.price_override',
  'return.create',
  'return.approve',
  'inventory.view',
  'inventory.adjust',
  'inventory.receive',
  'inventory.transfer',
  'inventory.count',
  'product.view',
  'product.create',
  'product.update',
  'product.archive',
  'product.price_change',
  'barcode.manage',
  'customer.view',
  'customer.manage',
  'supplier.manage',
  'purchase.create',
  'purchase.receive',
  'finance.expense',
  'finance.expense.approve',
  'finance.cash_movement',
  'shift.open',
  'shift.close',
  'shift.close_other',
  'report.sales',
  'report.inventory',
  'report.finance',
  'report.staff',
  'report.audit',
  'admin.branch',
  'admin.staff',
  'admin.device',
  'admin.settings',
  'admin.sync',
  'admin.conflict_resolve',
  'admin.integration',
];

/**
 * Default role bundles. Ordered from least to most privileged so the UI can
 * reason about "is this a promotion or a demotion".
 */
export const ROLE_PERMISSIONS: Record<RoleKey, readonly PermissionKey[]> = {
  cashier: [
    'sale.create',
    'sale.hold',
    'sale.discount',
    'return.create',
    'customer.view',
    'customer.manage',
    'product.view',
    'inventory.view',
    'shift.open',
    'shift.close',
  ],
  inventory: [
    'product.view',
    'product.create',
    'product.update',
    'barcode.manage',
    'inventory.view',
    'inventory.adjust',
    'inventory.receive',
    'inventory.transfer',
    'inventory.count',
    'supplier.manage',
    'purchase.create',
    'purchase.receive',
    'report.inventory',
  ],
  accountant: [
    'product.view',
    'inventory.view',
    'customer.view',
    'finance.expense',
    'finance.cash_movement',
    'report.sales',
    'report.inventory',
    'report.finance',
    'report.audit',
  ],
  manager: [
    'sale.create',
    'sale.hold',
    'sale.resume_other',
    'sale.void',
    'sale.discount',
    'sale.price_override',
    'return.create',
    'return.approve',
    'product.view',
    'product.create',
    'product.update',
    'product.archive',
    'product.price_change',
    'barcode.manage',
    'inventory.view',
    'inventory.adjust',
    'inventory.receive',
    'inventory.transfer',
    'inventory.count',
    'customer.view',
    'customer.manage',
    'supplier.manage',
    'purchase.create',
    'purchase.receive',
    'finance.expense',
    'finance.expense.approve',
    'finance.cash_movement',
    'shift.open',
    'shift.close',
    'shift.close_other',
    'report.sales',
    'report.inventory',
    'report.finance',
    'report.staff',
    'report.audit',
    'admin.device',
    'admin.sync',
    'admin.conflict_resolve',
  ],
  owner: ALL_PERMISSIONS,
  admin: ALL_PERMISSIONS,
};

export const ROLE_LABELS: Record<RoleKey, string> = {
  owner: 'Business Owner',
  manager: 'Manager',
  cashier: 'Cashier',
  inventory: 'Inventory Manager',
  accountant: 'Accountant',
  admin: 'System Admin',
};

export const ROLE_DESCRIPTIONS: Record<RoleKey, string> = {
  owner: 'Full control of the business, branches, staff and finances.',
  manager: 'Runs the day: approvals, inventory, staff oversight and reports.',
  cashier: 'Sells, scans, takes payment and issues receipts.',
  inventory: 'Receives stock, counts, transfers and manages suppliers.',
  accountant: 'Reviews sales, expenses, reconciliation and financial reports.',
  admin: 'Configures terminals, integrations and technical settings.',
};

export interface PermissionSubject {
  role: RoleKey;
  branchIds: readonly string[];
  /** Custom overrides — additive grants or explicit revocations. */
  granted?: readonly PermissionKey[];
  revoked?: readonly PermissionKey[];
  status: 'active' | 'suspended' | 'invited';
}

/** Resolve the effective permission set for a subject. */
export function effectivePermissions(subject: PermissionSubject): Set<PermissionKey> {
  if (subject.status !== 'active') return new Set();
  const base = new Set<PermissionKey>(ROLE_PERMISSIONS[subject.role] ?? []);
  for (const extra of subject.granted ?? []) base.add(extra);
  for (const removed of subject.revoked ?? []) base.delete(removed);
  return base;
}

export function can(subject: PermissionSubject | null | undefined, permission: PermissionKey): boolean {
  if (!subject) return false;
  return effectivePermissions(subject).has(permission);
}

export function canAny(subject: PermissionSubject | null | undefined, permissions: readonly PermissionKey[]): boolean {
  if (!subject) return false;
  const set = effectivePermissions(subject);
  return permissions.some((p) => set.has(p));
}

export function canAll(subject: PermissionSubject | null | undefined, permissions: readonly PermissionKey[]): boolean {
  if (!subject) return false;
  const set = effectivePermissions(subject);
  return permissions.every((p) => set.has(p));
}

/** Is this subject scoped to the given branch? Owners and admins are global. */
export function canAccessBranch(subject: PermissionSubject | null | undefined, branchId: string): boolean {
  if (!subject) return false;
  if (subject.role === 'owner' || subject.role === 'admin') return true;
  return subject.branchIds.includes(branchId);
}

export function isPrivileged(role: RoleKey): boolean {
  return role === 'owner' || role === 'manager' || role === 'admin';
}

/* ------------------------------------------------------------------ */
/* Approval rules (PRD §8, §17, §18)                                   */
/* ------------------------------------------------------------------ */

export interface ApprovalRequirement {
  required: boolean;
  /** Permission the approver must hold, when approval is required. */
  approverPermission: PermissionKey | null;
  reason: string | null;
}

const NO_APPROVAL: ApprovalRequirement = { required: false, approverPermission: null, reason: null };

/**
 * Discount approval.
 *
 * The cashier bundle grants `sale.discount` but NOT `sale.discount.unlimited`.
 * So a cashier may discount up to the business ceiling on their own; anything
 * above it — or above their personal ceiling — needs a manager's approval event.
 */
export function requiresDiscountApproval(params: {
  subject: PermissionSubject | null;
  settings: BusinessSettings;
  /** The discount being applied, in basis points of the line/cart base. */
  basisPoints: number;
}): ApprovalRequirement {
  const { subject, settings, basisPoints } = params;
  if (basisPoints <= 0) return NO_APPROVAL;

  if (can(subject, 'sale.discount.unlimited')) return NO_APPROVAL;

  if (!can(subject, 'sale.discount')) {
    return {
      required: true,
      approverPermission: 'sale.discount',
      reason: 'You are not permitted to apply discounts.',
    };
  }

  if (basisPoints > settings.maxDiscountBasisPoints) {
    const pct = (settings.maxDiscountBasisPoints / 100).toFixed(1);
    return {
      required: true,
      approverPermission: 'sale.discount.unlimited',
      reason: `Discounts above ${pct}% need manager approval.`,
    };
  }

  return NO_APPROVAL;
}

const APPROVABLE: Record<string, PermissionKey> = {
  'sale.void': 'sale.void',
  'return.commit': 'return.approve',
  'sale.price_override': 'sale.price_override',
  'inventory.adjust': 'inventory.adjust',
  'product.price_change': 'product.price_change',
  'shift.variance': 'shift.close_other',
  'expense.create': 'finance.expense.approve',
  'sync.conflict_resolved': 'admin.conflict_resolve',
};

/**
 * Generic sensitive-action gate. Business settings can nominate any of these
 * actions as requiring a second pair of eyes; the actor must therefore hold the
 * permission themselves, or a different active user must approve.
 */
export function requiresApproval(params: {
  action: string;
  subject: PermissionSubject | null;
  settings: BusinessSettings;
}): ApprovalRequirement {
  const { action, subject, settings } = params;
  const needsApproval = settings.requireApprovalFor.includes(action as PermissionKey);
  if (!needsApproval) return NO_APPROVAL;
  if (can(subject, 'sale.discount.unlimited') || subject?.role === 'owner') return NO_APPROVAL;
  return {
    required: true,
    approverPermission: APPROVABLE[action] ?? null,
    reason: 'This action needs manager approval.',
  };
}

/* ------------------------------------------------------------------ */
/* Capability map for the navigation shell (PRD §34)                   */
/* ------------------------------------------------------------------ */

export interface NavCapability {
  key: string;
  label: string;
  permission: PermissionKey;
  /** Some screens need to be visible even without write permission. */
  viewPermission?: PermissionKey;
}

export const NAV_CAPABILITIES: readonly NavCapability[] = [
  { key: 'dashboard', label: 'Dashboard', permission: 'report.sales' },
  { key: 'pos', label: 'Checkout', permission: 'sale.create' },
  { key: 'held', label: 'Held Sales', permission: 'sale.create' },
  { key: 'products', label: 'Products', permission: 'product.view' },
  { key: 'inventory', label: 'Inventory', permission: 'inventory.view' },
  { key: 'count', label: 'Stock Count', permission: 'inventory.count' },
  { key: 'purchases', label: 'Purchases', permission: 'purchase.create', viewPermission: 'report.inventory' },
  { key: 'suppliers', label: 'Suppliers', permission: 'supplier.manage' },
  { key: 'customers', label: 'Customers', permission: 'customer.view' },
  { key: 'returns', label: 'Returns', permission: 'return.create' },
  { key: 'shifts', label: 'Cash Shifts', permission: 'shift.open' },
  { key: 'expenses', label: 'Expenses', permission: 'finance.expense' },
  { key: 'reports', label: 'Reports', permission: 'report.sales' },
  { key: 'staff', label: 'Staff & Roles', permission: 'admin.staff' },
  { key: 'branches', label: 'Branches', permission: 'admin.branch' },
  { key: 'devices', label: 'Devices', permission: 'admin.device' },
  { key: 'sync', label: 'Sync Center', permission: 'admin.sync', viewPermission: 'sale.create' },
  { key: 'audit', label: 'Audit Log', permission: 'report.audit' },
  { key: 'settings', label: 'Settings', permission: 'admin.settings' },
];

export function visibleNavKeys(subject: PermissionSubject | null): string[] {
  return NAV_CAPABILITIES.filter(
    (item) => can(subject, item.permission) || (item.viewPermission ? can(subject, item.viewPermission) : false),
  ).map((item) => item.key);
}

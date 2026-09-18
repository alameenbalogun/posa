import { describe, expect, it } from 'vitest';
import {
  backoffDelayMs,
  batchRank,
  conflictStrategyFor,
  entityRank,
  isRetryable,
  orderEvents,
  resolveConflict,
  type OutboxEvent,
} from '../sync-protocol';
import {
  can,
  canAccessBranch,
  effectivePermissions,
  requiresApproval,
  requiresDiscountApproval,
  visibleNavKeys,
  type PermissionSubject,
} from '../permissions';
import type { BusinessSettings } from '../types';

function event(overrides: Partial<OutboxEvent> & Pick<OutboxEvent, 'id' | 'entity' | 'entityId'>): OutboxEvent {
  return {
    businessId: 'biz1',
    branchId: 'br1',
    deviceId: 'dev1',
    op: 'insert',
    payload: {},
    baseRevision: 0,
    dependsOn: [],
    attempts: 0,
    lastError: null,
    nextAttemptAt: '2026-09-15T10:00:00.000Z',
    createdAt: '2026-09-15T10:00:00.000Z',
    ackedAt: null,
    serverRevision: null,
    ...overrides,
  };
}

describe('dependency-safe ordering', () => {
  it('ranks parents before children', () => {
    expect(entityRank('sale')).toBeLessThan(entityRank('sale_line'));
    expect(entityRank('sale')).toBeLessThan(entityRank('payment'));
    expect(entityRank('branch')).toBeLessThan(entityRank('product'));
    expect(entityRank('product')).toBeLessThan(entityRank('barcode'));
    expect(entityRank('return')).toBeLessThan(entityRank('return_line'));
    // A sale and its ledger entries are siblings: both must exist, and their
    // relative order is settled by the explicit `dependsOn` edge, not the rank.
    expect(entityRank('sale')).toBe(entityRank('inventory_ledger'));
    expect(entityRank('sale_line')).toBe(entityRank('payment'));
  });

  it('sorts a shuffled batch into a replayable order', () => {
    const sale = event({ id: 'ZZZ', entity: 'sale', entityId: 's1' });
    const line = event({ id: 'AAA', entity: 'sale_line', entityId: 'l1', dependsOn: ['ZZZ'] });
    const ledger = event({ id: 'BBB', entity: 'inventory_ledger', entityId: 'i1', dependsOn: ['ZZZ'] });
    const audit = event({ id: 'CCC', entity: 'audit_log', entityId: 'a1' });

    const ordered = orderEvents([audit, ledger, line, sale]);
    expect(ordered[0].entity).toBe('sale');
    expect(ordered.findIndex((e) => e.entity === 'sale')).toBeLessThan(ordered.findIndex((e) => e.entity === 'sale_line'));
    expect(ordered.findIndex((e) => e.entity === 'sale')).toBeLessThan(ordered.findIndex((e) => e.entity === 'inventory_ledger'));
    expect(ordered[ordered.length - 1].entity).toBe('audit_log');
  });

  it('is stable and total: nothing is dropped', () => {
    const events = [
      event({ id: '3', entity: 'product', entityId: 'p3' }),
      event({ id: '1', entity: 'product', entityId: 'p1' }),
      event({ id: '2', entity: 'product', entityId: 'p2' }),
    ];
    const ordered = orderEvents(events);
    expect(ordered.map((e) => e.entityId)).toEqual(['p1', 'p2', 'p3']);
  });

  it('still emits every event when the batch contains a dependency cycle', () => {
    const a = event({ id: 'A', entity: 'sale', entityId: 'a', dependsOn: ['B'] });
    const b = event({ id: 'B', entity: 'sale_line', entityId: 'b', dependsOn: ['A'] });
    const ordered = orderEvents([a, b]);
    expect(ordered).toHaveLength(2);
  });

  it('reports the highest rank in a batch', () => {
    expect(batchRank([event({ id: '1', entity: 'product', entityId: 'p' }), event({ id: '2', entity: 'audit_log', entityId: 'a' })])).toBe(
      entityRank('audit_log'),
    );
  });
});

describe('retry policy', () => {
  it('backs off exponentially with jitter', () => {
    const first = backoffDelayMs(1, 1000, 60_000);
    expect(first).toBeGreaterThanOrEqual(500);
    expect(first).toBeLessThanOrEqual(1000);
  });

  it('never exceeds the ceiling', () => {
    for (let attempt = 1; attempt <= 25; attempt += 1) {
      expect(backoffDelayMs(attempt, 2000, 60_000)).toBeLessThanOrEqual(60_000);
    }
  });

  it('retries only errors that can succeed later', () => {
    expect(isRetryable(undefined)).toBe(true);
    expect(isRetryable('transient')).toBe(true);
    expect(isRetryable('rate_limited')).toBe(true);
    expect(isRetryable('dependency_missing')).toBe(true);
    expect(isRetryable('validation_failed')).toBe(false);
    expect(isRetryable('tenant_mismatch')).toBe(false);
    expect(isRetryable('immutable_record')).toBe(false);
  });
});

describe('conflict strategy', () => {
  it('treats completed financial records as immutable', () => {
    expect(conflictStrategyFor('sale')).toBe('immutable');
    expect(conflictStrategyFor('inventory_ledger')).toBe('immutable');
    expect(conflictStrategyFor('payment')).toBe('immutable');
  });

  it('uses optimistic concurrency for catalog metadata', () => {
    expect(conflictStrategyFor('product')).toBe('optimistic');
  });

  it('escalates genuine metadata conflicts to an administrator', () => {
    const decision = resolveConflict({
      entity: 'product',
      localPayload: { name: 'Rice 5kg', updatedAt: '2026-09-15T10:00:00.000Z' },
      serverPayload: { name: 'Rice 5kg Premium', updatedAt: '2026-09-15T11:00:00.000Z' },
      baseRevision: 3,
      serverRevision: 5,
    });
    expect(decision.outcome).toBe('manual');
  });

  it('accepts the local edit when the cloud copy has not moved', () => {
    const decision = resolveConflict({
      entity: 'product',
      localPayload: { name: 'Rice 5kg', updatedAt: '2026-09-15T10:00:00.000Z' },
      serverPayload: { name: 'Rice 5kg', updatedAt: '2026-09-01T10:00:00.000Z' },
      baseRevision: 3,
      serverRevision: 3,
    });
    expect(decision.outcome).toBe('local');
  });

  it('never lets a terminal overwrite a completed sale', () => {
    const decision = resolveConflict({
      entity: 'sale',
      localPayload: { total: 9999 },
      serverPayload: { total: 2150 },
      baseRevision: 0,
      serverRevision: 4,
    });
    expect(decision.outcome).toBe('server');
    expect(decision.reason).toContain('cannot be rewritten');
  });

  it('lets the newest customer edit win', () => {
    const decision = resolveConflict({
      entity: 'customer',
      localPayload: { name: 'Ada', updatedAt: '2026-09-15T12:00:00.000Z' },
      serverPayload: { name: 'Ada N', updatedAt: '2026-09-15T10:00:00.000Z' },
      baseRevision: 1,
      serverRevision: 2,
    });
    expect(decision.outcome).toBe('local');
  });
});

describe('permissions', () => {
  const cashier: PermissionSubject = { role: 'cashier', branchIds: ['br1'], status: 'active' };
  const manager: PermissionSubject = { role: 'manager', branchIds: ['br1'], status: 'active' };
  const owner: PermissionSubject = { role: 'owner', branchIds: [], status: 'active' };

  const settings: BusinessSettings = {
    currency: 'NGN',
    taxInclusive: true,
    allowNegativeStock: false,
    requireApprovalFor: ['sale.void'],
    maxDiscountBasisPoints: 1000,
    offlineSessionMinutes: 480,
  };

  it('gives a cashier selling rights but not voids', () => {
    expect(can(cashier, 'sale.create')).toBe(true);
    expect(can(cashier, 'sale.void')).toBe(false);
  });

  it('gives an owner everything and a manager the operational set', () => {
    expect(can(owner, 'admin.settings')).toBe(true);
    expect(can(manager, 'sale.void')).toBe(true);
    expect(can(manager, 'admin.settings')).toBe(false);
  });

  it('strips permissions entirely from a suspended user', () => {
    expect(can({ ...manager, status: 'suspended' }, 'sale.create')).toBe(false);
    expect(effectivePermissions({ ...manager, status: 'suspended' }).size).toBe(0);
  });

  it('honours explicit grants and revocations over the role bundle', () => {
    const custom: PermissionSubject = { role: 'cashier', branchIds: ['br1'], status: 'active', granted: ['report.sales'], revoked: ['sale.discount'] };
    expect(can(custom, 'report.sales')).toBe(true);
    expect(can(custom, 'sale.discount')).toBe(false);
  });

  it('scopes a cashier to their own branch but lets an owner roam', () => {
    expect(canAccessBranch(cashier, 'br1')).toBe(true);
    expect(canAccessBranch(cashier, 'br2')).toBe(false);
    expect(canAccessBranch(owner, 'br2')).toBe(true);
  });

  describe('discount approval', () => {
    it('lets a cashier discount up to the business ceiling', () => {
      expect(requiresDiscountApproval({ subject: cashier, settings, basisPoints: 800 }).required).toBe(false);
    });

    it('escalates a discount above the ceiling', () => {
      const requirement = requiresDiscountApproval({ subject: cashier, settings, basisPoints: 2500 });
      expect(requirement.required).toBe(true);
      expect(requirement.approverPermission).toBe('sale.discount.unlimited');
    });

    it('never asks an owner for permission', () => {
      expect(requiresDiscountApproval({ subject: owner, settings, basisPoints: 9000 }).required).toBe(false);
    });

    it('refuses a user with no discount right at all', () => {
      const restricted: PermissionSubject = { role: 'inventory', branchIds: [], status: 'active' };
      expect(requiresDiscountApproval({ subject: restricted, settings, basisPoints: 100 }).required).toBe(true);
    });
  });

  describe('sensitive action approval', () => {
    it('requires approval when the business nominates the action', () => {
      expect(requiresApproval({ action: 'sale.void', subject: cashier, settings }).required).toBe(true);
    });

    it('does not require approval for an action the business has not nominated', () => {
      expect(requiresApproval({ action: 'sale.commit', subject: cashier, settings }).required).toBe(false);
    });

    it('exempts an owner from the approval gate', () => {
      expect(requiresApproval({ action: 'sale.void', subject: owner, settings }).required).toBe(false);
    });
  });

  describe('navigation capabilities', () => {
    it('shows a cashier only what they can use', () => {
      const keys = visibleNavKeys(cashier);
      expect(keys).toContain('pos');
      expect(keys).not.toContain('settings');
      expect(keys).not.toContain('staff');
    });

    it('shows an owner everything', () => {
      expect(visibleNavKeys(owner)).toContain('sync');
      expect(visibleNavKeys(owner)).toContain('audit');
      expect(visibleNavKeys(owner)).toContain('settings');
    });

    it('returns nothing for an anonymous subject', () => {
      expect(visibleNavKeys(null)).toEqual([]);
    });
  });
});

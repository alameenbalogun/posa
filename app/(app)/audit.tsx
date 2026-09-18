import React from 'react';
import type { AuditLogEntry } from '@/domain/types';
import { useApp } from '@/state/app';
import { Badge, Box, Txt } from '@/ui/primitives';
import { Header, NoticeBar, Page, PermissionDenied, relativeTime } from '@/ui/shell';
import { RecordListPage } from '@/ui/record-page';
import { palette } from '@/ui/theme';

/**
 * Audit log (PRD §26).
 *
 * Entries are written on this device at the moment the action happens, and are
 * append-only in the cloud. That ordering matters: an audit trail that is
 * generated server-side would have gaps exactly when a terminal was offline,
 * which is when you most want to know what happened.
 */

const TONE_BY_ACTION: Record<string, 'danger' | 'warning' | 'accent' | 'violet' | 'info' | 'neutral'> = {
  'auth.failed': 'danger',
  'sale.void': 'danger',
  'return.commit': 'warning',
  'sale.discount_override': 'warning',
  'inventory.adjust': 'warning',
  'product.price_change': 'violet',
  'staff.role_change': 'violet',
  'device.revoke': 'danger',
  'shift.close': 'info',
  'sync.conflict': 'warning',
  'sale.commit': 'accent',
};

export default function AuditScreen() {
  const app = useApp();

  if (!app.can('report.audit')) return <PermissionDenied what="the audit log" />;

  return (
    <RecordListPage<AuditLogEntry>
      title="Audit log"
      subtitle="Every sensitive action, recorded where it happened"
      permission="report.audit"
      noun="audit entries"
      refreshKey={app.syncStatus.pending}
      load={async () => (app.data ? app.data.listAudit(400) : [])}
      keyExtractor={(entry) => entry.id}
      searchText={(entry) => `${entry.action} ${entry.actorName} ${entry.entityType}`}
      notice={{
        title: 'Written locally, immutable in the cloud',
        message:
          'An entry is created on this terminal at the moment of the action and can never be edited afterwards. Offline actions are logged too — which is precisely when a server-side-only trail would have holes.',
      }}
      emptyIcon="shield-search"
      emptyTitle="No audit entries yet"
      emptyMessage="Signing in, completing a sale, applying a discount, adjusting stock and changing prices all write an entry here."
      columns={[
        {
          key: 'action',
          header: 'Action',
          flex: 3,
          render: (entry) => (
            <Box>
              <Box row gap={8}>
                <Badge label={entry.action} toneName={TONE_BY_ACTION[entry.action] ?? 'neutral'} compact />
                {entry.origin === 'cloud' ? <Badge label="cloud" toneName="info" compact /> : null}
              </Box>
              <Txt variant="caption" color={palette.textFaint} numberOfLines={1}>
                {entry.entityType}
                {entry.entityId ? ` · ${entry.entityId.slice(-8)}` : ''}
              </Txt>
            </Box>
          ),
        },
        {
          key: 'actor',
          header: 'Who',
          flex: 2,
          render: (entry) => (
            <Box>
              <Txt variant="bodyStrong" numberOfLines={1}>
                {entry.actorName || app.users.find((user) => user.id === entry.actorId)?.fullName || 'System'}
              </Txt>
              <Txt variant="caption" color={palette.textFaint} numberOfLines={1}>
                device {entry.deviceId.slice(-6)}
              </Txt>
            </Box>
          ),
        },
        {
          key: 'detail',
          header: 'Detail',
          flex: 3,
          render: (entry) => (
            <Txt variant="caption" color={palette.textSecondary} numberOfLines={2}>
              {summarise(entry)}
            </Txt>
          ),
        },
        {
          key: 'when',
          header: 'When',
          width: 120,
          align: 'right',
          render: (entry) => (
            <Txt variant="caption" color={palette.textMuted}>
              {relativeTime(entry.occurredAt)}
            </Txt>
          ),
        },
      ]}
    />
  );
}

/** Turn the metadata blob into one readable line, preferring the useful keys. */
function summarise(entry: AuditLogEntry): string {
  const meta = (entry.metadata ?? {}) as Record<string, unknown>;
  const preferred = ['receiptNumber', 'reason', 'total', 'discountTotal', 'refundTotal', 'delta', 'role', 'field', 'approvedBy'];
  const parts: string[] = [];
  for (const key of preferred) {
    if (meta[key] !== undefined && meta[key] !== null && meta[key] !== '') {
      parts.push(`${key}: ${String(meta[key])}`);
    }
  }
  if (parts.length === 0) {
    const keys = Object.keys(meta).slice(0, 3);
    for (const key of keys) parts.push(`${key}: ${String(meta[key])}`);
  }
  return parts.join(' · ') || '—';
}

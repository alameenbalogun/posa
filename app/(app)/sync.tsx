import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { formatMoney } from '@/domain/money';
import { can } from '@/domain/permissions';
import { CONFLICT_STRATEGY, entityRank } from '@/domain/sync-protocol';
import { useRouter } from 'expo-router';
import { isSupabaseConfigured } from '@/cloud/config';
import { useApp } from '@/state/app';
import { useAsync } from '@/state/hooks';
import { Badge, Box, Button, Card, Divider, EmptyState, KeyValue, TextField, Txt, styles as primitives } from '@/ui/primitives';
import { DataTable, ListRow } from '@/ui/patterns';
import { Header, NoticeBar, Page, PageGrid, PermissionDenied, relativeTime } from '@/ui/shell';
import { palette, radius, spacing, tone } from '@/ui/theme';

/**
 * The Sync Center (PRD §21.3, §23, §34).
 *
 * This screen has one job above all others: make the operator confident that
 * their money is safe. So it leads with a plain statement of where every record
 * is, then shows the queue, then shows anything that needs a human decision.
 *
 * It is deliberately readable by a shop owner, not just an engineer. "3 sales
 * waiting to upload" beats "outbox depth 3".
 */
export default function SyncScreen() {
  const app = useApp();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [cloudEmail, setCloudEmail] = useState(app.business?.email ?? '');
  const [cloudPassword, setCloudPassword] = useState('');
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [cloudBusy, setCloudBusy] = useState(false);

  const status = app.syncStatus;
  const configured = isSupabaseConfigured();
  const linked = status.cloudConfigured;
  const allowed = can(app.subject, 'admin.sync') || can(app.subject, 'sale.create');

  const queue = useAsync(
    async () => {
      if (!app.data) return [];
      return app.data.allPendingEvents(60);
    },
    [app.data, status.pending, status.lastSyncAt],
    [],
  );

  const conflicts = useAsync(
    async () => (app.data ? app.data.listConflicts('open') : []),
    [app.data, status.openConflicts],
    [],
  );

  const localCounts = useAsync(
    async () => {
      if (!app.data) return { sales: 0, ledger: 0, products: 0, barcodes: 0, held: 0, audit: 0 };
      const [sales, ledger, products, barcodes, held, audit] = await Promise.all([
        app.data.countSales(),
        app.data.collectionCount('inventoryLedger'),
        app.data.collectionCount('products'),
        app.data.store.countBarcodes(),
        app.data.collectionCount('heldSales'),
        app.data.collectionCount('auditLogs'),
      ]);
      return { sales, ledger, products, barcodes, held, audit };
    },
    [app.data, status.lastPulled],
    { sales: 0, ledger: 0, products: 0, barcodes: 0, held: 0, audit: 0 },
  );

  if (!allowed) return <PermissionDenied what="the Sync Center" />;

  const runSync = async () => {
    setBusy(true);
    await app.syncNow();
    setBusy(false);
    queue.reload();
    conflicts.reload();
    localCounts.reload();
  };

  const stateTone = !configured
    ? 'neutral'
    : status.state === 'error'
      ? 'danger'
      : status.pending > 0
        ? 'warning'
        : 'accent';

  return (
    <View style={primitives.flex}>
      <Header
        title="Sync Center"
        subtitle="Every sale is on this device first. The cloud is a copy, never the source."
        actions={
          <Button
            label={linked ? 'Sync now' : configured ? 'Link terminal' : 'How to connect'}
            icon={linked ? 'cloud-sync-outline' : configured ? 'link-variant' : 'information-outline'}
            variant={linked ? 'primary' : 'secondary'}
            size="sm"
            loading={busy}
            onPress={() => linked ? void runSync() : setShowConnect(true)}
          />
        }
      />

      <Page>
        {!configured ? (
          <NoticeBar
            toneName="info"
            icon="harddisk"
            title="Local-only mode — nothing is being uploaded"
            message="This is a supported way to run POSA, not a fault. Every record lives on this device, and adding cloud credentials later begins uploading the whole backlog. To connect a project, set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY, then rebuild."
          />
        ) : !linked ? (
          <Card toneName="warning" style={{ borderWidth: 1 }}>
            <Box gap={spacing.md}>
              <Box row gap={spacing.md} style={{ alignItems: 'flex-start' }}>
                <MaterialCommunityIcons name="cloud-upload-outline" size={22} color={palette.warning} />
                <Box style={{ flex: 1 }} gap={spacing.xs}>
                  <Txt variant="bodyStrong" color={palette.warning}>Cloud credentials found, but this terminal is not linked</Txt>
                  <Txt variant="caption" color={palette.textSecondary}>
                    Enter the owner email and password below to link this terminal. All local data will upload automatically and sync with other devices.
                  </Txt>
                </Box>
              </Box>
              {!showConnect ? (
                <Button label="Link this terminal" variant="primary" icon="cloud-sync-outline" size="sm" onPress={() => setShowConnect(true)} />
              ) : (
                <Box gap={spacing.sm}>
                  <TextField label="Owner email" value={cloudEmail} onChangeText={setCloudEmail} keyboardType="email-address" placeholder="owner@shop.com" icon="email-outline" />
                  <TextField label="Owner password" value={cloudPassword} onChangeText={setCloudPassword} secureTextEntry placeholder="At least 8 characters" icon="cloud-lock-outline" />
                  {cloudError ? (
                    <Box row gap={spacing.sm} style={{ backgroundColor: 'rgba(239,68,68,0.1)', borderRadius: 8, padding: spacing.sm, borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)' }}>
                      <MaterialCommunityIcons name="alert-circle-outline" size={16} color={palette.danger} />
                      <Txt variant="caption" color={palette.danger} style={{ flex: 1 }}>{cloudError}</Txt>
                    </Box>
                  ) : null}
                  <Txt variant="caption" color={palette.textFaint}>If this is the first time, a cloud account is created automatically.</Txt>
                  <Box row gap={spacing.sm}>
                    <Button label="Cancel" variant="ghost" size="sm" onPress={() => { setShowConnect(false); setCloudError(null); }} style={{ flex: 1 }} />
                    <Button label={cloudBusy ? 'Connecting…' : 'Connect & sync'} variant="primary" size="sm" icon="cloud-sync-outline" loading={cloudBusy} onPress={async () => {
                      if (!cloudEmail.trim() || cloudPassword.length < 8) { setCloudError('Enter the owner email and a password of at least 8 characters.'); return; }
                      setCloudBusy(true); setCloudError(null);
                      try {
                        await app.connectCloud(cloudEmail.trim(), cloudPassword);
                        setShowConnect(false);
                        queue.reload(); conflicts.reload(); localCounts.reload();
                      } catch (caught) { setCloudError(caught instanceof Error ? caught.message : 'Connection failed.'); } finally { setCloudBusy(false); }
                    }} style={{ flex: 1 }} />
                  </Box>
                </Box>
              )}
            </Box>
          </Card>
        ) : status.state === 'error' ? (
          <NoticeBar
            toneName="danger"
            icon="cloud-alert"
            title="Upload is not getting through"
            message={`${status.lastError ?? 'Unknown error'}. The queue is intact and will retry automatically with backoff. No sale is at risk.`}
            action={<Button label="Retry now" size="sm" variant="subtle" onPress={() => void runSync()} />}
          />
        ) : status.pending > 0 ? (
          <NoticeBar
            toneName="warning"
            icon="cloud-upload-outline"
            title={`${status.pending} change${status.pending === 1 ? '' : 's'} waiting`}
            message={`Oldest is ${relativeTime(status.oldestPendingAt)}. Retries are automatic and idempotent — uploading the same event twice can never create a second sale.`}
          />
        ) : (
          <NoticeBar
            toneName="accent"
            icon="cloud-check-outline"
            title="Everything is synchronised"
            message={`Last successful exchange ${relativeTime(status.lastSyncAt)}. This device holds ${localCounts.value.sales} sale${localCounts.value.sales === 1 ? '' : 's'}.`}
          />
        )}

        <PageGrid minWidth={380}>
          <Card style={styles.grow}>
            <Box gap={spacing.md}>
              <Box row style={styles.titleRow}>
                <Box>
                  <Txt variant="h3">Connection</Txt>
                  <Txt variant="caption" color={palette.textMuted}>
                    {app.cloudLabel.detail}
                  </Txt>
                </Box>
                <Badge
                  label={linked ? (status.online ? 'Online' : 'Offline') : configured ? 'Not linked' : 'Local only'}
                  toneName={linked ? (status.online ? 'accent' : 'warning') : configured ? 'warning' : 'neutral'}
                />
              </Box>
              <Divider />
              <KeyValue label="Credentials found" value={configured ? 'Yes' : 'No'} />
              <KeyValue label="Terminal linked" value={linked ? 'Yes' : 'No'} toneName={!linked && configured ? 'warning' : undefined} />
              {linked ? (
                <>
                  <KeyValue label="Pending uploads" value={String(status.pending)} emphasis={status.pending > 0} mono />
                  <KeyValue label="Stuck (needs attention)" value={String(status.failing)} toneName={status.failing > 0 ? 'danger' : undefined} mono />
                  <KeyValue label="Open conflicts" value={String(status.openConflicts)} toneName={status.openConflicts > 0 ? 'warning' : undefined} mono />
                  <KeyValue label="Last exchange" value={relativeTime(status.lastSyncAt)} />
                  <KeyValue label="Last exchange moved" value={`${status.lastPushed} up · ${status.lastPulled} down`} mono />
                </>
              ) : null}
              <KeyValue label="Storage engine" value={app.storeKind} mono />
            </Box>
          </Card>

          <Card style={styles.grow}>
            <Box gap={spacing.md}>
              <Box row style={styles.titleRow}>
                <Box>
                  <Txt variant="h3">On this device</Txt>
                  <Txt variant="caption" color={palette.textMuted}>
                    Durable, even if the power goes out now
                  </Txt>
                </Box>
                <MaterialCommunityIcons name="database-check-outline" size={18} color={palette.accent} />
              </Box>
              <Divider />
              <KeyValue label="Sales" value={String(localCounts.value.sales)} mono emphasis />
              <KeyValue label="Inventory movements" value={String(localCounts.value.ledger)} mono />
              <KeyValue label="Products" value={String(localCounts.value.products)} mono />
              <KeyValue label="Indexed barcodes" value={String(localCounts.value.barcodes)} mono />
              <KeyValue label="Held sales" value={String(localCounts.value.held)} mono />
              <KeyValue label="Audit entries" value={String(localCounts.value.audit)} mono />
              <Divider />
              <Txt variant="caption" color={palette.textFaint}>
                Barcode lookups resolve from this index, which is why a scan works with the internet unplugged.
              </Txt>
            </Box>
          </Card>
        </PageGrid>

        <Card padded={false}>
          <Box padding={spacing.lg} gap={spacing.xs}>
            <Txt variant="h3">Upload queue</Txt>
            <Txt variant="caption" color={palette.textMuted}>
              Sent oldest first, parents before children. Each event carries a globally unique id generated on this
              device, so a retry is always safe.
            </Txt>
          </Box>
          <DataTable
            dense
            columns={[
              {
                key: 'entity',
                header: 'Record',
                flex: 3,
                render: (event) => (
                  <Box>
                    <Txt variant="bodyStrong">{humanEntity(event.entity)}</Txt>
                    <Txt variant="mono" color={palette.textFaint} numberOfLines={1}>
                      {event.entityId.slice(-10)}
                    </Txt>
                  </Box>
                ),
              },
              {
                key: 'rank',
                header: 'Order',
                width: 70,
                align: 'right',
                render: (event) => (
                  <Txt variant="moneySm" tabular color={palette.textMuted}>
                    {entityRank(event.entity)}
                  </Txt>
                ),
              },
              {
                key: 'attempts',
                header: 'Tries',
                width: 60,
                align: 'right',
                render: (event) => (
                  <Txt variant="moneySm" tabular color={event.attempts > 0 ? palette.warning : palette.textMuted}>
                    {event.attempts}
                  </Txt>
                ),
              },
              {
                key: 'state',
                header: 'State',
                width: 130,
                render: (event) => (
                  <Badge
                    label={event.attempts === 0 ? 'Queued' : event.lastError ? 'Retrying' : 'Queued'}
                    toneName={event.lastError ? 'warning' : 'info'}
                    compact
                  />
                ),
              },
              {
                key: 'when',
                header: 'Created',
                width: 110,
                align: 'right',
                render: (event) => (
                  <Txt variant="caption" color={palette.textMuted}>
                    {relativeTime(event.createdAt)}
                  </Txt>
                ),
              },
            ]}
            rows={queue.value}
            keyExtractor={(event) => event.id}
            empty={
              <EmptyState
                icon="cloud-check-outline"
                title="Nothing waiting"
                message="Every change on this device has been accepted by the cloud."
                compact
              />
            }
          />
        </Card>

        <Card padded={false}>
          <Box padding={spacing.lg} gap={spacing.xs}>
            <Txt variant="h3">Conflicts needing a decision</Txt>
            <Txt variant="caption" color={palette.textMuted}>
              POSA never silently overwrites a record. When two devices disagree, both versions are kept and someone
              chooses — or the record is append-only and there is nothing to choose.
            </Txt>
          </Box>
          {conflicts.value.length === 0 ? (
            <EmptyState
              icon="check-decagram-outline"
              title="No conflicts"
              message="Completed sales, payments and stock movements are append-only, so they cannot conflict — they are facts and they are ordered, not merged."
              compact
            />
          ) : (
            <Box gap={spacing.sm} style={styles.conflictList}>
              {conflicts.value.map((conflict) => {
                const strategy = CONFLICT_STRATEGY[conflict.entity];
                const t = tone(strategy === 'immutable' ? 'danger' : 'warning');
                return (
                  <ListRow
                    key={conflict.id}
                    toneName={strategy === 'immutable' ? 'danger' : 'warning'}
                    title={`${humanEntity(conflict.entity)} ${conflict.entityId.slice(-8)}`}
                    subtitle={`${conflict.note ?? 'Both versions kept'}. Policy: ${strategy.replace(/_/g, ' ')}. Detected ${relativeTime(conflict.detectedAt)}.`}
                    trailing={
                      <Badge
                        label={strategy === 'immutable' ? 'Auto-resolved' : 'Review'}
                        toneName={strategy === 'immutable' ? 'danger' : 'warning'}
                        compact
                      />
                    }
                    onPress={undefined}
                  />
                );
              })}
              <Box row gap={spacing.sm} style={{ padding: spacing.lg }}>
                <Txt variant="caption" color={tone('warning').fg}>
                  Resolving a conflict requires the admin.conflict_resolve permission.
                </Txt>
              </Box>
            </Box>
          )}
        </Card>

        <Card>
          <Box gap={spacing.md}>
            <Txt variant="h3">How POSA protects a sale</Txt>
            <Txt variant="caption" color={palette.textMuted}>
              The exact sequence, so you can reason about it when something goes wrong.
            </Txt>
            {[
              ['1', 'Write locally', 'The sale, its lines, its payments, the stock movements and an outbound event are written in one storage transaction.'],
              ['2', 'Tell the cashier', 'Only after that write succeeds. The receipt number is printed on the device, not the server.'],
              ['3', 'Queue', 'The outbound events wait in a durable queue. If the app is killed, the queue survives.'],
              ['4', 'Push', 'When a connection appears, events are sent oldest first, parents before children.'],
              ['5', 'Accept once', 'The server records each event id. A retry is answered "duplicate" and changes nothing.'],
              ['6', 'Reconcile', 'Cloud changes are pulled back and folded in, but never over a local edit that has not been uploaded.'],
            ].map(([step, title, body]) => (
              <Box key={step} row gap={spacing.md}>
                <View style={styles.stepBadge}>
                  <Txt variant="label" color={palette.accent}>
                    {step}
                  </Txt>
                </View>
                <Box style={primitives.flex}>
                  <Txt variant="bodyStrong">{title}</Txt>
                  <Txt variant="caption" color={palette.textSecondary}>
                    {body}
                  </Txt>
                </Box>
              </Box>
            ))}
            <Divider />
            <Box row gap={spacing.md}>
              <MaterialCommunityIcons name="shield-check-outline" size={18} color={palette.accent} />
              <Txt variant="caption" color={palette.textSecondary} style={primitives.flex}>
                Critical scenario: unplug the network, complete a sale, force-quit the app, reconnect. You should see
                exactly one sale, exactly one stock deduction and exactly one cloud record. That is asserted in the
                test suite as well as designed for.
              </Txt>
            </Box>
          </Box>
        </Card>
      </Page>
    </View>
  );
}

function humanEntity(entity: string): string {
  const map: Record<string, string> = {
    sale: 'Sale',
    sale_line: 'Sale item',
    payment: 'Payment',
    inventory_ledger: 'Stock movement',
    return: 'Return',
    return_line: 'Return item',
    product: 'Product',
    barcode: 'Barcode',
    customer: 'Customer',
    shift: 'Shift',
    cash_movement: 'Cash movement',
    expense: 'Expense',
    audit_log: 'Audit entry',
    held_sale: 'Held sale',
    purchase: 'Purchase',
    supplier: 'Supplier',
    price_override: 'Price override',
    stock_count_session: 'Stock count',
  };
  return map[entity] ?? entity.replace(/_/g, ' ');
}

export { formatMoney };

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 340 },
  titleRow: { justifyContent: 'space-between', alignItems: 'flex-start' },
  conflictList: { paddingBottom: spacing.md },
  stepBadge: {
    width: 26,
    height: 26,
    borderRadius: radius.pill,
    backgroundColor: palette.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

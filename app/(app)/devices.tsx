import React from 'react';
import type { Device } from '@/domain/types';
import { useApp } from '@/state/app';
import { Badge, Box, Dot, Txt } from '@/ui/primitives';
import { RecordListPage } from '@/ui/record-page';
import { relativeTime } from '@/ui/shell';
import { palette } from '@/ui/theme';

/**
 * Devices (PRD §22, §23).
 *
 * A device is a security boundary as much as a terminal: it holds an offline copy
 * of the shop's data, it has credentials that let a cashier sign in without the
 * network, and it can be revoked. Listing the fleet with its last sync is how an
 * owner notices the till in the second shop that has been offline for three days
 * — which is a support conversation worth having before the numbers diverge.
 */
export default function DevicesScreen() {
  const app = useApp();

  return (
    <RecordListPage<Device>
      title="Devices"
      subtitle={`${app.users.length > 0 ? 'Terminals registered' : 'Terminals'} · this device is ${app.device?.name ?? 'unknown'}`}
      permission="admin.device"
      noun="devices"
      refreshKey={app.syncStatus.lastSyncAt}
      load={async () => (app.data ? app.data.listDevices() : [])}
      keyExtractor={(device) => device.id}
      searchText={(device) => `${device.name} ${device.platform} ${device.id}`}
      notice={{
        title: 'Every terminal is an authorised replica',
        message:
          'A device stores the catalogue, the barcode index and its own sales so it can trade without internet. Revoking a device stops it syncing and invalidates its offline sign-in the next time it reaches the cloud — the local copy is not something we pretend to be able to erase remotely.',
      }}
      emptyIcon="tablet-cellphone"
      emptyTitle="No devices registered"
      emptyMessage="Register a terminal so its sales are attributed and its sync status can be monitored."
      columns={[
        {
          key: 'device',
          header: 'Terminal',
          flex: 3,
          render: (device) => (
            <Box>
              <Box row gap={8}>
                <Txt variant="bodyStrong" numberOfLines={1}>
                  {device.name}
                </Txt>
                {device.id === app.device?.id ? <Badge label="this device" toneName="accent" compact /> : null}
              </Box>
              <Txt variant="caption" color={palette.textFaint} numberOfLines={1}>
                {device.platform} · v{device.appVersion} · id …{device.id.slice(-6)}
              </Txt>
            </Box>
          ),
        },
        {
          key: 'sync',
          header: 'Last exchange',
          flex: 2,
          render: (device) => {
            const last = device.id === app.device?.id ? app.syncStatus.lastSyncAt ?? device.lastSyncAt : device.lastSyncAt;
            const stale = last ? Date.now() - new Date(last).getTime() > 6 * 60 * 60 * 1000 : true;
            return (
              <Box row gap={8}>
                <Dot toneName={stale ? 'warning' : 'accent'} size={7} />
                <Box>
                  <Txt variant="caption" color={stale ? palette.warning : palette.textSecondary}>
                    {relativeTime(last)}
                  </Txt>
                  {device.id === app.device?.id && app.syncStatus.pending > 0 ? (
                    <Txt variant="caption" color={palette.textFaint}>
                      {app.syncStatus.pending} event{app.syncStatus.pending === 1 ? '' : 's'} queued
                    </Txt>
                  ) : null}
                </Box>
              </Box>
            );
          },
        },
        {
          key: 'acked',
          header: 'Acknowledged',
          width: 130,
          align: 'right',
          render: (device) => (
            <Txt variant="mono" color={palette.textMuted}>
              seq {device.lastAckedSeq}
            </Txt>
          ),
        },
        {
          key: 'status',
          header: 'Status',
          width: 110,
          render: (device) => (
            <Badge label={device.status} toneName={device.status === 'active' ? 'accent' : 'danger'} compact />
          ),
        },
      ]}
    />
  );
}

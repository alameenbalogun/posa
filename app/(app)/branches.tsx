import React from 'react';
import type { Branch, Device } from '@/domain/types';
import { useApp } from '@/state/app';
import { Badge, Box, Txt } from '@/ui/primitives';
import { RecordListPage } from '@/ui/record-page';
import { palette } from '@/ui/theme';

/**
 * Branches (PRD §7, §23).
 *
 * This screen is as much explanation as list. Multi-branch is where offline-first
 * stops being a nice-to-have: two tills in two shops both sell the same SKU while
 * offline, and both are right. What matters is that stock movements are attributed
 * to a branch, prices can differ per branch, and inter-branch transfers are paired
 * events rather than a number someone typed twice.
 */
export default function BranchesScreen() {
  const app = useApp();

  return (
    <RecordListPage<{ branch: Branch; devices: Device[] }>
      title="Branches"
      subtitle="Where this business sells, and which terminals serve it"
      permission="admin.branch"
      noun="branches"
      refreshKey={app.syncStatus.pending}
      load={async () => {
        if (!app.data) return [];
        const [branches, devices] = await Promise.all([app.data.listBranches(), app.data.listDevices()]);
        return branches.map((branch) => ({
          branch,
          devices: devices.filter((device) => device.branchId === branch.id),
        }));
      }}
      keyExtractor={(row) => row.branch.id}
      searchText={(row) => `${row.branch.name} ${row.branch.code}`}
      notice={{
        title: 'Stock, prices and receipts are branch-scoped',
        message:
          'Inventory is derived per branch, receipts carry the branch code, and prices can be overridden for one branch without touching another. Inter-branch stock moves are recorded as a paired transfer — out of one branch, into the other — so the ledger always balances.',
      }}
      emptyIcon="store-marker-outline"
      emptyTitle="No branches"
      emptyMessage="A branch is where stock lives and where sales are attributed. Most shops need one; chains need one per location."
      columns={[
        {
          key: 'branch',
          header: 'Branch',
          flex: 3,
          render: (row) => (
            <Box>
              <Box row gap={8}>
                <Txt variant="bodyStrong" numberOfLines={1}>
                  {row.branch.name}
                </Txt>
                <Badge label={row.branch.code} toneName="info" compact />
                {row.branch.isWarehouse ? <Badge label="warehouse" toneName="violet" compact /> : null}
              </Box>
              <Txt variant="caption" color={palette.textFaint} numberOfLines={1}>
                {row.branch.address ?? 'no address on file'} · {row.branch.timezone}
              </Txt>
            </Box>
          ),
        },
        {
          key: 'devices',
          header: 'Terminals',
          width: 110,
          align: 'right',
          render: (row) => (
            <Txt variant="moneySm" tabular color={row.devices.length > 0 ? palette.text : palette.textFaint}>
              {row.devices.length}
            </Txt>
          ),
        },
        {
          key: 'current',
          header: 'This terminal',
          width: 130,
          render: (row) =>
            row.branch.id === app.branch?.id ? <Badge label="here" toneName="accent" compact /> : <Txt variant="caption" color={palette.textFaint}>—</Txt>,
        },
        {
          key: 'status',
          header: 'Status',
          width: 100,
          render: (row) => (
            <Badge label={row.branch.status} toneName={row.branch.status === 'active' ? 'accent' : 'neutral'} compact />
          ),
        },
      ]}
    />
  );
}

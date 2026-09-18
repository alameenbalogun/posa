/**
 * A reusable record-list page.
 *
 * POSA has nineteen screens that are fundamentally the same shape: load a
 * collection from local storage, search it, show it in a table, show an empty
 * state that explains what to do next. Writing that nineteen times would mean
 * nineteen opportunities for one of them to forget the offline notice, or the
 * action gating, or the loading state.
 *
 * So the shape lives here once, and each screen supplies its columns and its
 * loader. Screens that need something genuinely different (checkout, dashboard,
 * the sync centre) stay bespoke — this is for the ones that do not.
 */

import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { MaterialCommunityIcons } from '@expo/vector-icons';
import type { PermissionKey } from '@/domain/permissions';
import { can } from '@/domain/permissions';

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];
import { useApp } from '@/state/app';
import { Box, Button, Card, Chip, EmptyState, Loading, SearchField, Txt, styles as primitives } from './primitives';
import { DataTable, type Column } from './patterns';
import { Header, NoticeBar, Page, PermissionDenied } from './shell';
import { palette, spacing } from './theme';

export interface RecordListPageProps<T> {
  title: string;
  subtitle?: string;
  /** Permission required to see the screen at all. */
  permission?: PermissionKey;
  /** Human name used in the access-denied message. */
  noun: string;
  columns: Array<Column<T>>;
  load: () => Promise<T[]>;
  keyExtractor: (row: T) => string;
  /** Fields to match against the search box. */
  searchText?: (row: T) => string;
  onRowPress?: (row: T) => void;
  emptyTitle: string;
  emptyMessage: string;
  emptyIcon?: IconName;
  emptyAction?: () => void;
  emptyActionLabel?: string;
  actions?: React.ReactNode;
  /** Shown above the table. Use for anything the operator must know. */
  notice?: { title: string; message: string };
  /** Refresh when this changes — pass a sync counter or a revision. */
  refreshKey?: unknown;
}

export function RecordListPage<T>({
  title,
  subtitle,
  permission,
  noun,
  columns,
  load,
  keyExtractor,
  searchText,
  onRowPress,
  emptyTitle,
  emptyMessage,
  emptyIcon = 'inbox-outline',
  emptyAction,
  emptyActionLabel,
  actions,
  notice,
  refreshKey,
}: RecordListPageProps<T>) {
  const subject = useApp((state) => state.subject);
  const syncStatus = useApp((state) => state.syncStatus);
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = React.useCallback(() => setNonce((value) => value + 1), []);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const result = await load();
        if (!cancelled) {
          setRows(result);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : 'Could not read local records.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, refreshKey]);

  const filtered = useMemo(() => {
    if (!searchText || !query.trim()) return rows;
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => searchText(row).toLowerCase().includes(needle));
  }, [rows, query, searchText]);

  if (permission && !can(subject, permission)) return <PermissionDenied what={noun} />;

  return (
    <View style={primitives.flex}>
      <Header
        title={title}
        subtitle={subtitle ?? `${rows.length} record${rows.length === 1 ? '' : 's'} on this device`}
        actions={
          <Box row gap={spacing.sm}>
            {actions}
            <Button label="Refresh" size="sm" variant="ghost" icon="refresh" onPress={reload} />
          </Box>
        }
      />

      <Page maxWidth={1400}>
        {notice ? <NoticeBar toneName="info" icon="information-outline" title={notice.title} message={notice.message} /> : null}

        {!syncStatus.cloudConfigured ? (
          <NoticeBar
            toneName="neutral"
            icon="harddisk"
            title="Showing local records"
            message="No cloud project is connected, so this list contains everything this terminal knows. It is complete for the sales made here."
          />
        ) : null}

        {error ? (
          <NoticeBar toneName="danger" icon="alert-circle-outline" title="Could not read records" message={error} />
        ) : null}

        {searchText ? (
          <Box row gap={spacing.md}>
            <SearchField value={query} onChangeText={setQuery} style={primitives.flex} placeholder={`Search ${noun}`} />
            {query ? <Chip label={`${filtered.length} of ${rows.length}`} selected onPress={() => setQuery('')} /> : null}
          </Box>
        ) : null}

        {loading ? (
          <Loading label="Reading local records…" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={emptyIcon}
            title={emptyTitle}
            message={emptyMessage}
            action={emptyAction && emptyActionLabel ? <Button label={emptyActionLabel} variant="primary" onPress={emptyAction} /> : undefined}
          />
        ) : filtered.length === 0 ? (
          <EmptyState icon="magnify" title="Nothing matches that search" message="Try a different word, or clear the search to see everything." compact />
        ) : (
          <Card padded={false}>
            <DataTable columns={columns} rows={filtered} keyExtractor={keyExtractor} onRowPress={onRowPress} />
          </Card>
        )}
      </Page>
    </View>
  );
}

/** A labelled value used in the compact summary rows these pages show. */
export function InlineStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Box style={styles.inlineStat}>
      <Txt variant="overline" color={palette.textFaint}>
        {label.toUpperCase()}
      </Txt>
      <Txt variant="money" color={color ?? palette.text} tabular>
        {value}
      </Txt>
    </Box>
  );
}

const styles = StyleSheet.create({
  inlineStat: { gap: 2, minWidth: 110 },
});

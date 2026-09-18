import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { formatMoney, parseMoney, type Minor } from '@/domain/money';
import { internalBarcode } from '@/domain/barcode';
import { movementKey } from '@/domain/inventory';
import { can } from '@/domain/permissions';
import { createBarcodeIndexEntry, createProduct, parseProductCsv, productsToCsv, type CatalogProduct } from '@/data/catalog';
import { useApp } from '@/state/app';
import { useLocalSnapshot } from '@/state/hooks';
import { Badge, Box, Button, Card, Chip, Divider, EmptyState, IconButton, Money, SearchField, TextField, Txt, styles as primitives } from '@/ui/primitives';
import { BarcodeGlyph, DataTable, MoneyCell, Sheet } from '@/ui/patterns';
import { Header, NoticeBar, Page, PermissionDenied } from '@/ui/shell';
import { palette, radius, spacing } from '@/ui/theme';

/**
 * Products.
 *
 * The barcode handling is the part worth reading. A product edit and a barcode
 * assignment are the same action from a shopkeeper's point of view — "this is
 * what I scan to sell this" — so the form treats the barcode as a product field
 * and keeps the denormalised index in step. Duplicate assignment is refused with
 * the conflicting product named, because the alternative is a till that silently
 * sells the wrong item (PRD §10.3).
 */
export default function ProductsScreen() {
  const app = useApp();
  const snapshot = useLocalSnapshot();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<CatalogProduct | null>(null);
  const [creating, setCreating] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [csv, setCsv] = useState('');
  const [importReport, setImportReport] = useState<string | null>(null);

  const canCreate = can(app.subject, 'product.create');
  const canUpdate = can(app.subject, 'product.update');
  const canManageBarcodes = can(app.subject, 'barcode.manage');

  const branchId = app.branch?.id ?? '';

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return snapshot.products
      .filter((product) => {
        if (!needle) return true;
        return (
          product.name.toLowerCase().includes(needle) ||
          product.sku.toLowerCase().includes(needle) ||
          (product.brand ?? '').toLowerCase().includes(needle)
        );
      })
      .map((product) => ({
        product,
        stock: snapshot.levels.get(movementKey(product.id, null, branchId))?.quantity ?? 0,
        barcode: app.data?.peekBarcode(internalBarcode(product.id))?.barcode ?? null,
      }));
  }, [snapshot.products, snapshot.levels, query, branchId, app.data]);

  if (!can(app.subject, 'product.view')) return <PermissionDenied what="the product catalogue" />;

  const saveProduct = async (draft: CatalogProduct, barcodeValue: string) => {
    if (!app.data || !app.business) return;
    const now = new Date().toISOString();
    const trimmed = barcodeValue.trim();

    if (trimmed && canManageBarcodes) {
      const check = await app.data.checkBarcodeAvailable(trimmed, draft.id, null);
      if (!check.available) {
        app.pushToast({ message: 'Barcode already in use', detail: check.message ?? undefined, toneName: 'danger' });
        return;
      }
    }

    const isNew = !snapshot.products.some((product) => product.id === draft.id);
    const product: CatalogProduct = {
      ...draft,
      name: draft.name.trim(),
      sku: draft.sku.trim().toUpperCase(),
      updatedAt: now,
      updatedBy: app.device?.id ?? '',
      syncState: 'local',
      branchId,
    };

    await app.data.saveProduct(product);

    if (canManageBarcodes) {
      // Keep the denormalised index in step with the product we just wrote. The
      // barcode is what the till actually scans, so a product saved without one
      // would be invisible at the counter.
      const code = trimmed || internalBarcode(product.id);
      const entry = createBarcodeIndexEntry({ ...product, barcodes: [code] }, { branchId });
      await app.data.assignBarcode(entry);
    }

    app.pushToast({
      message: isNew ? 'Product created' : 'Product updated',
      detail: `${product.name} · ${product.sku}`,
      toneName: 'accent',
    });
    snapshot.reload();
    setEditing(null);
    setCreating(false);
  };

  const archive = async (product: CatalogProduct) => {
    if (!app.data) return;
    await app.data.archiveProduct(product.id);
    app.pushToast({ message: 'Product archived', detail: product.name, toneName: 'warning' });
    snapshot.reload();
    setEditing(null);
  };

  const runImport = async () => {
    if (!app.data || !app.business) return;
    const parsed = parseProductCsv(csv, app.business.id);
    const good = parsed.filter((row) => row.ok && row.product);
    const bad = parsed.filter((row) => !row.ok);

    const created: CatalogProduct[] = good.map((row) =>
      createProduct({ ...row.product!, barcodes: row.barcodes }, new Date().toISOString()),
    );
    await app.data.saveProducts(created);
    await app.data.indexCatalogProducts(created.map((product) => ({ ...product, branchId })));
    setImportReport(
      `Imported ${created.length} product${created.length === 1 ? '' : 's'}.` +
        (bad.length > 0 ? ` ${bad.length} row${bad.length === 1 ? '' : 's'} skipped: ${bad.slice(0, 3).map((row) => `line ${row.rowNumber} (${row.errors[0]})`).join('; ')}` : ''),
    );
    snapshot.reload();
  };

  const exportCsv = () => {
    const text = productsToCsv(snapshot.products);
    // On web this is a real download; on native the same string is what the
    // share sheet would receive. Kept simple and dependency-free.
    const blobUrl = `data:text/csv;charset=utf-8,${encodeURIComponent(text)}`;
    if (typeof globalThis !== 'undefined' && 'document' in globalThis) {
      const anchor = (globalThis as unknown as { document: Document }).document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = 'posa-products.csv';
      anchor.click();
    }
    app.pushToast({ message: 'Product list exported', detail: `${snapshot.products.length} rows`, toneName: 'info' });
  };

  return (
    <View style={primitives.flex}>
      <Header
        title="Products"
        subtitle={`${snapshot.products.length} products · ${snapshot.products.filter((p) => p.status === 'active').length} active`}
        actions={
          <Box row gap={spacing.sm}>
            <Button label="Export" size="sm" variant="ghost" icon="download-outline" onPress={exportCsv} />
            {canCreate ? (
              <>
                <Button label="Import CSV" size="sm" variant="secondary" icon="upload-outline" onPress={() => { setImportOpen(true); setImportReport(null); setCsv(''); }} />
                <Button
                  label="New product"
                  size="sm"
                  variant="primary"
                  icon="plus"
                  onPress={() => {
                    if (!app.business) return;
                    setCreating(true);
                    setEditing({
                      ...createProduct({
                        businessId: app.business.id,
                        name: '',
                        sku: '',
                        costPrice: 0 as Minor,
                        sellingPrice: 0 as Minor,
                        taxRateBasisPoints: app.business.settings.taxInclusive ? 750 : 0,
                      }),
                      barcodes: [],
                    });
                  }}
                />
              </>
            ) : null}
          </Box>
        }
      />

      <Page maxWidth={1400}>
        <Box row gap={spacing.md}>
          <SearchField value={query} onChangeText={setQuery} placeholder="Search by name, SKU or brand" style={primitives.flex} />
          <Chip label={`${rows.length} shown`} selected={false} onPress={() => setQuery('')} icon="filter-variant" />
        </Box>

        {snapshot.products.length === 0 ? (
          <EmptyState
            icon="package-variant-plus"
            title="No products yet"
            message="Create your first product, or import a CSV with columns for name, sku, barcode, cost and price."
          />
        ) : (
          <Card padded={false}>
            <DataTable
              columns={[
                {
                  key: 'name',
                  header: 'Product',
                  flex: 4,
                  render: (row) => (
                    <Box>
                      <Box row gap={spacing.sm}>
                        <Txt variant="bodyStrong" numberOfLines={1}>
                          {row.product.name}
                        </Txt>
                        {row.product.status === 'archived' ? <Badge label="Archived" toneName="neutral" compact /> : null}
                      </Box>
                      <Txt variant="caption" color={palette.textFaint} numberOfLines={1}>
                        {row.product.sku}
                        {row.product.brand ? ` · ${row.product.brand}` : ''}
                      </Txt>
                    </Box>
                  ),
                },
                {
                  key: 'barcode',
                  header: 'Barcode',
                  flex: 2,
                  render: (row) =>
                    row.barcode ? (
                      <Box row gap={spacing.sm}>
                        <BarcodeGlyph value={row.barcode} height={16} />
                        <Txt variant="mono" color={palette.textMuted} numberOfLines={1}>
                          {row.barcode}
                        </Txt>
                      </Box>
                    ) : (
                      <Txt variant="caption" color={palette.textFaint}>
                        none
                      </Txt>
                    ),
                },
                {
                  key: 'tax',
                  header: 'VAT',
                  width: 70,
                  align: 'right',
                  render: (row) => (
                    <Txt variant="moneySm" tabular color={palette.textMuted}>
                      {(row.product.taxRateBasisPoints / 100).toFixed(1)}%
                    </Txt>
                  ),
                },
                {
                  key: 'cost',
                  header: 'Cost',
                  width: 100,
                  align: 'right',
                  render: (row) => <MoneyCell value={row.product.costPrice} />,
                },
                {
                  key: 'price',
                  header: 'Price',
                  width: 110,
                  align: 'right',
                  render: (row) => <MoneyCell value={row.product.sellingPrice} toneName="accent" />,
                },
                {
                  key: 'stock',
                  header: 'Stock',
                  width: 80,
                  align: 'right',
                  render: (row) => (
                    <Txt
                      variant="moneySm"
                      tabular
                      color={row.stock <= 0 ? palette.danger : row.product.reorderLevel > 0 && row.stock <= row.product.reorderLevel ? palette.warning : palette.text}
                    >
                      {row.stock}
                    </Txt>
                  ),
                },
                {
                  key: 'actions',
                  header: '',
                  width: 44,
                  render: (row) =>
                    canUpdate ? (
                      <IconButton
                        icon="pencil-outline"
                        label={`Edit ${row.product.name}`}
                        size={30}
                        onPress={() => {
                          setCreating(false);
                          setEditing({ ...row.product, barcodes: row.barcode ? [row.barcode] : [] });
                        }}
                      />
                    ) : null,
                },
              ]}
              rows={rows}
              keyExtractor={(row) => row.product.id}
              empty={<EmptyState icon="magnify" title="Nothing matches that search" compact />}
            />
          </Card>
        )}
      </Page>

      <ProductSheet
        visible={editing !== null}
        isNew={creating}
        draft={editing}
        onClose={() => { setEditing(null); setCreating(false); }}
        onSave={saveProduct}
        onArchive={archive}
        canArchive={can(app.subject, 'product.archive')}
      />

      <Sheet
        visible={importOpen}
        title="Import products from CSV"
        subtitle="Paste a CSV, or the contents of an exported spreadsheet"
        onClose={() => setImportOpen(false)}
        width={640}
        footer={
          <>
            <Button label="Close" variant="ghost" onPress={() => setImportOpen(false)} />
            <Button label="Import" variant="primary" icon="upload" disabled={!csv.trim()} onPress={() => void runImport()} />
          </>
        }
      >
        <Box gap={spacing.md}>
          <TextField
            label="CSV contents"
            value={csv}
            onChangeText={setCsv}
            placeholder={'name,sku,barcode,cost,price,tax\nRice 5kg,RICE-5KG,1234567890128,6200,7500,7.5'}
            multiline
            mono
          />
          <Txt variant="caption" color={palette.textMuted}>
            Recognised headers (case-insensitive, several spellings accepted): name, sku, barcode, cost, price, tax,
            brand, unit, reorder. Rows with problems are skipped individually and reported — one bad line does not
            discard the whole file.
          </Txt>
          {importReport ? (
            <Card toneName="info">
              <Txt variant="body">{importReport}</Txt>
            </Card>
          ) : null}
        </Box>
      </Sheet>
    </View>
  );
}

/* ------------------------------------------------------------------ */

function ProductSheet({
  visible,
  isNew,
  draft,
  onClose,
  onSave,
  onArchive,
  canArchive,
}: {
  visible: boolean;
  isNew: boolean;
  draft: CatalogProduct | null;
  onClose: () => void;
  onSave: (draft: CatalogProduct, barcode: string) => Promise<void>;
  onArchive: (product: CatalogProduct) => Promise<void>;
  canArchive: boolean;
}) {
  const [local, setLocal] = useState<CatalogProduct | null>(draft);
  const [barcode, setBarcode] = useState('');
  const [costText, setCostText] = useState('');
  const [priceText, setPriceText] = useState('');
  const [taxText, setTaxText] = useState('');
  const [error, setError] = useState<string | null>(null);

  React.useEffect(() => {
    if (!visible || !draft) return;
    setLocal(draft);
    setBarcode(draft.barcodes?.[0] ?? '');
    setCostText(formatMoney(draft.costPrice, { bare: true }));
    setPriceText(formatMoney(draft.sellingPrice, { bare: true }));
    setTaxText((draft.taxRateBasisPoints / 100).toFixed(2));
    setError(null);
  }, [visible, draft]);

  if (!local) return null;

  const submit = async () => {
    if (!local.name.trim()) {
      setError('A product needs a name.');
      return;
    }
    const cost = parseMoney(costText) ?? (0 as Minor);
    const price = parseMoney(priceText) ?? (0 as Minor);
    const tax = Math.round((Number(taxText) || 0) * 100);

    if (price <= 0) {
      setError('Set a selling price greater than zero.');
      return;
    }
    if (cost > price) {
      // Not fatal — clearance and loss-leaders exist — but worth confirming.
      setError('Cost is higher than the selling price. Save again if that is deliberate.');
      if (!error) return;
    }

    await onSave({ ...local, costPrice: cost, sellingPrice: price, taxRateBasisPoints: tax }, barcode);
  };

  const margin = (() => {
    const cost = parseMoney(costText) ?? 0;
    const price = parseMoney(priceText) ?? 0;
    if (price <= 0) return null;
    return (price - cost) / price;
  })();

  return (
    <Sheet
      visible={visible}
      title={isNew ? 'New product' : 'Edit product'}
      subtitle={isNew ? 'A barcode is generated automatically if you leave it blank.' : local.sku}
      onClose={onClose}
      width={620}
      footer={
        <>
          {!isNew && canArchive ? (
            <Button label="Archive" variant="danger" icon="archive-outline" onPress={() => void onArchive(local)} />
          ) : null}
          <Button label="Cancel" variant="ghost" onPress={onClose} />
          <Button label={isNew ? 'Create product' : 'Save changes'} variant="primary" icon="content-save-outline" onPress={() => void submit()} />
        </>
      }
    >
      <Box gap={spacing.lg}>
        <TextField label="Product name" value={local.name} onChangeText={(name) => setLocal({ ...local, name })} placeholder="Rice 5kg" autoFocus />
        <Box row gap={spacing.md}>
          <TextField
            label="SKU"
            value={local.sku}
            onChangeText={(sku) => setLocal({ ...local, sku })}
            placeholder="RICE-5KG"
            style={primitives.flex}
            hint={isNew ? 'Leave blank to generate one' : undefined}
          />
          <TextField
            label="Brand"
            value={local.brand ?? ''}
            onChangeText={(brand) => setLocal({ ...local, brand })}
            placeholder="Optional"
            style={primitives.flex}
          />
        </Box>

        <Box row gap={spacing.md}>
          <TextField label="Cost price" value={costText} onChangeText={setCostText} keyboardType="decimal-pad" mono style={primitives.flex} />
          <TextField label="Selling price" value={priceText} onChangeText={setPriceText} keyboardType="decimal-pad" mono style={primitives.flex} />
          <TextField label="VAT %" value={taxText} onChangeText={setTaxText} keyboardType="decimal-pad" mono style={primitives.flex} />
        </Box>

        {margin !== null ? (
          <Box row gap={spacing.sm}>
            <Txt variant="caption" color={margin < 0 ? palette.danger : margin < 0.15 ? palette.warning : palette.accent}>
              Margin {(margin * 100).toFixed(1)}%
            </Txt>
            <Txt variant="caption" color={palette.textFaint}>
              · Profit {formatMoney(((parseMoney(priceText) ?? 0) - (parseMoney(costText) ?? 0)) as Minor)} per unit
            </Txt>
          </Box>
        ) : null}

        <Divider />

        <TextField
          label="Barcode"
          value={barcode}
          onChangeText={setBarcode}
          placeholder="Scan the item, or leave blank for an internal code"
          mono
          icon="barcode-scan"
          hint="Scan into this field with your USB or Bluetooth scanner. Duplicate codes are refused with the conflicting product named."
        />
        {barcode ? <BarcodeGlyph value={barcode} height={26} color={palette.accent} /> : null}

        <Box row gap={spacing.md}>
          <TextField
            label="Reorder level"
            value={String(local.reorderLevel)}
            onChangeText={(value) => setLocal({ ...local, reorderLevel: Number(value.replace(/[^0-9]/g, '')) || 0 })}
            keyboardType="numeric"
            mono
            style={primitives.flex}
            hint="Warn when stock reaches this"
          />
          <Box style={primitives.flex}>
            <Txt variant="label" color={palette.textMuted} style={{ marginBottom: spacing.xs }}>
              Unit of measure
            </Txt>
            <Box row gap={spacing.xs} style={styles.chipRow}>
              {(['unit', 'pack', 'kg', 'litre', 'carton'] as const).map((unit) => (
                <Chip
                  key={unit}
                  label={unit}
                  selected={local.unit === unit}
                  onPress={() => setLocal({ ...local, unit, isWeighted: unit === 'kg' || unit === 'litre' })}
                />
              ))}
            </Box>
          </Box>
        </Box>

        {error ? (
          <Box row gap={spacing.sm}>
            <MaterialCommunityIcons name="alert-circle-outline" size={15} color={palette.warning} />
            <Txt variant="caption" color={palette.warning} style={primitives.flex}>
              {error}
            </Txt>
          </Box>
        ) : null}
      </Box>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  chipRow: { flexWrap: 'wrap' },
});

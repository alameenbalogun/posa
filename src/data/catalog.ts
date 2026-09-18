/**
 * Catalog projections: turning stored products into the shapes the till needs.
 *
 * The barcode index is a deliberate denormalisation (PRD §10.4). Every field the
 * cart needs at scan time — price, tax rate, unit, stock, product name — is
 * copied in, so adding a scanned item never requires a second read. The cost of
 * that choice is that the copy must be refreshed when the truth changes, which
 * is why every mutation funnels through `PosaData` rather than touching the store
 * directly.
 */

import type { BarcodeIndexEntry, Product, UnitOfMeasure, WithSync } from '@/domain/types';
import type { Minor } from '@/domain/money';
import { internalBarcode } from '@/domain/barcode';
import { ulid } from '@/domain/ulid';

/**
 * A product as it lives in the LOCAL store: the catalog entity plus sync
 * provenance plus its assigned barcodes. The `WithSync` half is what lets the
 * reconciler tell a locally-created product from a cloudy one (PRD §36).
 */
export interface CatalogProduct extends WithSync<Product> {
  /** Barcodes assigned to the product itself (no variant). */
  barcodes: string[];
  /** Conventional branch for the index row. */
  branchId?: string;
  /** Pre-resolved price when a branch override applies. */
  effectivePrice?: Minor;
}

export interface BranchPriceLookup {
  /** Returns a branch price override for a product/variant, or null. */
  (productId: string, variantId: string | null, branchId: string): Minor | null;
}

/**
 * Resolve the price that applies right now, at this branch.
 * Precedence: branch override → product base price (PRD §18).
 */
export function resolvePrice(params: {
  product: Product;
  variantId: string | null;
  branchId: string;
  lookup?: BranchPriceLookup;
  variantPrice?: Minor | null;
}): Minor {
  const { product, variantId, branchId, lookup, variantPrice } = params;
  const override = lookup?.(product.id, variantId, branchId) ?? null;
  if (override != null) return override;
  if (variantId && variantPrice != null) return variantPrice;
  return product.sellingPrice;
}

/**
 * Build the index row for a product's primary barcode. When a product has no
 * manufacturer barcode we mint a POSA internal one, because every product in a
 * real shop eventually needs to be scannable (PRD §10.1).
 */
export function createBarcodeIndexEntry(
  product: CatalogProduct,
  options: {
    branchId?: string;
    barcode?: string;
    variantId?: string | null;
    price?: Minor;
    stock?: number;
    lookup?: BranchPriceLookup;
  } = {},
): BarcodeIndexEntry {
  const branchId = options.branchId ?? product.branchId ?? '';
  const barcode = (options.barcode ?? product.barcodes?.[0] ?? internalBarcode(product.id)).toUpperCase();
  const price = options.price ?? product.effectivePrice ?? product.sellingPrice;
  const variantId = options.variantId ?? null;

  return {
    barcode,
    businessId: product.businessId,
    branchId,
    productId: product.id,
    variantId,
    productName: product.name,
    sku: product.sku,
    price,
    costPrice: product.costPrice,
    taxRateBasisPoints: product.taxRateBasisPoints,
    stock: options.stock ?? 0,
    unit: product.unit,
    isWeighted: product.isWeighted,
    symbology: classifySymbology(barcode),
    status: product.status === 'archived' ? 'archived' : 'active',
    updatedAt: product.updatedAt,
  };
}

function classifySymbology(barcode: string): BarcodeIndexEntry['symbology'] {
  const value = barcode.toUpperCase();
  if (value.startsWith('POSA')) return 'INTERNAL';
  if (/^\d{13}$/.test(value)) return 'EAN13';
  if (/^\d{12}$/.test(value)) return 'UPCA';
  if (/^\d{8}$/.test(value)) return 'EAN8';
  if (/^\d{14}$/.test(value)) return 'ITF';
  if (/^[0-9A-Z\-. $/+%]+$/.test(value)) return 'CODE39';
  return 'CODE128';
}

export interface NewProductInput {
  businessId: string;
  name: string;
  sku: string;
  categoryId?: string | null;
  brand?: string | null;
  unit?: UnitOfMeasure;
  isWeighted?: boolean;
  costPrice: Minor;
  sellingPrice: Minor;
  taxRateBasisPoints?: number;
  reorderLevel?: number;
  barcodes?: string[];
}

/** Construct a product with sensible defaults and a generated SKU when omitted. */
export function createProduct(input: NewProductInput, now = new Date().toISOString()): CatalogProduct {
  return {
    id: ulid(),
    // Local-first: a newly created product is unsynced until the cloud acks it.
    revision: 0,
    updatedAt: now,
    updatedBy: '',
    syncState: 'local',
    deletedAt: null,
    businessId: input.businessId,
    name: input.name.trim(),
    description: null,
    categoryId: input.categoryId ?? null,
    brand: input.brand ?? null,
    sku: (input.sku || generateSku(input.name)).toUpperCase().trim(),
    unit: input.unit ?? 'unit',
    isWeighted: input.isWeighted ?? false,
    costPrice: input.costPrice,
    sellingPrice: input.sellingPrice,
    taxRateBasisPoints: input.taxRateBasisPoints ?? 0,
    taxCategoryId: null,
    reorderLevel: input.reorderLevel ?? 0,
    supplierId: null,
    imageUrl: null,
    trackBatches: false,
    trackSerials: false,
    status: 'active',
    createdAt: now,
    barcodes: input.barcodes ?? [],
  };
}

/** A readable, collision-resistant SKU derived from the product name. */
export function generateSku(name: string): string {
  const stem = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 12);
  const suffix = ulid().slice(-4);
  return stem ? `${stem}-${suffix}` : `SKU-${suffix}`;
}

/** Low-stock detection using the product's own reorder level (PRD §14, §24). */
export function isLowStock(product: Product, quantity: number): boolean {
  return product.reorderLevel > 0 && quantity <= product.reorderLevel;
}

export function stockStatus(product: Product, quantity: number): 'out' | 'low' | 'ok' {
  if (quantity <= 0) return 'out';
  if (isLowStock(product, quantity)) return 'low';
  return 'ok';
}

/**
 * CSV import (PRD §7 "Import products from CSV"). Tolerant by design: shops
 * export from Excel, Google Sheets and three different legacy systems, so we
 * accept several header spellings and report per-row problems rather than
 * throwing the whole file away.
 */
export interface CsvImportRow {
  rowNumber: number;
  ok: boolean;
  errors: string[];
  product: NewProductInput | null;
  barcodes: string[];
}

const HEADER_ALIASES: Record<string, string[]> = {
  name: ['name', 'product', 'product name', 'item', 'description'],
  sku: ['sku', 'code', 'item code', 'product code'],
  barcode: ['barcode', 'barcodes', 'ean', 'upc', 'bar code'],
  cost: ['cost', 'cost price', 'buying price', 'purchase price'],
  price: ['price', 'selling price', 'retail price', 'sell price'],
  tax: ['tax', 'tax rate', 'vat', 'vat rate'],
  brand: ['brand', 'manufacturer'],
  unit: ['unit', 'uom', 'unit of measure'],
  reorder: ['reorder', 'reorder level', 'min stock', 'minimum'],
};

function buildHeaderMap(headers: readonly string[]): Record<string, number> {
  const map: Record<string, number> = {};
  headers.forEach((header, index) => {
    const normalised = header.trim().toLowerCase();
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(normalised) && map[field] === undefined) map[field] = index;
    }
  });
  return map;
}

/** Split a CSV line, honouring double-quoted fields. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      out.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  out.push(current);
  return out.map((value) => value.trim());
}

export function parseProductCsv(csv: string, businessId: string): CsvImportRow[] {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];

  const headerMap = buildHeaderMap(splitCsvLine(lines[0]));
  const rows: CsvImportRow[] = [];
  const seenSkus = new Set<string>();

  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    const errors: string[] = [];
    const read = (field: string): string => {
      const index = headerMap[field];
      return index === undefined ? '' : (cells[index] ?? '');
    };

    const name = read('name');
    if (!name) errors.push('Missing product name.');

    const sku = read('sku').toUpperCase();
    if (sku && seenSkus.has(sku)) errors.push(`Duplicate SKU "${sku}" in this file.`);
    if (sku) seenSkus.add(sku);

    const priceText = read('price');
    const price = priceText ? Number(priceText.replace(/[^0-9.]/g, '')) : 0;
    if (priceText && !Number.isFinite(price)) errors.push(`Selling price "${priceText}" is not a number.`);
    if (!priceText) errors.push('Missing selling price.');

    const costText = read('cost');
    const cost = costText ? Number(costText.replace(/[^0-9.]/g, '')) : 0;
    if (costText && !Number.isFinite(cost)) errors.push(`Cost "${costText}" is not a number.`);

    const taxText = read('tax');
    const taxPercent = taxText ? Number(taxText.replace(/[^0-9.]/g, '')) : 0;
    if (taxText && !Number.isFinite(taxPercent)) errors.push(`Tax rate "${taxText}" is not a number.`);

    const reorderText = read('reorder');
    const reorder = reorderText ? Number(reorderText.replace(/[^0-9]/g, '')) : 0;

    const barcodes = read('barcode')
      .split(/[|;,\s]+/)
      .map((value) => value.trim())
      .filter(Boolean);

    rows.push({
      rowNumber: i + 1,
      ok: errors.length === 0,
      errors,
      barcodes,
      product: errors.length > 0
        ? null
        : {
            businessId,
            name,
            sku: sku || generateSku(name),
            brand: read('brand') || null,
            unit: (read('unit') as UnitOfMeasure) || 'unit',
            costPrice: Math.round(cost * 100) as Minor,
            sellingPrice: Math.round(price * 100) as Minor,
            taxRateBasisPoints: Math.round(taxPercent * 100),
            reorderLevel: reorder,
          },
    });
  }
  return rows;
}

/** Serialise products back to CSV for export (PRD §25). */
export function productsToCsv(products: readonly CatalogProduct[]): string {
  const header = 'name,sku,barcode,cost,price,tax,brand,unit,reorder';
  const rows = products.map((product) =>
    [
      product.name,
      product.sku,
      (product.barcodes ?? []).join('|'),
      (product.costPrice / 100).toFixed(2),
      (product.sellingPrice / 100).toFixed(2),
      (product.taxRateBasisPoints / 100).toFixed(2),
      product.brand ?? '',
      product.unit,
      String(product.reorderLevel),
    ]
      .map((value) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value))
      .join(','),
  );
  return [header, ...rows].join('\n');
}

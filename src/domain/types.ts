/**
 * POSA domain entities (PRD §32 Data Model).
 *
 * Two conventions run through every type here:
 *
 * 1. `SyncMeta` on every syncable row. The client is not a cache of the cloud;
 *    it is an operational node holding authoritative local facts (PRD §36).
 *    We therefore need per-row provenance: who wrote it, when, and which
 *    revision it came from.
 *
 * 2. Financial and inventory records are APPEND-ONLY. A `Sale` is never
 *    rewritten after local commit — corrections are new records (a `Return`,
 *    a reversing `InventoryLedger` entry). The only mutable fields on a
 *    committed sale are lifecycle/status flags that the cloud may advance.
 */

import type { Minor } from "./money";

/* ------------------------------------------------------------------ */
/* Sync provenance                                                     */
/* ------------------------------------------------------------------ */

export type SyncState =
  | "local"
  | "pending"
  | "synced"
  | "conflict"
  | "rejected";

export interface SyncMeta {
  /** Server-assigned optimistic-concurrency counter. 0 until first push. */
  revision: number;
  /** ISO-8601 write time on the device that produced this revision. */
  updatedAt: string;
  /** Device that produced the current revision (PRD §23). */
  updatedBy: string;
  /** Terminal-local durability flag; the reconciler owns it (PRD §21.2). */
  syncState: SyncState;
  /** Soft delete — we never hard-delete audit-relevant rows. */
  deletedAt: string | null;
}

export type WithSync<T> = T & SyncMeta;

/* ------------------------------------------------------------------ */
/* Tenancy & identity                                                  */
/* ------------------------------------------------------------------ */

export type Id = string;

export type CurrencyCode = string;

export interface BusinessSettings {
  currency: CurrencyCode;
  /** Prices include tax by default (common in Nigerian retail). */
  taxInclusive: boolean;
  /** Allow selling below zero stock on this business's terminals. */
  allowNegativeStock: boolean;
  /** Require a manager approval event for these permission keys. */
  requireApprovalFor: PermissionKey[];
  /** Hard ceiling on any single discount, in basis points (10000 = 100%). */
  maxDiscountBasisPoints: number;
  /** Minutes before an offline session must re-authenticate (PRD §22). */
  offlineSessionMinutes: number;
}

export interface Business {
  id: Id;
  name: string;
  legalName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  logoUrl: string | null;
  settings: BusinessSettings;
  createdAt: string;
  status: "active" | "suspended";
}

export interface Branch {
  id: Id;
  businessId: Id;
  name: string;
  /** Short code used in receipt numbers, e.g. "LAG". Unique per business. */
  code: string;
  address: string | null;
  phone: string | null;
  /** Local timezone for shift/day-boundary maths. */
  timezone: string;
  isWarehouse: boolean;
  status: "active" | "inactive";
  createdAt: string;
}

export type RoleKey =
  | "owner"
  | "manager"
  | "cashier"
  | "inventory"
  | "accountant"
  | "admin";

export interface User {
  id: Id;
  businessId: Id;
  fullName: string;
  email: string | null;
  phone: string | null;
  /** Never a plaintext password (PRD §47). Set only after cloud sync. */
  credentialHash: string | null;
  /** Salted local verifier for offline sign-in (PRD §22). */
  offlineVerifier: string | null;
  pinHash: string | null;
  role: RoleKey;
  branchIds: Id[];
  /** Per-person task overrides layered on top of the role bundle. */
  granted?: PermissionKey[];
  revoked?: PermissionKey[];
  status: "active" | "suspended" | "invited";
  /** Bumped when the cloud changes permissions; forces offline re-auth. */
  authorizationVersion: number;
  lastLoginAt: string | null;
  createdAt: string;
}

export type DevicePlatform =
  | "web"
  | "ios"
  | "android"
  | "windows"
  | "macos"
  | "linux";

export interface Device {
  id: Id;
  businessId: Id;
  branchId: Id;
  name: string;
  platform: DevicePlatform;
  /** Stable hardware-ish fingerprint used for support and revocation. */
  fingerprint: string;
  appVersion: string;
  status: "active" | "revoked";
  lastSyncAt: string | null;
  /** Highest outbound event the server has acknowledged. */
  lastAckedSeq: number;
  registeredAt: string;
}

/* ------------------------------------------------------------------ */
/* Catalog                                                             */
/* ------------------------------------------------------------------ */

export interface Category {
  id: Id;
  businessId: Id;
  name: string;
  parentId: Id | null;
  colorToken: string | null;
  sortOrder: number;
}

export type BarcodeSymbology =
  | "EAN13"
  | "EAN8"
  | "UPCA"
  | "UPCE"
  | "CODE128"
  | "CODE39"
  | "ITF"
  | "QR"
  | "INTERNAL"
  | "UNKNOWN";

export type UnitOfMeasure =
  | "unit"
  | "piece"
  | "kg"
  | "g"
  | "litre"
  | "ml"
  | "metre"
  | "pack"
  | "box"
  | "carton";

export interface Product {
  id: Id;
  businessId: Id;
  name: string;
  description: string | null;
  categoryId: Id | null;
  brand: string | null;
  /** Internal SKU, unique per business. */
  sku: string;
  unit: UnitOfMeasure;
  /** Weighted items are priced per unit of measure rather than per pack. */
  isWeighted: boolean;
  costPrice: Minor;
  sellingPrice: Minor;
  taxRateBasisPoints: number;
  taxCategoryId: Id | null;
  reorderLevel: number;
  supplierId: Id | null;
  imageUrl: string | null;
  /** Optional vertical features (PRD §9). */
  trackBatches: boolean;
  trackSerials: boolean;
  status: "active" | "archived";
  createdAt: string;
}

export interface Variant {
  id: Id;
  businessId: Id;
  productId: Id;
  name: string;
  sku: string;
  attributes: Record<string, string>;
  costPrice: Minor;
  sellingPrice: Minor;
  status: "active" | "archived";
}

/**
 * The offline barcode index (PRD §10.4). Denormalised on purpose: a scan must
 * resolve in well under 100ms without a join, so the row carries everything the
 * cart needs — price, stock, branch, and the product/variant targets.
 */
export interface BarcodeIndexEntry {
  /** The scanned identifier itself is the primary key of this store. */
  barcode: string;
  businessId: Id;
  branchId: Id;
  productId: Id;
  variantId: Id | null;
  /** Denormalised for instant cart rendering. */
  productName: string;
  sku: string;
  price: Minor;
  costPrice: Minor;
  taxRateBasisPoints: number;
  /** Locally known stock. Advisory only — the ledger is the truth (PRD §47). */
  stock: number;
  unit: UnitOfMeasure;
  isWeighted: boolean;
  symbology: BarcodeSymbology;
  /** 'blocked' entries resolve but refuse to sell (recalled goods). */
  status: "active" | "archived" | "blocked";
  updatedAt: string;
}

/** Branch-specific price override (PRD §18). */
export interface PriceOverride {
  id: Id;
  businessId: Id;
  branchId: Id;
  productId: Id;
  variantId: Id | null;
  price: Minor;
  /** When set, supersedes the base price only inside this window. */
  startsAt: string | null;
  endsAt: string | null;
  reason: string | null;
}

export interface PriceHistoryEntry {
  id: Id;
  businessId: Id;
  productId: Id;
  variantId: Id | null;
  branchId: Id | null;
  previousPrice: Minor;
  newPrice: Minor;
  /** Permission keys authorising the change, for the audit trail. */
  changedBy: Id;
  reason: string | null;
  at: string;
}

/* ------------------------------------------------------------------ */
/* Inventory                                                           */
/* ------------------------------------------------------------------ */

export type StockMovementReason =
  | "opening_balance"
  | "sale"
  | "sale_void"
  | "return"
  | "purchase_receipt"
  | "adjustment"
  | "count_correction"
  | "transfer_out"
  | "transfer_in"
  | "damage"
  | "theft"
  | "expiry";

/**
 * The inventory ledger (PRD §14). Stock is *derived* by folding this ordered
 * log — never by mutating a `quantity` column. That is what makes stock
 * auditable and restart-safe.
 */
export interface InventoryLedgerEntry {
  id: Id;
  businessId: Id;
  branchId: Id;
  productId: Id;
  variantId: Id | null;
  /** Signed: negative for outflows. */
  quantityDelta: number;
  reason: StockMovementReason;
  /** Sale/return/purchase that caused this movement, when applicable. */
  sourceType:
    | "sale"
    | "return"
    | "purchase"
    | "adjustment"
    | "count"
    | "transfer"
    | "manual"
    | null;
  sourceId: Id | null;
  /** Unit cost captured at movement time, for COGS and valuation. */
  unitCost: Minor | null;
  note: string | null;
  actorId: Id | null;
  deviceId: Id;
  occurredAt: string;
  /** Location metadata (PRD §14: aisle/shelf/rack/bin). */
  location: StockLocation | null;
}

export interface StockLocation {
  warehouse: string | null;
  aisle: string | null;
  shelf: string | null;
  rack: string | null;
  bin: string | null;
}

/** Derived, never persisted as the source of truth. */
export interface StockLevel {
  productId: Id;
  variantId: Id | null;
  branchId: Id;
  quantity: number;
  /** Quantity moved in the last N days, for velocity/low-stock heuristics. */
  lastMovementAt: string | null;
}

export interface StockCountSession {
  id: Id;
  businessId: Id;
  branchId: Id;
  name: string;
  status: "open" | "counting" | "review" | "posted" | "abandoned";
  startedBy: Id;
  startedAt: string;
  closedAt: string | null;
  /** Freeze the ledger snapshot so counts stay comparable while counting. */
  snapshotAt: string | null;
}

export interface StockCountLine {
  id: Id;
  sessionId: Id;
  productId: Id;
  variantId: Id | null;
  /** Snapshot of expected quantity when counting began. */
  expectedQuantity: number;
  countedQuantity: number;
  /** counted - expected, computed on post so the audit report is explicit. */
  varianceReason: string | null;
  countedBy: Id | null;
  countedAt: string | null;
}

export interface StockTransfer {
  id: Id;
  businessId: Id;
  fromBranchId: Id;
  toBranchId: Id;
  reference: string;
  status: "draft" | "in_transit" | "received" | "cancelled";
  lines: StockTransferLine[];
  createdBy: Id;
  createdAt: string;
  receivedAt: string | null;
}

export interface StockTransferLine {
  productId: Id;
  variantId: Id | null;
  quantity: number;
  receivedQuantity: number;
}

/* ------------------------------------------------------------------ */
/* Sales                                                               */
/* ------------------------------------------------------------------ */

export type SaleChannel = "pos" | "manual" | "import";

export type SaleStatus =
  | "draft"
  | "held"
  | "awaiting_payment"
  | "committed"
  | "voided"
  | "partially_returned"
  | "returned";

export interface SaleLine {
  id: Id;
  saleId: Id;
  productId: Id;
  variantId: Id | null;
  /** Snapshot fields: a product rename must not rewrite history. */
  name: string;
  sku: string;
  barcode: string | null;
  quantity: number;
  unitPrice: Minor;
  /** Line-level discount already applied. */
  lineDiscount: Minor;
  /** Share of the cart-level discount allocated to this line. */
  allocatedDiscount: Minor;
  taxRateBasisPoints: number;
  /** Taxable base after all discounts. */
  taxableBase: Minor;
  taxAmount: Minor;
  lineTotal: Minor;
  unitCost: Minor;
  /** Allocated proportion of this line as a fraction, for exact return maths. */
  returnableQuantity: number;
  returnedQuantity: number;
}

export interface Payment {
  id: Id;
  saleId: Id;
  method: PaymentMethod;
  amount: Minor;
  /** Provider/bank reference or terminal RRN (PRD §12). */
  reference: string | null;
  status: PaymentStatus;
  /** Set when the method needed a network round-trip (card/digital). */
  requiresAuthorization: boolean;
  /** Provider that authorised it, when applicable. */
  provider: string | null;
  tenderedAmount: Minor | null;
  changeGiven: Minor | null;
  capturedAt: string | null;
  failureReason: string | null;
  deviceId: Id;
}

export type PaymentMethod =
  | "cash"
  | "card"
  | "transfer"
  | "digital_wallet"
  | "credit"
  | "other";

export type PaymentStatus =
  | "pending"
  | "successful"
  /** Some of the balance was settled; the rest sits on the customer account. */
  | "partially_paid"
  | "failed"
  | "cancelled"
  | "refunded"
  | "partially_refunded";

export interface Sale {
  id: Id;
  /** Human-readable, unique without coordination: {BRANCH}-{DEVICE}-{SEQ}. */
  receiptNumber: string;
  businessId: Id;
  branchId: Id;
  deviceId: Id;
  cashierId: Id;
  customerId: Id | null;
  shiftId: Id | null;
  channel: SaleChannel;
  status: SaleStatus;
  currency: CurrencyCode;
  /** Total of line gross before any discount. */
  subtotal: Minor;
  lineDiscountTotal: Minor;
  cartDiscountTotal: Minor;
  discountTotal: Minor;
  taxTotal: Minor;
  roundingAdjustment: Minor;
  total: Minor;
  /** Amount actually collected across successful payments. */
  amountPaid: Minor;
  changeDue: Minor;
  itemCount: number;
  /** Cashier's note, void/return reason, etc. */
  note: string | null;
  /** Manager who approved a sensitive action on this sale, if any. */
  approvedBy: Id | null;
  /** Idempotency key for the sync push (PRD §33). */
  idempotencyKey: string;
  /** Client clock at commit — the server keeps its own receipt time too. */
  committedAt: string;
  voidedAt: string | null;
  voidReason: string | null;
}

/** Held / suspended sale (PRD §11). Stored separately so the POS list stays fast. */
export interface HeldSale {
  id: Id;
  businessId: Id;
  branchId: Id;
  deviceId: Id;
  label: string;
  customerId: Id | null;
  lines: SaleLine[];
  note: string | null;
  heldBy: Id;
  heldAt: string;
  /** Bumped every time the cart changes, so the cloud can order held carts. */
  revisionToken: number;
}

/* ------------------------------------------------------------------ */
/* Returns                                                             */
/* ------------------------------------------------------------------ */

export type ReturnReason =
  | "customer_changed_mind"
  | "damaged"
  | "expired"
  | "wrong_item"
  | "faulty"
  | "overcharge"
  | "other";

export interface ReturnRecord {
  id: Id;
  businessId: Id;
  branchId: Id;
  deviceId: Id;
  saleId: Id;
  receiptNumber: string;
  cashierId: Id;
  approvedBy: Id | null;
  reason: ReturnReason;
  reasonNote: string | null;
  /** Refund computed from the original sale's snapshots, never re-priced. */
  refundSubtotal: Minor;
  refundTax: Minor;
  refundTotal: Minor;
  refundMethod: PaymentMethod;
  /** True when goods go back on the shelf. */
  restock: boolean;
  lines: ReturnLine[];
  status: "committed" | "voided";
  idempotencyKey: string;
  committedAt: string;
}

export interface ReturnLine {
  id: Id;
  returnId: Id;
  saleLineId: Id;
  productId: Id;
  variantId: Id | null;
  quantity: number;
  /** Refund per unit, derived from the original line's effective price. */
  unitRefund: Minor;
  lineRefund: Minor;
  taxRefund: Minor;
}

/* ------------------------------------------------------------------ */
/* Customers, suppliers, purchasing                                    */
/* ------------------------------------------------------------------ */

export interface Customer {
  id: Id;
  businessId: Id;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  /** Negative = customer owes the business (credit sales). */
  balance: Minor;
  creditLimit: Minor;
  loyaltyPoints: number;
  notes: string | null;
  status: "active" | "archived";
  createdAt: string;
}

export interface Supplier {
  id: Id;
  businessId: Id;
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  balance: Minor;
  status: "active" | "archived";
  createdAt: string;
}

export interface Purchase {
  id: Id;
  businessId: Id;
  branchId: Id;
  supplierId: Id;
  reference: string;
  status: "draft" | "ordered" | "partially_received" | "received" | "cancelled";
  lines: PurchaseLine[];
  subtotal: Minor;
  taxTotal: Minor;
  total: Minor;
  amountPaid: Minor;
  expectedAt: string | null;
  receivedAt: string | null;
  createdBy: Id;
  createdAt: string;
  note: string | null;
}

export interface PurchaseLine {
  id: Id;
  purchaseId: Id;
  productId: Id;
  variantId: Id | null;
  name: string;
  quantity: number;
  receivedQuantity: number;
  unitCost: Minor;
  lineTotal: Minor;
}

/* ------------------------------------------------------------------ */
/* Cash, expenses, shifts                                              */
/* ------------------------------------------------------------------ */

export interface Shift {
  id: Id;
  businessId: Id;
  branchId: Id;
  deviceId: Id;
  cashierId: Id;
  openingFloat: Minor;
  countedClose: Minor | null;
  expectedClose: Minor | null;
  variance: Minor | null;
  cashIn: Minor;
  cashOut: Minor;
  status: "open" | "closed" | "reconciled";
  openedAt: string;
  closedAt: string | null;
  closedBy: Id | null;
  note: string | null;
}

export type CashMovementType =
  | "cash_in"
  | "cash_out"
  | "float_adjustment"
  | "bank_deposit"
  | "safe_drop";

export interface CashMovement {
  id: Id;
  businessId: Id;
  branchId: Id;
  shiftId: Id | null;
  deviceId: Id;
  type: CashMovementType;
  amount: Minor;
  reason: string;
  actorId: Id;
  approvedBy: Id | null;
  occurredAt: string;
}

export interface Expense {
  id: Id;
  businessId: Id;
  branchId: Id;
  categoryId: Id | null;
  categoryName: string;
  amount: Minor;
  source: PaymentMethod;
  /** When pulled from a shift's drawer, links the cash movement. */
  shiftId: Id | null;
  reference: string | null;
  description: string | null;
  spentBy: Id;
  approvedBy: Id | null;
  spentAt: string;
}

export interface ExpenseCategory {
  id: Id;
  businessId: Id;
  name: string;
  requiresApproval: boolean;
}

/* ------------------------------------------------------------------ */
/* Audit & sync                                                        */
/* ------------------------------------------------------------------ */

export type AuditAction =
  | "auth.sign_in"
  | "auth.sign_out"
  | "auth.offline_sign_in"
  | "auth.failed"
  | "product.create"
  | "product.update"
  | "product.archive"
  | "product.price_change"
  | "barcode.assign"
  | "barcode.remove"
  | "inventory.adjust"
  | "inventory.count_post"
  | "inventory.receive"
  | "inventory.transfer"
  | "sale.commit"
  | "sale.void"
  | "sale.discount_override"
  | "sale.hold"
  | "return.commit"
  | "shift.open"
  | "shift.close"
  | "shift.variance"
  | "cash.movement"
  | "expense.create"
  | "staff.create"
  | "staff.role_change"
  | "device.register"
  | "device.revoke"
  | "sync.conflict"
  | "sync.conflict_resolved"
  | "settings.update";

export interface AuditLogEntry {
  id: Id;
  businessId: Id;
  branchId: Id | null;
  deviceId: Id;
  actorId: Id | null;
  actorName: string;
  action: AuditAction;
  entityType: string;
  entityId: Id | null;
  /** Diff / context. Never contains secrets (PRD §31). */
  metadata: Record<string, unknown>;
  /** Where the entry was produced, so a tampered client is detectable. */
  origin: "local" | "cloud";
  occurredAt: string;
}

/* ------------------------------------------------------------------ */
/* Permissions (declared here so entities can reference them)           */
/* ------------------------------------------------------------------ */

export type PermissionKey =
  | "sale.create"
  | "sale.hold"
  | "sale.resume_other"
  | "sale.void"
  | "sale.discount"
  | "sale.discount.unlimited"
  | "sale.price_override"
  | "return.create"
  | "return.approve"
  | "inventory.view"
  | "inventory.adjust"
  | "inventory.receive"
  | "inventory.transfer"
  | "inventory.count"
  | "product.view"
  | "product.create"
  | "product.update"
  | "product.archive"
  | "product.price_change"
  | "barcode.manage"
  | "customer.view"
  | "customer.manage"
  | "supplier.manage"
  | "purchase.create"
  | "purchase.receive"
  | "finance.expense"
  | "finance.expense.approve"
  | "finance.cash_movement"
  | "shift.open"
  | "shift.close"
  | "shift.close_other"
  | "report.sales"
  | "report.inventory"
  | "report.finance"
  | "report.staff"
  | "report.audit"
  | "admin.branch"
  | "admin.staff"
  | "admin.device"
  | "admin.settings"
  | "admin.sync"
  | "admin.conflict_resolve"
  | "admin.integration";

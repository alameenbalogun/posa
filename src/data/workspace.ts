import type { Branch, Business, Device, User } from "@/domain/types";

export interface WorkspaceInput {
  businessName: string;
  legalName: string;
  businessPhone: string;
  businessEmail: string;
  businessAddress: string;
  branchName: string;
  branchCode: string;
  branchPhone: string;
  branchAddress: string;
  branchTimezone: string;
  deviceName: string;
  ownerName: string;
  ownerEmail: string;
  ownerPhone: string;
  ownerPinHash: string;
  currency: string;
  taxInclusive: boolean;
  allowNegativeStock: boolean;
  offlineSessionMinutes: number;
  deviceId: string;
  devicePlatform: Device["platform"];
  now?: string;
}

export interface Workspace {
  business: Business;
  branch: Branch;
  device: Device;
  owner: User;
}

/** Creates only operator-provided workspace records; no demo catalog or staff. */
export function createWorkspace(input: WorkspaceInput): Workspace {
  const now = input.now ?? new Date().toISOString();
  const businessId = input.deviceId;
  const branchId = `${input.deviceId}-branch`;

  const business: Business = {
    id: businessId,
    name: input.businessName.trim(),
    legalName: input.legalName.trim() || null,
    phone: input.businessPhone.trim() || null,
    email: input.businessEmail.trim() || null,
    address: input.businessAddress.trim() || null,
    logoUrl: null,
    settings: {
      currency: input.currency,
      taxInclusive: input.taxInclusive,
      allowNegativeStock: input.allowNegativeStock,
      requireApprovalFor: ["sale.void", "return.approve"],
      maxDiscountBasisPoints: 1000,
      offlineSessionMinutes: input.offlineSessionMinutes,
    },
    createdAt: now,
    status: "active",
  };

  const branch: Branch = {
    id: branchId,
    businessId,
    name: input.branchName.trim(),
    code: input.branchCode.trim().toUpperCase().slice(0, 5),
    address: input.branchAddress.trim() || input.businessAddress.trim() || null,
    phone: input.branchPhone.trim() || input.businessPhone.trim() || null,
    timezone: input.branchTimezone,
    isWarehouse: false,
    status: "active",
    createdAt: now,
  };

  const device: Device = {
    id: input.deviceId,
    businessId,
    branchId,
    name: input.deviceName.trim(),
    platform: input.devicePlatform,
    fingerprint: input.deviceId.slice(-12),
    appVersion: "1.0.0",
    status: "active",
    lastSyncAt: null,
    lastAckedSeq: 0,
    registeredAt: now,
  };

  const owner: User = {
    id: `${input.deviceId}-owner`,
    businessId,
    fullName: input.ownerName.trim(),
    email: input.ownerEmail.trim() || null,
    phone: input.ownerPhone.trim() || null,
    credentialHash: null,
    offlineVerifier: null,
    pinHash: input.ownerPinHash,
    role: "owner",
    branchIds: [branchId],
    status: "active",
    authorizationVersion: 1,
    lastLoginAt: null,
    createdAt: now,
  };

  return { business, branch, device, owner };
}

/**
 * Application state.
 *
 * This is the seam between the durable local database and the UI. It owns:
 *   - BOOT. Open storage, restore the configured workspace, restore the session.
 *   - SESSION. Offline sign-in against stored PIN hashes, with the permission
 *     subject derived from the last synchronised authorization state (PRD §22).
 *   - SYNC STATUS. Mirrored from the engine for the header indicator.
 *   - TOASTS and SCAN FEEDBACK. Transient UI state that many screens raise.
 *
 * Everything here is deliberately synchronous to read: a till cannot afford a
 * loading spinner between pressing "Add" and seeing the line appear.
 */

import { create } from "zustand";
import { Platform } from "react-native";
import { ulid } from "@/domain/ulid";
import type { Branch, Business, Device, Shift, User } from "@/domain/types";
import {
  effectivePermissions,
  type PermissionKey,
  type PermissionSubject,
} from "@/domain/permissions";
import { META_KEYS } from "@/data/local";
import { createLocalStore, type LocalStore } from "@/data/local";
import { getData, PosaData } from "@/data/repositories";
import { createWorkspace } from "@/data/workspace";
import {
  createSalt,
  hashPin,
  isSessionExpired,
  verifyPin,
} from "@/services/credentials";
import { SyncEngine, type SyncStatus } from "@/sync/engine";
import { connectivity } from "@/sync/connectivity";
import { createTransport } from "@/cloud/transport";
import { ensureCloudWorkspace, joinCloudWorkspace } from "@/cloud/identity";
import { outboxEvent } from "@/data/mutations";
import { cloudStatusLabel, isSupabaseConfigured } from "@/cloud/config";
import type { Toast } from "@/ui/patterns";
import type { ScanFeedback } from "@/ui/patterns";

export type AppPhase = "booting" | "onboarding" | "signin" | "ready" | "failed";

/** Any persisted entity satisfies this; the store only needs an `id`. */
type Row = Record<string, unknown> & { id: string };

export interface Session {
  userId: string;
  fullName: string;
  role: User["role"];
  signedInAt: string;
  /** True when signed in from stored credentials with no cloud round trip. */
  offline: boolean;
}

export interface OnboardingInput {
  businessName: string;
  legalName: string;
  businessPhone: string;
  businessEmail: string;
  businessAddress: string;
  branchName: string;
  branchCode: string;
  branchPhone: string;
  branchAddress: string;
  deviceName: string;
  ownerName: string;
  ownerEmail: string;
  ownerPhone: string;
  ownerPin: string;
  cloudPassword: string;
  offlineSessionMinutes: number;
  allowNegativeStock: boolean;
  currency: string;
  taxInclusive: boolean;
}

interface AppState {
  phase: AppPhase;
  bootError: string | null;
  business: Business | null;
  branch: Branch | null;
  device: Device | null;
  session: Session | null;
  /** Resolved permission subject. Null until signed in. */
  subject: PermissionSubject | null;
  openShift: Shift | null;
  users: User[];
  storeKind: string;

  syncStatus: SyncStatus;
  cloudLabel: { configured: boolean; label: string; detail: string };

  toasts: Toast[];
  scanFeedback: ScanFeedback;

  data: PosaData | null;
  engine: SyncEngine | null;

  bootstrap: () => Promise<void>;
  completeOnboarding: (input: OnboardingInput) => Promise<void>;
  joinCloudWorkspace: (email: string, password: string) => Promise<void>;
  connectCloud: (email: string, password: string) => Promise<void>;
  signInWithPin: (
    userId: string,
    pin: string,
  ) => Promise<{ ok: boolean; error: string | null }>;
  signOut: () => Promise<void>;
  can: (permission: PermissionKey) => boolean;
  syncNow: () => Promise<void>;
  pushToast: (toast: Omit<Toast, "id"> & { id?: string }) => void;
  dismissToast: (id: string) => void;
  setScanFeedback: (feedback: ScanFeedback) => void;
  refreshShift: () => Promise<void>;
  resetTerminal: () => Promise<void>;
}

const INITIAL_SYNC: SyncStatus = {
  state: "unconfigured",
  cloudConfigured: false,
  lastSyncAt: null,
  lastError: null,
  pending: 0,
  failing: 0,
  openConflicts: 0,
  oldestPendingAt: null,
  cursor: null,
  lastPushed: 0,
  lastPulled: 0,
  online: true,
};

const IDLE_SCAN: ScanFeedback = {
  phase: "idle",
  message: "Ready — scan an item to begin",
  code: null,
  at: 0,
};

let toastCounter = 0;

export const useApp = create<AppState>()((set, get) => ({
  phase: "booting",
  bootError: null,
  business: null,
  branch: null,
  device: null,
  session: null,
  subject: null,
  openShift: null,
  users: [],
  storeKind: "unknown",
  syncStatus: INITIAL_SYNC,
  cloudLabel: cloudStatusLabel(),
  toasts: [],
  scanFeedback: IDLE_SCAN,
  data: null,
  engine: null,

  /* ---------------------------------------------------------------- */
  /* Boot                                                             */
  /* ---------------------------------------------------------------- */

  async bootstrap() {
    try {
      const store: LocalStore = await createLocalStore();
      const data = getData(store);
      await data.init();

      // Older builds could leave a placeholder installation behind. Remove it
      // rather than exposing sample products or staff as a real workspace.
      if ((await store.getMeta<boolean>(META_KEYS.demo)) === true) {
        await store.wipe();
        await data.init();
        set({ phase: "onboarding", storeKind: store.kind, data, users: [] });
        return;
      }

      const business = await data.getBusiness();
      if (!business) {
        // No local business record: this is a fresh terminal. Send the shop
        // through onboarding instead of inventing data for them — a demo store
        // that a real business has to delete is worse than an empty one.
        // Keep the initialized facade in state: onboarding uses it to commit
        // the first business. Without this, completion silently had no store
        // to write to and the UI could only report that storage was opening.
        set({ phase: "onboarding", storeKind: store.kind, data });
        return;
      }

      const [branch, device, users] = await Promise.all([
        data.listBranches().then((list) => list[0] ?? null),
        data.getDevice(),
        data.listUsers(),
      ]);

      if (!branch || !device)
        throw new Error("Local store is missing its branch or device record.");

      const cloud = cloudStatusLabel();
      const engine = await createEngine(data, device);

      set({
        phase: "signin",
        business,
        branch,
        device,
        users,
        data,
        engine,
        storeKind: store.kind,
        cloudLabel: cloud,
        syncStatus: engine?.current ?? {
          ...INITIAL_SYNC,
          cloudConfigured: false,
          state: "unconfigured",
        },
      });

      // Restore a still-valid session so a terminal that reboots mid-shift does
      // not force everyone to re-key their PIN.
      const previous = await store.getMeta<Session>(META_KEYS.session);
      if (
        previous &&
        business &&
        !isSessionExpired(previous.signedInAt, business.settings)
      ) {
        await applySession(set, get, previous);
      }

      if (engine) {
        engine.start();
        // Online-first: pull all data from cloud before showing the app.
        // This ensures the terminal has the latest products, prices, stock
        // levels and business data before the cashier starts selling.
        if (
          isSupabaseConfigured() &&
          engine.current.cloudConfigured &&
          connectivity.current.state !== "offline"
        ) {
          try {
            await engine.pullAll();
            set({ users: await data.listUsers() });
            // Push any local changes that predate this boot
            void engine.drainOutbox();
          } catch {
            // Non-fatal: if cloud is unreachable, we continue with local data.
          }
        }
        void engine.tick();
      }
    } catch (error) {
      set({
        phase: "failed",
        bootError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  async completeOnboarding(input) {
    let { data } = get();
    if (!data) {
      // The public landing page can open onboarding before the boot gate has
      // finished. Reuse the platform store instead of making the user retry.
      const store = await createLocalStore();
      await store.init();
      data = getData(store);
      await data.init();
      set({ data, storeKind: store.kind });
    }

    const deviceId = ulid();
    const salt = createSalt();
    const ownerHash = await hashPin(input.ownerPin, salt);

    const workspace = createWorkspace({
      businessName: input.businessName,
      legalName: input.legalName,
      businessPhone: input.businessPhone,
      businessEmail: input.businessEmail,
      businessAddress: input.businessAddress,
      branchName: input.branchName,
      branchCode: input.branchCode,
      branchPhone: input.branchPhone,
      branchAddress: input.branchAddress,
      branchTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      deviceName: input.deviceName,
      ownerName: input.ownerName,
      ownerEmail: input.ownerEmail,
      ownerPhone: input.ownerPhone,
      ownerPinHash: ownerHash,
      currency: input.currency,
      taxInclusive: input.taxInclusive,
      allowNegativeStock: input.allowNegativeStock,
      offlineSessionMinutes: input.offlineSessionMinutes,
      deviceId,
      devicePlatform: currentPlatform(),
    });

    await data.store.transaction(async (tx) => {
      await tx.put("business", workspace.business as unknown as Row);
      await tx.put("branches", workspace.branch as unknown as Row);
      await tx.put("devices", workspace.device as unknown as Row);
      await tx.put("users", workspace.owner as unknown as Row);
      await tx.enqueue([
        outboxEvent({
          businessId: workspace.business.id,
          branchId: workspace.branch.id,
          deviceId: workspace.device.id,
          entity: "user",
          entityId: workspace.owner.id,
          payload: workspace.owner,
        }),
      ]);
      await tx.setMeta(META_KEYS.businessId, workspace.business.id);
      await tx.setMeta(META_KEYS.branchId, workspace.branch.id);
      await tx.setMeta(META_KEYS.deviceId, workspace.device.id);
      await tx.setMeta(
        META_KEYS.deviceCode,
        workspace.device.id.slice(-4).toUpperCase(),
      );
      await tx.setMeta(META_KEYS.demo, false);
    });
    await data.reloadCaches();

    // Commit local identity before network work. A failed signup, confirmation
    // requirement, or temporary outage must not erase the account just created.
    if (isSupabaseConfigured() && input.ownerEmail && input.cloudPassword) {
      try {
        await ensureCloudWorkspace({
          store: data.store,
          business: workspace.business,
          branch: workspace.branch,
          device: workspace.device,
          owner: workspace.owner,
          email: input.ownerEmail,
          password: input.cloudPassword,
        });
      } catch {
        // Linking can be retried from the sign-in screen.
      }
    }

    set({
      business: workspace.business,
      branch: workspace.branch,
      device: workspace.device,
      users: [workspace.owner],
    });
    await get().bootstrap();
  },

  async joinCloudWorkspace(email, password) {
    const { data, business: existingBusiness, device: existingDevice } = get();
    if (!data) throw new Error("Local storage is not ready yet.");
    if (!isSupabaseConfigured())
      throw new Error(
        "Add the Supabase URL and publishable key, then restart the app.",
      );

    const localBusinessId = existingBusiness?.id ?? ulid();
    const deviceId = existingDevice?.id ?? ulid();
    const joined = await joinCloudWorkspace({
      localBusinessId,
      email: email.trim(),
      password,
      device: {
        id: deviceId,
        name: existingDevice?.name ?? "New terminal",
        platform: existingDevice?.platform ?? currentPlatform(),
        fingerprint: existingDevice?.fingerprint ?? deviceId,
        appVersion: existingDevice?.appVersion ?? "1.0.0",
      },
    });

    const cloudBusiness = joined.business;
    const cloudBranch = joined.branch;
    const business: Business = {
      id: localBusinessId,
      name: String(cloudBusiness.name ?? "POSA business"),
      legalName: (cloudBusiness.legal_name as string | null) ?? null,
      phone: (cloudBusiness.phone as string | null) ?? null,
      email: (cloudBusiness.email as string | null) ?? null,
      address: (cloudBusiness.address as string | null) ?? null,
      logoUrl: (cloudBusiness.logo_url as string | null) ?? null,
      settings: (cloudBusiness.settings as Business["settings"]) ?? {
        currency: "NGN",
        taxInclusive: true,
        allowNegativeStock: true,
        requireApprovalFor: ["sale.void"],
        maxDiscountBasisPoints: 1000,
        offlineSessionMinutes: 480,
      },
      createdAt: String(cloudBusiness.created_at ?? new Date().toISOString()),
      status: (cloudBusiness.status as Business["status"]) ?? "active",
    };
    const branch: Branch = {
      id: String(cloudBranch.id),
      businessId: localBusinessId,
      name: String(cloudBranch.name ?? "Main Shop"),
      code: String(cloudBranch.code ?? "MAIN"),
      address: (cloudBranch.address as string | null) ?? null,
      phone: (cloudBranch.phone as string | null) ?? null,
      timezone: String(cloudBranch.timezone ?? "Africa/Lagos"),
      isWarehouse: Boolean(cloudBranch.is_warehouse),
      status: (cloudBranch.status as Branch["status"]) ?? "active",
      createdAt: String(cloudBranch.created_at ?? new Date().toISOString()),
    };
    const device: Device = {
      id: deviceId,
      businessId: localBusinessId,
      branchId: branch.id,
      name: existingDevice?.name ?? "New terminal",
      platform: existingDevice?.platform ?? currentPlatform(),
      fingerprint: existingDevice?.fingerprint ?? deviceId,
      appVersion: existingDevice?.appVersion ?? "1.0.0",
      status: "active",
      lastSyncAt: null,
      lastAckedSeq: 0,
      registeredAt: new Date().toISOString(),
    };

    await data.store.transaction(async (tx) => {
      await tx.put("business", business as unknown as Row);
      await tx.put("branches", branch as unknown as Row);
      await tx.put("devices", device as unknown as Row);
      await tx.setMeta(META_KEYS.businessId, localBusinessId);
      await tx.setMeta(META_KEYS.branchId, branch.id);
      await tx.setMeta(META_KEYS.deviceId, device.id);
      await tx.setMeta(
        META_KEYS.cloudBusinessId,
        joined.identity.cloudBusinessId,
      );
      await tx.setMeta(META_KEYS.cloudUserId, joined.identity.cloudUserId);
    });
    await get().bootstrap();
  },

  /* ---------------------------------------------------------------- */
  /* Session                                                          */
  /* ---------------------------------------------------------------- */

  async connectCloud(email, password) {
    const { data, business, branch, device, users, engine } = get();
    if (!data || !business || !branch || !device)
      throw new Error("This terminal is not ready to connect.");
    const owner = users.find((user) => user.role === "owner") ?? users[0];
    if (!owner)
      throw new Error("No owner account is available on this terminal.");
    if (!isSupabaseConfigured())
      throw new Error(
        "Add the Supabase URL and publishable key, then restart the app.",
      );

    await ensureCloudWorkspace({
      store: data.store,
      business,
      branch,
      device,
      owner,
      email: email.trim(),
      password,
    });
    // Older builds wrote staff directly to local storage. Backfill those
    // profiles when this terminal is linked so an already-created account is
    // not stranded on one device.
    const localUsers = await data.store.getAll<User & Row>("users");
    await data.enqueue(
      localUsers.map((user) =>
        outboxEvent({
          businessId: business.id,
          branchId: user.branchIds?.[0] ?? branch.id,
          deviceId: device.id,
          entity: "user",
          entityId: user.id,
          payload: user,
          baseRevision: 0,
        }),
      ),
    );
    engine?.stop();
    const nextEngine = await createEngine(data, device);
    set({
      engine: nextEngine,
      cloudLabel: cloudStatusLabel(),
      syncStatus: nextEngine?.current ?? INITIAL_SYNC,
    });
    if (nextEngine) {
      await nextEngine.start();
      // Pull ALL data from cloud after linking — this is the
      // "online first" moment where the terminal downloads
      // products, prices, stock levels and business data.
      try {
        await nextEngine.pullAll();
        void nextEngine.drainOutbox();
      } catch {
        // Non-fatal: continue with local data.
      }
      void nextEngine.tick();
    }
  },

  async signInWithPin(userId, pin) {
    const { users, business, data } = get();
    const user = users.find((candidate) => candidate.id === userId);
    if (!user || !business || !data)
      return { ok: false, error: "That user is not on this terminal." };
    if (user.status !== "active")
      return { ok: false, error: "This account is suspended." };

    const result = await verifyPin(pin, user.pinHash);
    if (!result.ok) {
      await data.writeAudit({
        id: ulid(),
        businessId: business.id,
        branchId: null,
        deviceId: get().device?.id ?? "unknown",
        actorId: user.id,
        actorName: user.fullName,
        action: "auth.failed",
        entityType: "user",
        entityId: user.id,
        metadata: { reason: "bad_pin" },
        origin: "local",
        occurredAt: new Date().toISOString(),
      });
      return { ok: false, error: result.message ?? "That PIN is not correct." };
    }

    const session: Session = {
      userId: user.id,
      fullName: user.fullName,
      role: user.role,
      signedInAt: new Date().toISOString(),
      offline: true,
    };

    await applySession(set, get, session);
    return { ok: true, error: null };
  },

  async signOut() {
    const { data, business, device, session } = get();
    if (data) {
      await data.setMeta(META_KEYS.session, null);
      if (business) {
        await data.writeAudit({
          id: ulid(),
          businessId: business.id,
          branchId: get().branch?.id ?? null,
          deviceId: device?.id ?? "unknown",
          actorId: session?.userId ?? null,
          actorName: session?.fullName ?? "",
          action: "auth.sign_out",
          entityType: "user",
          entityId: session?.userId ?? null,
          metadata: {},
          origin: "local",
          occurredAt: new Date().toISOString(),
        });
      }
    }
    set({
      session: null,
      subject: null,
      phase: "signin",
      openShift: null,
      scanFeedback: IDLE_SCAN,
    });
  },

  can(permission) {
    const { subject } = get();
    if (!subject) return false;
    return effectivePermissions(subject).has(permission);
  },

  /* ---------------------------------------------------------------- */
  /* Sync                                                            */
  /* ---------------------------------------------------------------- */

  async syncNow() {
    const { engine } = get();
    if (!engine) {
      get().pushToast({
        message: "No cloud project connected",
        detail:
          "This terminal is running in local-only mode. Everything is saved on the device.",
        toneName: "info",
      });
      return;
    }
    const status = await engine.syncNow();
    set({ syncStatus: status });
    get().pushToast({
      message: status.lastError
        ? "Sync finished with a problem"
        : "Sync complete",
      detail:
        status.lastError ??
        `${status.lastPushed} uploaded · ${status.lastPulled} received`,
      toneName: status.lastError ? "warning" : "accent",
    });
  },

  /* ---------------------------------------------------------------- */
  /* Transient UI                                                    */
  /* ---------------------------------------------------------------- */

  pushToast(toast) {
    toastCounter += 1;
    const id = toast.id ?? `toast-${toastCounter}`;
    set({ toasts: [...get().toasts, { ...toast, id }] });
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((toast) => toast.id !== id) });
  },

  setScanFeedback(feedback) {
    set({ scanFeedback: feedback });
  },

  async refreshShift() {
    const { data, device } = get();
    if (!data || !device) return;
    const shift = await data.getOpenShift(device.id);
    set({ openShift: shift });
  },

  async resetTerminal() {
    const { data, engine } = get();
    if (!data) return;
    engine?.stop();
    await data.wipe();
    set({
      phase: "booting",
      bootError: null,
      business: null,
      branch: null,
      device: null,
      session: null,
      subject: null,
      users: [],
      data: null,
      engine: null,
      openShift: null,
      toasts: [],
    });
    await get().bootstrap();
  },
}));

/* ------------------------------------------------------------------ */
/* Helpers                                                           */
/* ------------------------------------------------------------------ */

type SetState = (partial: Partial<AppState>) => void;
type GetState = () => AppState;

async function applySession(
  set: SetState,
  get: GetState,
  session: Session,
): Promise<void> {
  const { users, business, data } = get();
  const user = users.find((candidate) => candidate.id === session.userId);
  if (!user || !business) {
    set({ phase: "signin" });
    return;
  }

  const subject: PermissionSubject = {
    role: user.role,
    branchIds: user.branchIds,
    granted: user.granted,
    revoked: user.revoked,
    status: user.status,
  };

  if (data) {
    await data.setMeta(META_KEYS.session, session);
    await data.writeAudit({
      id: ulid(),
      businessId: business.id,
      branchId: get().branch?.id ?? null,
      deviceId: get().device?.id ?? "unknown",
      actorId: user.id,
      actorName: user.fullName,
      action: "auth.offline_sign_in",
      entityType: "user",
      entityId: user.id,
      metadata: { role: user.role },
      origin: "local",
      occurredAt: new Date().toISOString(),
    });
  }

  set({ session, subject, phase: "ready" });
  await get().refreshShift();
}

async function createEngine(
  data: PosaData,
  device: Device,
): Promise<SyncEngine | null> {
  // In local-only mode we still construct an engine — it just has no transport.
  // That keeps one code path and lets the Sync Center report honestly.
  const cloudBusinessId = await data.getMeta<string>(META_KEYS.cloudBusinessId);
  const cloudUserId = (await data.getMeta<string>(META_KEYS.cloudUserId)) ?? "";
  const transport =
    isSupabaseConfigured() && cloudBusinessId
      ? await createTransport({
          localBusinessId: device.businessId,
          cloudBusinessId,
          cloudUserId,
        })
      : null;

  return new SyncEngine({
    data,
    transport,
    deviceId: device.id,
    businessId: cloudBusinessId ?? device.businessId,
    branchId: device.branchId,
    getSequence: () => data.peekSequence(),
    onStatusChange: (status) => {
      useApp.setState({ syncStatus: status });
    },
    onDataChanged: async () => {
      useApp.setState({ users: await data.listUsers() });
    },
  });
}

function currentPlatform(): Device["platform"] {
  if (Platform.OS === "web") return "web";
  if (Platform.OS === "ios") return "ios";
  if (Platform.OS === "android") return "android";
  return "windows";
}

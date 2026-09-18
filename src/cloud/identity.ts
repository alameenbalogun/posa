import type { Branch, Business, Device, User } from "@/domain/types";
import { META_KEYS, type LocalStore } from "@/data/local";
import { getSupabaseClient } from "./client";
import { getSupabaseConfig } from "./config";

export interface CloudIdentity {
  localBusinessId: string;
  cloudBusinessId: string;
  cloudUserId: string;
}

export interface JoinedCloudWorkspace {
  identity: CloudIdentity;
  business: Record<string, unknown>;
  branch: Record<string, unknown>;
}

async function authenticate(
  client: Awaited<ReturnType<typeof getSupabaseClient>>,
  email: string,
  password: string,
) {
  if (!client) throw new Error("Cloud credentials are not configured.");
  let signedIn;
  try {
    signedIn = await client.auth.signInWithPassword({ email, password });
  } catch (error) {
    const endpoint =
      getSupabaseConfig()?.url ?? "the configured Supabase project";
    throw new Error(
      `Could not reach Supabase at ${endpoint}. Check the device connection, browser network permissions, and EXPO_PUBLIC_SUPABASE_URL. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (signedIn.error || !signedIn.data.session) {
    if (
      /email not confirmed|email_not_confirmed/i.test(
        signedIn.error?.message ?? "",
      )
    ) {
      throw new Error(
        "EMAIL_CONFIRMATION_REQUIRED: Confirm the email address before connecting this terminal.",
      );
    }
    throw new Error(signedIn.error?.message ?? "Cloud sign-in failed.");
  }
  return signedIn.data.session;
}

export async function resendCloudConfirmation(email: string): Promise<void> {
  const client = await getSupabaseClient();
  if (!client) throw new Error("Cloud credentials are not configured.");
  const { error } = await client.auth.resend({ type: "signup", email });
  if (error) throw new Error(error.message);
}

/** Authenticate and register a brand-new terminal under an existing business. */
export async function joinCloudWorkspace(input: {
  device: {
    id: string;
    name: string;
    platform: string;
    fingerprint: string;
    appVersion: string;
  };
  localBusinessId: string;
  email: string;
  password: string;
}): Promise<JoinedCloudWorkspace> {
  const client = await getSupabaseClient();
  if (!client) throw new Error("Cloud credentials are not configured.");
  await authenticate(client, input.email, input.password);
  let result;
  try {
    result = await client.rpc("join_business_workspace", {
      p_device: {
        id: input.device.id,
        name: input.device.name,
        platform: input.device.platform,
        fingerprint: input.device.fingerprint,
        app_version: input.device.appVersion,
      },
    });
  } catch (error) {
    throw new Error(
      `Supabase authentication succeeded, but the workspace join request failed. Apply migrations 0001–0006 and retry. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (result.error || !result.data)
    throw new Error(
      result.error?.message?.includes("Could not find the function")
        ? "The workspace join function is missing. Apply Supabase migrations 0001–0006, then retry."
        : (result.error?.message ?? "This account cannot join a workspace."),
    );
  const body = result.data as {
    cloudBusinessId?: string;
    cloudUserId?: string;
    business?: Record<string, unknown>;
    branch?: Record<string, unknown>;
  };
  if (
    !body.cloudBusinessId ||
    !body.cloudUserId ||
    !body.business ||
    !body.branch
  )
    throw new Error("Cloud workspace returned an incomplete identity mapping.");
  const identity = {
    localBusinessId: input.localBusinessId,
    cloudBusinessId: body.cloudBusinessId,
    cloudUserId: body.cloudUserId,
  };
  return { identity, business: body.business, branch: body.branch };
}

/**
 * Establish the authenticated cloud workspace without changing local IDs.
 * Local data remains authoritative; the server stores a durable ID mapping so
 * old offline records can be uploaded safely on first connection.
 */
export async function ensureCloudWorkspace(input: {
  store: LocalStore;
  business: Business;
  branch: Branch;
  device: Device;
  owner: User;
  email: string;
  password: string;
}): Promise<CloudIdentity> {
  const client = await getSupabaseClient();
  if (!client) throw new Error("Cloud credentials are not configured.");

  let session = (await client.auth.getSession()).data.session;
  const sessionEmail = session?.user.email?.trim().toLowerCase();
  if (!session || sessionEmail !== input.email.trim().toLowerCase()) {
    const signedIn = await client.auth.signInWithPassword({
      email: input.email,
      password: input.password,
    });
    if (signedIn.error || !signedIn.data.session) {
      const registered = await client.auth.signUp({
        email: input.email,
        password: input.password,
        options: { data: { full_name: input.owner.fullName } },
      });
      if (registered.error || !registered.data.session) {
        if (!registered.error && registered.data.user) {
          throw new Error(
            "EMAIL_CONFIRMATION_REQUIRED: We sent a confirmation email. Confirm it before connecting this terminal.",
          );
        }
        throw new Error(
          registered.error?.message ??
            "Cloud account needs email confirmation before it can sync.",
        );
      }
      session = registered.data.session;
    } else {
      session = signedIn.data.session;
    }
  }

  const result = await client.rpc("ensure_business_link", {
    p_local_business_id: input.business.id,
    p_business: {
      name: input.business.name,
      legal_name: input.business.legalName,
      phone: input.business.phone,
      email: input.business.email,
      address: input.business.address,
      settings: input.business.settings,
    },
    p_branch: {
      id: input.branch.id,
      name: input.branch.name,
      code: input.branch.code,
      address: input.branch.address,
      phone: input.branch.phone,
      timezone: input.branch.timezone,
      is_warehouse: input.branch.isWarehouse,
    },
    p_device: {
      id: input.device.id,
      name: input.device.name,
      branch_id: input.device.branchId,
      platform: input.device.platform,
      fingerprint: input.device.fingerprint,
      app_version: input.device.appVersion,
    },
    p_owner: {
      full_name: input.owner.fullName,
      email: input.owner.email ?? input.email,
      phone: input.owner.phone,
      role: input.owner.role,
      branch_ids: input.owner.branchIds,
    },
  });

  if (result.error || !result.data)
    throw new Error(
      result.error?.message ?? "Cloud workspace could not be created.",
    );
  const body = result.data as { cloudBusinessId?: string; userId?: string };
  if (!body.cloudBusinessId || !body.userId)
    throw new Error("Cloud workspace returned an incomplete identity mapping.");

  const identity: CloudIdentity = {
    localBusinessId: input.business.id,
    cloudBusinessId: body.cloudBusinessId,
    cloudUserId: body.userId,
  };
  await input.store.setMeta(
    META_KEYS.cloudBusinessId,
    identity.cloudBusinessId,
  );
  await input.store.setMeta(META_KEYS.cloudUserId, identity.cloudUserId);
  return identity;
}

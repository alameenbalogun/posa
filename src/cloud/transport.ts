/**
 * Cloud transport (PRD §33 API Design).
 *
 * A deliberately thin wrapper over the `sync_push` / `sync_pull` RPCs. It
 * contains no business rules and no retry policy — those live in the sync engine
 * — so the transport stays easy to reason about and easy to fake in tests.
 *
 * Every push sends the SAME event ids the device generated offline. That is the
 * entire idempotency story: the server has seen them or it has not.
 */

import type {
  EntityKind,
  OutboxEvent,
  SyncPullResponse,
  SyncPushResponse,
} from "@/domain/sync-protocol";
import { getSupabaseClient, type SupabaseLike } from "./client";
import type { CloudIdentity } from "./identity";

export interface PushInput {
  deviceId: string;
  businessId: string;
  sequence: number;
  events: readonly OutboxEvent[];
}

export interface PullInput {
  deviceId: string;
  businessId: string;
  branchId: string | null;
  cursor: string | null;
  entities?: EntityKind[];
  limit?: number;
}

export class CloudRejectedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CloudRejectedError";
    this.code = code;
  }
}

/** Convert a Supabase/PostgREST failure into a message a shopkeeper can act on. */
export function describeCloudError(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  const raw = error as {
    message?: string;
    code?: string;
    status?: number;
  } | null;
  const message = raw?.message ?? "Unknown network error";
  const status = raw?.status;

  if (status === 401 || status === 403) {
    return {
      code: "unauthorized",
      message: "This terminal is not authorised. Sign in again.",
      retryable: false,
    };
  }
  if (status === 429) {
    return {
      code: "rate_limited",
      message: "Too many requests. Retrying shortly.",
      retryable: true,
    };
  }
  if (
    error instanceof TypeError ||
    /network|fetch|failed to fetch/i.test(message)
  ) {
    return {
      code: "transient",
      message: "No connection to the cloud right now.",
      retryable: true,
    };
  }
  if (/duplicate key|unique constraint/i.test(message)) {
    // Not actually an error: the row already exists, so this is a replay.
    return {
      code: "duplicate",
      message: "This record already exists in the cloud.",
      retryable: false,
    };
  }
  return { code: "transient", message, retryable: true };
}

function snakeToCamel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeToCamel);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      snakeToCamel(entry),
    ]),
  );
}

export class SyncTransport {
  constructor(
    private readonly client: SupabaseLike,
    private readonly identity: CloudIdentity,
  ) {}

  async push(input: PushInput): Promise<SyncPushResponse> {
    const barcodeEvents = input.events.filter(
      (event) => event.entity === "barcode",
    );
    const regularEvents = input.events.filter(
      (event) => event.entity !== "barcode",
    );
    const events = regularEvents.map((event) => ({
      ...event,
      businessId: this.identity.cloudBusinessId,
      payload: {
        ...(event.payload as Record<string, unknown>),
        businessId: this.identity.cloudBusinessId,
      },
    }));
    const responses: SyncPushResponse[] = [];
    if (regularEvents.length > 0) {
      const { data, error } = await this.client.rpc("sync_push", {
        p_device: input.deviceId,
        p_business: this.identity.cloudBusinessId,
        p_sequence: input.sequence,
        p_client_time: new Date().toISOString(),
        p_events: events,
      });
      if (error)
        throw new CloudRejectedError(
          error.code ?? "push_failed",
          error.message,
        );
      responses.push(data as SyncPushResponse);
    }
    if (barcodeEvents.length > 0) {
      const { data, error } = await this.client.rpc("sync_barcode_push", {
        p_device: input.deviceId,
        p_business: this.identity.cloudBusinessId,
        p_events: barcodeEvents.map((event) => ({
          ...event,
          businessId: this.identity.cloudBusinessId,
          payload: {
            ...(event.payload as Record<string, unknown>),
            businessId: this.identity.cloudBusinessId,
          },
        })),
      });
      if (error)
        throw new CloudRejectedError(
          error.code ?? "barcode_push_failed",
          error.message,
        );
      responses.push(data as SyncPushResponse);
    }
    return {
      serverTime: responses.at(-1)?.serverTime ?? new Date().toISOString(),
      cursor: responses.at(-1)?.cursor ?? "0",
      reauthRequired: responses.some((response) => response.reauthRequired),
      results: responses.flatMap((response) => response.results),
    };
  }

  async pull(input: PullInput): Promise<SyncPullResponse> {
    const { data, error } = await this.client.rpc("sync_pull", {
      p_device: input.deviceId,
      p_business: this.identity.cloudBusinessId,
      p_branch: input.branchId,
      p_cursor: input.cursor ? Number(input.cursor) : 0,
      p_limit: input.limit ?? 500,
      p_entities: input.entities ?? null,
    });

    if (error)
      throw new CloudRejectedError(error.code ?? "pull_failed", error.message);
    const response = data as SyncPullResponse;
    return {
      ...response,
      changes: response.changes.map((change) => ({
        ...change,
        row: change.row
          ? {
              ...(snakeToCamel(change.row) as Record<string, unknown>),
              businessId: this.identity.localBusinessId,
              business_id: this.identity.localBusinessId,
            }
          : null,
      })),
    };
  }

  /**
   * Confirm a payment that was recorded as pending while the terminal was
   * offline (PRD §12, §47). We never guess: the provider or a human supplies the
   * reference, and only then does the payment become successful.
   */
  async confirmPayment(params: {
    paymentId: string;
    reference: string;
    provider: string | null;
  }): Promise<void> {
    const { error } = await this.client
      .from("payments")
      .update({
        status: "successful",
        reference: params.reference,
        provider: params.provider,
        captured_at: new Date().toISOString(),
      })
      .eq("id", params.paymentId);
    if (error)
      throw new CloudRejectedError(
        error.code ?? "confirm_failed",
        error.message,
      );
  }

  async reportDevice(device: {
    id: string;
    businessId: string;
    branchId: string;
    name: string;
    platform: string;
    fingerprint: string;
    appVersion: string;
  }): Promise<void> {
    const { error } = await this.client.from("devices").upsert({
      id: device.id,
      business_id: device.businessId,
      branch_id: device.branchId,
      name: device.name,
      platform: device.platform,
      fingerprint: device.fingerprint,
      app_version: device.appVersion,
      status: "active",
    });
    if (error)
      throw new CloudRejectedError(
        error.code ?? "device_report_failed",
        error.message,
      );
  }
}

export async function createTransport(
  identity: CloudIdentity,
): Promise<SyncTransport | null> {
  const client = await getSupabaseClient();
  return client ? new SyncTransport(client, identity) : null;
}

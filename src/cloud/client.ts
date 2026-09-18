/**
 * Supabase client.
 *
 * Two deliberate choices:
 *
 * 1. LAZY. `createClient` is only called on first use, so an unconfigured build
 *    never constructs a client, never schedules a token refresh and never logs a
 *    warning. Local-only mode is genuinely quiet.
 *
 * 2. NARROW SURFACE. The rest of the app depends on `SupabaseLike` — the handful
 *    of methods we actually use — rather than on the concrete client type. That
 *    keeps the transport unit-testable with a plain object instead of a mock
 *    library, and it means swapping the backend later touches one file.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseConfig } from "./config";

export interface PostgrestErrorLike {
  message: string;
  code?: string;
  status?: number;
}

export interface QueryResult<T> {
  data: T | null;
  error: PostgrestErrorLike | null;
}

/** Builder returned by `from(table)`; mirrors the subset of PostgREST we use. */
export interface TableQuery {
  select(columns?: string): TableQuery;
  upsert(values: unknown, options?: Record<string, unknown>): TableQuery;
  insert(values: unknown): TableQuery;
  update(values: unknown): TableQuery;
  delete(): TableQuery;
  eq(column: string, value: unknown): TableQuery;
  in(column: string, values: readonly unknown[]): TableQuery;
  gte(column: string, value: unknown): TableQuery;
  order(column: string, options?: { ascending?: boolean }): TableQuery;
  limit(count: number): TableQuery;
  single(): Promise<QueryResult<unknown>>;
  maybeSingle(): Promise<QueryResult<unknown>>;
  then<TResult = QueryResult<unknown>>(
    onfulfilled?:
      | ((value: QueryResult<unknown>) => TResult | PromiseLike<TResult>)
      | null,
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<TResult>;
}

export interface AuthSessionLike {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  user: { id: string; email?: string | null };
}

export interface SupabaseLike {
  rpc(fn: string, args: Record<string, unknown>): Promise<QueryResult<unknown>>;
  from(table: string): TableQuery;
  auth: {
    getSession(): Promise<{ data: { session: AuthSessionLike | null } }>;
    signInWithPassword(credentials: {
      email: string;
      password: string;
    }): Promise<{
      data: {
        session: AuthSessionLike | null;
        user: { id: string; email?: string | null } | null;
      };
      error: PostgrestErrorLike | null;
    }>;
    signUp(credentials: {
      email: string;
      password: string;
      options?: Record<string, unknown>;
    }): Promise<{
      data: {
        session: AuthSessionLike | null;
        user: { id: string; email?: string | null } | null;
      };
      error: PostgrestErrorLike | null;
    }>;
    resend(credentials: {
      type: "signup";
      email: string;
      options?: Record<string, unknown>;
    }): Promise<{
      data: { user: { id: string; email?: string | null } | null };
      error: PostgrestErrorLike | null;
    }>;
    signOut(): Promise<{ error: PostgrestErrorLike | null }>;
  };
}

let clientPromise: Promise<SupabaseLike | null> | null = null;

async function build(): Promise<SupabaseLike | null> {
  const config = getSupabaseConfig();
  if (!config) return null;

  const client: SupabaseClient = createClient(config.url, config.anonKey, {
    auth: {
      storage: {
        getItem: (key: string) => AsyncStorage.getItem(key),
        setItem: (key: string, value: string) =>
          AsyncStorage.setItem(key, value),
        removeItem: (key: string) => AsyncStorage.removeItem(key),
      },
      persistSession: true,
      autoRefreshToken: true,
      // There is no OAuth redirect to parse on a till, and detecting one on
      // native causes a needless URL subscription.
      detectSessionInUrl: false,
    },
    global: {
      headers: { "x-posa-client": "posa-terminal" },
    },
  });

  return client as unknown as SupabaseLike;
}

/**
 * Get the client, or null when the build has no credentials. Callers must treat
 * null as "run local-only", not as an error.
 */
export function getSupabaseClient(): Promise<SupabaseLike | null> {
  if (!clientPromise) clientPromise = build();
  return clientPromise;
}

export function resetSupabaseClient(): void {
  clientPromise = null;
}

export async function getCloudSession(): Promise<AuthSessionLike | null> {
  const client = await getSupabaseClient();
  if (!client) return null;
  try {
    const { data } = await client.auth.getSession();
    return data.session;
  } catch {
    return null;
  }
}

export async function isCloudReachable(): Promise<boolean> {
  const client = await getSupabaseClient();
  if (!client) return false;
  try {
    // Cheapest possible round trip that proves auth + network + project health.
    const { error } = await client.from("businesses").select("id").limit(1);
    return error === null || error.code === "PGRST116";
  } catch {
    return false;
  }
}

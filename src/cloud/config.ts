/**
 * Cloud configuration.
 *
 * DESIGN CONSTRAINT (explicit product requirement): credentials are supplied
 * AFTER the build. The application must therefore be completely functional with
 * no Supabase project at all.
 *
 * So "not configured" is a first-class, first-rate mode — not an error state:
 *   - the till sells, scans, prices, prints, counts and reports from local storage
 *   - the Sync Center explains plainly that the cloud is not connected and shows
 *     exactly how many events are waiting
 *   - nothing retries in a loop, nothing throws, no red screen
 *
 * Adding the two environment variables later switches the same code path on.
 * The offline-first architecture means this is a configuration change, never a
 * rewrite — which is the whole point of building the local database first.
 */

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

const ENV = ((): Record<string, string | undefined> => {
  // Expo exposes EXPO_PUBLIC_* to the client bundle. We also accept a couple of
  // conventional aliases so a CI-injected environment does not need renaming.
  const meta = (import.meta ?? {}) as {
    env?: Record<string, string | undefined>;
  };
  return {
    ...(typeof process !== "undefined"
      ? (process.env as Record<string, string | undefined>)
      : {}),
    ...(meta.env ?? {}),
  };
})();

function read(key: string): string | null {
  const value = ENV[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // Treat placeholder values as "not configured" so a half-filled .env cannot
  // produce a confusing network error at 8am on a Monday.
  if (!trimmed) return null;
  if (/^(your[-_]|placeholder|xxx|changeme|<)/i.test(trimmed)) return null;
  return trimmed;
}

export function readSupabaseConfig(): SupabaseConfig | null {
  const url = read("EXPO_PUBLIC_SUPABASE_URL") ?? read("SUPABASE_URL");
  const anonKey =
    read("EXPO_PUBLIC_SUPABASE_ANON_KEY") ?? read("SUPABASE_ANON_KEY");
  if (!url || !anonKey) return null;
  if (!/^https?:\/\//.test(url)) return null;
  return { url, anonKey };
}

let cached: SupabaseConfig | null | undefined;

export function getSupabaseConfig(): SupabaseConfig | null {
  if (cached === undefined) cached = readSupabaseConfig();
  return cached;
}

export function isSupabaseConfigured(): boolean {
  return getSupabaseConfig() !== null;
}

/** Human explanation for the Sync Center and Settings screens. */
export function cloudStatusLabel(): {
  configured: boolean;
  label: string;
  detail: string;
} {
  const config = getSupabaseConfig();
  if (!config) {
    return {
      configured: false,
      label: "Local-only mode",
      detail:
        "No cloud project is connected. Every sale, scan and stock movement is stored on this device and will upload the moment credentials are added.",
    };
  }
  return {
    configured: true,
    label: "Cloud connected",
    detail: `Synchronising with ${config.url.replace(/^https?:\/\//, "")}`,
  };
}

/** Reset the cache — used by tests and by the Settings screen after a change. */
export function resetSupabaseConfig(): void {
  cached = undefined;
}

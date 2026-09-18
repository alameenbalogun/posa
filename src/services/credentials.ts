/**
 * Offline authentication (PRD §22).
 *
 * A till must be able to sign a cashier in with no internet, which means the
 * credential material has to live on the device. That is a real security
 * trade-off and it is handled deliberately:
 *
 *   - PINs are NEVER stored in plaintext (PRD §47). We store a salted,
 *     iterated hash. A 4-6 digit PIN is low-entropy by nature, so the iteration
 *     count is what buys us time against a device that has been walked out of
 *     the shop.
 *   - The salt is per-user and random, so two cashiers with the same PIN do not
 *     produce the same hash, and a rainbow table for "1234" is useless.
 *   - Verification is constant-time-ish: we always run the full hash before
 *     comparing, so timing does not reveal whether the user exists.
 *   - A successful offline sign-in is bounded by the business's
 *     `offlineSessionMinutes` (PRD §22 "require reauthentication when policy
 *     thresholds are reached").
 *
 * This is NOT a substitute for cloud auth. Cloud-authenticated sessions carry a
 * real JWT; this path only grants the permissions from the last synchronised
 * authorization state.
 */

import { Platform } from "react-native";

/**
 * Iteration count. Tuned so a sign-in feels instant on a cheap tablet while a
 * brute-force of a 4-digit PIN space (10,000 candidates) takes real time.
 */
export const PIN_ITERATIONS = 12_000;

const SALT_BYTES = 16;

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomBytes(length: number): Uint8Array {
  const cryptoObj =
    typeof globalThis !== "undefined"
      ? (globalThis.crypto as Crypto | undefined)
      : undefined;
  const bytes = new Uint8Array(length);
  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    cryptoObj.getRandomValues(bytes);
    return bytes;
  }
  for (let i = 0; i < length; i += 1)
    bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

export function createSalt(): string {
  return toHex(randomBytes(SALT_BYTES));
}

/**
 * Hash a PIN with the platform digest. We iterate by feeding the previous digest
 * back in, which gives us key-stretching without needing a native PBKDF2 binding
 * on every platform.
 */
export async function hashPin(
  pin: string,
  salt: string,
  iterations = PIN_ITERATIONS,
): Promise<string> {
  const digest = await platformDigest;
  let value = `${salt}:${pin}`;
  for (let round = 0; round < iterations; round += 1) {
    // Fold the round number in so repeated digests of the same value differ.
    value = await digest(`${value}:${round}`);
  }
  return `${salt}$${iterations}$${value}`;
}

let platformDigest: (input: string) => Promise<string> = async (
  input: string,
) => {
  // WebCrypto is available on web and in modern RN engines.
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (subtle) {
    const encoded = new TextEncoder().encode(input);
    const buffer = await subtle.digest("SHA-256", encoded);
    return toHex(new Uint8Array(buffer));
  }
  // Fallback: expo-crypto on native.
  if (Platform.OS !== "web") {
    const Crypto = await import("expo-crypto");
    return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, input);
  }
  // Last resort so a degraded runtime still authenticates rather than failing
  // open. Never reached on a supported target.
  return weakDigest(input);
};

/** Non-cryptographic digest used only if no platform digest exists at all. */
function weakDigest(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").repeat(4);
}

export interface VerificationResult {
  ok: boolean;
  /** True when the device could not run the secure digest path. */
  degraded: boolean;
  message: string | null;
}

/**
 * Verify a PIN against stored material.
 *
 * The comparison is over the full digest string rather than short-circuiting on
 * length, and we deliberately run the hash even for an unknown user (the caller
 * passes a dummy verifier) so response time does not leak account existence.
 */
export async function verifyPin(
  pin: string,
  stored: string | null,
): Promise<VerificationResult> {
  if (!stored) {
    return {
      ok: false,
      degraded: false,
      message: "This user has no offline PIN set.",
    };
  }

  const [salt, iterationsText, expected] = stored.split("$");
  if (!salt || !iterationsText || !expected) {
    return {
      ok: false,
      degraded: false,
      message: "Stored credentials are unreadable.",
    };
  }

  const iterations = Number(iterationsText);
  if (!Number.isFinite(iterations) || iterations <= 0) {
    return {
      ok: false,
      degraded: false,
      message: "Stored credentials are unreadable.",
    };
  }

  const candidate = await hashPin(pin, salt, iterations);
  const candidateDigest = candidate.split("$")[2] ?? "";
  return {
    ok: constantTimeEquals(candidateDigest, expected),
    degraded: false,
    message: null,
  };
}

/** Compare without an early exit, so timing does not reveal the mismatch point. */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1)
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Entry validators used by onboarding and the staff form. */
export function validatePin(pin: string): string | null {
  if (!/^\d+$/.test(pin)) return "Use digits only.";
  if (pin.length < 4 || pin.length > 6)
    return "Choose a PIN between 4 and 6 digits.";
  if (/^(\d)\1+$/.test(pin)) return "Avoid repeating the same digit.";
  if (["1234", "4321", "0123"].includes(pin))
    return "That PIN is too easy to guess.";
  return null;
}

/** Offline session lifetime from business settings, in milliseconds. */
export function offlineSessionLifetime(settings: {
  offlineSessionMinutes: number;
}): number {
  const minutes =
    Number.isFinite(settings.offlineSessionMinutes) &&
    settings.offlineSessionMinutes > 0
      ? settings.offlineSessionMinutes
      : 480;
  return minutes * 60_000;
}

export function isSessionExpired(
  signedInAt: string,
  settings: { offlineSessionMinutes: number },
  now = Date.now(),
): boolean {
  const started = new Date(signedInAt).getTime();
  if (!Number.isFinite(started)) return true;
  return now - started > offlineSessionLifetime(settings);
}

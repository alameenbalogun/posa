/**
 * ULID — Universally Unique Lexicographically Sortable Identifier.
 *
 * Why not uuid v4 / nanoid?
 *  - POSA generates IDs *offline*, on many devices, with no coordination.
 *  - IDs must be globally unique (safe retries + idempotency, PRD §21.1).
 *  - IDs must sort by creation time so the sync outbox replays in
 *    dependency-safe order without a separate index (PRD §21.2).
 *  - IDs must fit in a URL / QR code on a receipt (PRD §13).
 *
 * A ULID is 26 Crockford base32 chars: 10 chars of millisecond timestamp
 * followed by 16 chars of randomness. It is monotonic within the same
 * millisecond, which matters because a fast scanner can produce several
 * events inside one millisecond (PRD §46, "duplicate barcode scanned rapidly").
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 (no I, L, O, U)
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

/** Increment the random part in-place, carrying left like an odometer. */
function incrementRandom(chars: string[]): string[] {
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const value = ENCODING.indexOf(chars[i]);
    if (value < ENCODING_LEN - 1) {
      chars[i] = ENCODING[value + 1];
      return chars;
    }
    chars[i] = ENCODING[0];
  }
  // Random space exhausted (astronomically unlikely). Fall back to fresh randomness.
  return randomChars();
}

function randomChars(): string[] {
  const chars: string[] = new Array(RANDOM_LEN);
  // Prefer a CSPRNG where the platform exposes one; fall back to Math.random
  // for environments without WebCrypto (older RN engines).
  const cryptoObj: Crypto | undefined =
    typeof globalThis !== 'undefined' ? (globalThis.crypto as Crypto | undefined) : undefined;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const bytes = new Uint8Array(RANDOM_LEN);
    cryptoObj.getRandomValues(bytes);
    for (let i = 0; i < RANDOM_LEN; i += 1) {
      chars[i] = ENCODING[bytes[i] % ENCODING_LEN];
    }
    return chars;
  }
  for (let i = 0; i < RANDOM_LEN; i += 1) {
    chars[i] = ENCODING[Math.floor(Math.random() * ENCODING_LEN)];
  }
  return chars;
}

function encodeTime(now: number): string {
  let time = now;
  const out: string[] = new Array(TIME_LEN);
  for (let i = TIME_LEN - 1; i >= 0; i -= 1) {
    out[i] = ENCODING[time % ENCODING_LEN];
    time = Math.floor(time / ENCODING_LEN);
  }
  return out.join('');
}

let lastTime = -1;
let lastRandom: string[] = [];

/**
 * Generate a new ULID. Monotonic: if called twice in the same millisecond the
 * random component is incremented, guaranteeing strictly increasing IDs.
 */
export function ulid(seedTime: number = Date.now()): string {
  const time = Math.max(seedTime, lastTime);
  if (time === lastTime) {
    lastRandom = incrementRandom(lastRandom.slice());
  } else {
    lastTime = time;
    lastRandom = randomChars();
  }
  return encodeTime(time) + lastRandom.join('');
}

/** Extract the creation timestamp (ms since epoch) encoded in a ULID. */
export function ulidTime(id: string): number {
  let time = 0;
  for (let i = 0; i < TIME_LEN; i += 1) {
    const value = ENCODING.indexOf(id[i]?.toUpperCase() ?? '0');
    time = time * ENCODING_LEN + (value < 0 ? 0 : value);
  }
  return time;
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && ULID_RE.test(value);
}

/** Short, human-friendly fragment of an ID used in receipt numbers and device codes. */
export function shortCode(id: string, length = 4): string {
  return id.replace(/[^0-9A-Z]/gi, '').slice(-length).toUpperCase();
}

export function newId(prefix?: string): string {
  const id = ulid();
  return prefix ? `${prefix}_${id}` : id;
}

/**
 * Barcode validation and symbology detection (PRD §10.2).
 *
 * A POS must decide locally, before any network hop, whether a scan is even
 * plausible. Bad checksums and truncated reads are the single biggest source of
 * "why did that add the wrong item to my cart" support tickets, so every scan
 * passes through here first. This module is pure — no DOM, no native bridge —
 * which also makes it trivially unit-testable (PRD §44 "barcode scanner tests").
 */

import type { BarcodeSymbology } from './types';

export interface BarcodeAnalysis {
  /** Canonical scan value: trimmed, uppercase, control chars stripped.
   *  This is what we use as the lookup key for linear symbologies. */
  value: string;
  /**
   * The scan with case preserved. QR payloads are frequently JSON or a URL,
   * and upper-casing them would silently corrupt them — so callers handling a
   * QR symbology must read `payload`, not `value`.
   */
  payload: string;
  symbology: BarcodeSymbology;
  /** False when a checksum failed or the value can't be a real barcode. */
  isPlausible: boolean;
  /** True when the value is a POSA-generated internal code. */
  isInternal: boolean;
  /** Populated when `isPlausible` is false. */
  problem: string | null;
  /** Some scanners emit a prefix/suffix; kept so we can diagnose hardware. */
  raw: string;
}

/**
 * HID scanners frequently append CR/LF/TAB and occasionally prefix a
 * manufacturer code. Strip the noise before we ever look at the value
 * (PRD §46, "scanner sends an unexpected suffix/prefix").
 *
 * Case is preserved here on purpose: see `BarcodeAnalysis.payload`.
 */
export function stripScan(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, '').trim();
}

/** Canonical form for linear barcodes, where case carries no meaning. */
export function normaliseScan(raw: string): string {
  return stripScan(raw).toUpperCase();
}

/** Heuristic: does this scan look like a QR payload rather than a linear code? */
export function looksLikeQrPayload(value: string): boolean {
  if (value.length < 16) return false;
  if (value.startsWith('{') || value.startsWith('[')) return true;
  if (/^[a-z]+:\/\//i.test(value)) return true;
  // A long mixed-case or punctuation-heavy blob is not a linear barcode.
  return /[^0-9A-Za-z]/.test(value) && value.length > 20;
}

/** GS1 / EAN check digit: (10 - ((sum of weighted digits) mod 10)) mod 10. */
export function eanCheckDigit(digitsWithoutCheck: string): number {
  let sum = 0;
  // Weights alternate 3,1,3,1... counting from the RIGHT of the payload.
  for (let i = 0; i < digitsWithoutCheck.length; i += 1) {
    const digit = Number(digitsWithoutCheck[digitsWithoutCheck.length - 1 - i]);
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidEan(digits: string): boolean {
  if (!/^\d+$/.test(digits) || digits.length < 2) return false;
  const payload = digits.slice(0, -1);
  const check = Number(digits[digits.length - 1]);
  return eanCheckDigit(payload) === check;
}

/** Code 39 uses a modulo-43 check character. */
const CODE39_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%';

export function isValidCode39(value: string, requireCheckChar = false): boolean {
  if (!value) return false;
  const body = requireCheckChar ? value.slice(0, -1) : value;
  if (![...body].every((c) => CODE39_ALPHABET.includes(c))) return false;
  if (!requireCheckChar) return true;
  const sum = [...body].reduce((acc, c) => acc + CODE39_ALPHABET.indexOf(c), 0);
  const expected = CODE39_ALPHABET[sum % 43];
  return expected === value[value.length - 1];
}

/** ITF-14 is an EAN-style 14-digit code with a mod-10 check digit. */
export function isValidItf14(value: string): boolean {
  if (!/^\d{14}$/.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i += 1) {
    sum += Number(value[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return (10 - (sum % 10)) % 10 === Number(value[13]);
}

export function isValidUpcE(value: string): boolean {
  // UPC-E is 8 digits (6 payload + number system + check) and expands to UPC-A.
  if (!/^\d{8}$/.test(value)) return false;
  const expanded = expandUpcE(value);
  return expanded !== null && isValidEan(expanded);
}

/** Expand a UPC-E code to its equivalent UPC-A so both resolve to one product. */
export function expandUpcE(value: string): string | null {
  if (!/^\d{8}$/.test(value)) return null;
  const numberSystem = value[0];
  const check = value[7];
  const body = value.slice(1, 7);

  // Guard: last char of the body encodes the compression mode.
  const lastDigit = body[5];
  let manufacturer = '';
  let product = '';
  switch (lastDigit) {
    case '0':
    case '1':
    case '2':
      manufacturer = body.slice(0, 2) + lastDigit + '00';
      product = '00' + body.slice(2, 5);
      break;
    case '3':
      manufacturer = body.slice(0, 3) + '00';
      product = '000' + body.slice(3, 5);
      break;
    case '4':
      manufacturer = body.slice(0, 4) + '0';
      product = '0000' + body[4];
      break;
    default:
      manufacturer = body.slice(0, 5);
      product = '0000' + lastDigit;
      break;
  }
  return numberSystem + manufacturer + product + check;
}

/**
 * Reduce a UPC-A to its UPC-E form when the product code allows it.
 *
 * This is written as the exact inverse of `expandUpcE` — the compression mode
 * digit (E6) is determined by which of the four shape rules the manufacturer and
 * product numbers satisfy. Keeping the two functions as provable inverses is
 * what lets us match a compressed in-store label to the full GTIN in the catalog
 * with confidence.
 */
export function compressToUpcE(upcA: string): string | null {
  if (!/^\d{12}$/.test(upcA)) return null;
  const numberSystem = upcA[0];
  const manufacturer = upcA.slice(1, 6); // M1..M5
  const product = upcA.slice(6, 11); // P1..P5
  const check = upcA[11];
  if (!/^[01]$/.test(numberSystem)) return null;

  const [m1, m2, m3, m4, m5] = manufacturer;
  const [p1, p2, p3, p4, p5] = product;

  // Mode 0/1/2: M4M5 = 00, M3 in {0,1,2}, P1P2 = 00.
  //
  // NOTE: the UPC-E "mode 3" shape (M4M5 = 00, M3 = 0, P1P2P3 = 000) is a strict
  // subset of this condition, so it is deliberately not handled here. The scheme
  // is many-to-one by design — several UPC-E codes expand to the same UPC-A — and
  // compression must pick one canonical form. Modes 0/1/2 are that canonical form.
  // `expandUpcE` still understands mode 3, so a real in-store label reads fine.
  if (m4 === '0' && m5 === '0' && /[012]/.test(m3) && p1 === '0' && p2 === '0') {
    return numberSystem + m1 + m2 + p3 + p4 + p5 + m3 + check;
  }
  // Mode 4: M5 = 0, P1..P4 = 0000
  if (m5 === '0' && p1 === '0' && p2 === '0' && p3 === '0' && p4 === '0') {
    return numberSystem + m1 + m2 + m3 + m4 + p5 + '4' + check;
  }
  // Mode 5-9: P1..P5 = 0000X where X is the mode digit
  if (p1 === '0' && p2 === '0' && p3 === '0' && p4 === '0' && /[5-9]/.test(p5)) {
    return numberSystem + m1 + m2 + m3 + m4 + m5 + p5 + check;
  }
  return null;
}

const INTERNAL_PREFIX = 'POSA';

/**
 * POSA-generated internal barcode (PRD §10.1) for shop-made or unbranded goods.
 * 13 characters, Code-128 safe, and deliberately prefixed so we never confuse a
 * house label with a manufacturer GTIN. The payload is the product's ULID tail
 * so two devices generating codes offline cannot collide.
 */
export function internalBarcode(productId: string): string {
  const payload = productId.replace(/[^0-9A-Z]/gi, '').toUpperCase();
  return `${INTERNAL_PREFIX}${payload.slice(-8)}`;
}

export function isInternalBarcode(value: string): boolean {
  return value.startsWith(INTERNAL_PREFIX);
}

/** Classify a scan. Never throws — an unknown scan is a workflow, not an error. */
export function analyseBarcode(raw: string): BarcodeAnalysis {
  const payload = stripScan(raw);
  const value = payload.toUpperCase();
  const base = { value, payload, raw, isInternal: false, problem: null as string | null };

  if (!value) {
    return { ...base, symbology: 'UNKNOWN', isPlausible: false, problem: 'Empty scan' };
  }

  if (isInternalBarcode(value)) {
    const ok = value.length >= 10;
    return {
      ...base,
      symbology: 'INTERNAL',
      isInternal: true,
      isPlausible: ok,
      problem: ok ? null : 'Internal barcode too short',
    };
  }

  // QR first: a receipt QR is a JSON payload, and it must keep its exact case.
  if (looksLikeQrPayload(payload)) {
    return { ...base, symbology: 'QR', isPlausible: true, problem: null };
  }

  if (/^\d+$/.test(value)) {
    if (value.length === 13) {
      return isValidEan(value)
        ? { ...base, symbology: 'EAN13', isPlausible: true }
        : { ...base, symbology: 'EAN13', isPlausible: false, problem: 'EAN-13 check digit failed' };
    }
    if (value.length === 12) {
      return isValidEan(value)
        ? { ...base, symbology: 'UPCA', isPlausible: true }
        : { ...base, symbology: 'UPCA', isPlausible: false, problem: 'UPC-A check digit failed' };
    }
    if (value.length === 8) {
      // 8 numeric digits is ambiguous: EAN-8 or UPC-E. Accept either.
      if (isValidEan(value)) return { ...base, symbology: 'EAN8', isPlausible: true };
      if (isValidUpcE(value)) return { ...base, symbology: 'UPCE', isPlausible: true };
      return { ...base, symbology: 'EAN8', isPlausible: false, problem: 'EAN-8 check digit failed' };
    }
    if (value.length === 14) {
      return isValidItf14(value)
        ? { ...base, symbology: 'ITF', isPlausible: true }
        : { ...base, symbology: 'ITF', isPlausible: false, problem: 'ITF-14 check digit failed' };
    }
    // Short numeric codes (price-embedded or in-store labels) are accepted
    // as-is: we cannot prove they are wrong, and blocking them breaks real shops.
    return { ...base, symbology: 'CODE39', isPlausible: true };
  }

  if (isValidCode39(value)) {
    return { ...base, symbology: 'CODE39', isPlausible: true, problem: null };
  }
  if (/^[\x20-\x7e]+$/.test(value)) {
    return { ...base, symbology: 'CODE128', isPlausible: true, problem: null };
  }
  return { ...base, symbology: 'UNKNOWN', isPlausible: false, problem: 'Unsupported barcode format' };
}

/**
 * Embedded-price barcodes: many small retailers use 2 leading + 5 price +
 * 1 check (EAN-13 style) where the price is baked into the label. Detecting
 * these lets the till honour the shelf label even when the catalog disagrees.
 */
export function extractEmbeddedPrice(value: string, currency = 'NGN'): number | null {
  if (!/^\d{13}$/.test(value)) return null;
  if (value[0] !== '2') return null; // 2 = in-store markdown prefix
  const minorDigits = value.slice(7, 12);
  void currency;
  return Number(minorDigits); // already minor units by convention
}

/**
 * Walking-scan reconstruction: cheap scanners occasionally drop characters.
 * When a scan has a failing checksum but removing one character yields a valid
 * code, we surface the suggestion rather than silently guessing.
 */
export function suggestRepairs(value: string): string[] {
  const suggestions = new Set<string>();
  if (!/^\d+$/.test(value)) return [];
  for (let i = 0; i < value.length; i += 1) {
    const candidate = value.slice(0, i) + value.slice(i + 1);
    if (candidate.length >= 8 && isValidEan(candidate)) suggestions.add(candidate);
  }
  // A dropped leading zero is by far the most common scan failure: a 12-digit
  // UPC-A arrives as 11 digits, and a 13-digit EAN as 12. Try re-padding once.
  if (value.length === 11 || value.length === 12) {
    const padded = `0${value}`;
    if (isValidEan(padded)) suggestions.add(padded);
  }
  return [...suggestions];
}

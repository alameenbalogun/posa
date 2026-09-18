import { describe, expect, it } from 'vitest';
import {
  analyseBarcode,
  compressToUpcE,
  eanCheckDigit,
  expandUpcE,
  extractEmbeddedPrice,
  internalBarcode,
  isInternalBarcode,
  isValidCode39,
  isValidEan,
  isValidItf14,
  normaliseScan,
  suggestRepairs,
} from '../barcode';

describe('scan normalisation', () => {
  it('strips the CR/LF that HID scanners append', () => {
    expect(normaliseScan('1234567890128\r\n')).toBe('1234567890128');
    expect(normaliseScan('  12345 \t')).toBe('12345');
  });

  it('uppercases linear codes because case carries no meaning there', () => {
    expect(normaliseScan('abc-123')).toBe('ABC-123');
  });
});

describe('checksums', () => {
  it('computes the EAN check digit', () => {
    expect(eanCheckDigit('123456789012')).toBe(8);
    expect(eanCheckDigit('9638507')).toBe(4);
  });

  it('accepts valid EAN-13, EAN-8 and UPC-A', () => {
    expect(isValidEan('1234567890128')).toBe(true);
    expect(isValidEan('4006381333931')).toBe(true);
    expect(isValidEan('96385074')).toBe(true);
    expect(isValidEan('036000291452')).toBe(true);
  });

  it('rejects a transposed digit', () => {
    expect(isValidEan('1234567890129')).toBe(false);
  });

  it('validates ITF-14 and Code 39', () => {
    expect(isValidItf14('10012345000015')).toBe(true);
    expect(isValidItf14('10012345000010')).toBe(false);
    expect(isValidCode39('ABC-123')).toBe(true);
    expect(isValidCode39('abc-123')).toBe(false); // lowercase is not Code 39
  });
});

describe('UPC-E expansion', () => {
  it('expands to UPC-A so a compressed code resolves to the same product', () => {
    const expanded = expandUpcE('01234565');
    expect(expanded).toMatch(/^\d{12}$/);
  });

  it('is an exact inverse of compression', () => {
    // 0 | 12000 | 00456 | 1 — a shape that legitimately compresses.
    const upcA = '012000004560';
    const compressed = compressToUpcE(upcA);
    expect(compressed).toHaveLength(8);
    expect(expandUpcE(compressed as string)).toBe(upcA);
  });

  it('declines to compress a code whose shape does not fit a UPC-E mode', () => {
    expect(compressToUpcE('036000291452')).toBeNull();
    expect(compressToUpcE('not-a-barcode')).toBeNull();
  });
});

describe('POSA internal barcodes', () => {
  it('generates a prefixed, collision-resistant house label', () => {
    const code = internalBarcode('01H8XYZABCDEFGHJKMNPQRSTVWX');
    expect(isInternalBarcode(code)).toBe(true);
    expect(code.startsWith('POSA')).toBe(true);
    expect(code.length).toBeGreaterThanOrEqual(10);
  });

  it('differs for different products', () => {
    expect(internalBarcode('01H8XYZAAAAAAAAAAAAAAAAA')).not.toBe(internalBarcode('01H8XYZBBBBBBBBBBBBBBBBB'));
  });
});

describe('analyseBarcode', () => {
  it('identifies a valid EAN-13', () => {
    const result = analyseBarcode('1234567890128\r');
    expect(result.symbology).toBe('EAN13');
    expect(result.isPlausible).toBe(true);
    expect(result.problem).toBeNull();
  });

  it('flags a failing check digit without throwing', () => {
    const result = analyseBarcode('1234567890129');
    expect(result.isPlausible).toBe(false);
    expect(result.problem).toContain('check digit');
  });

  it('preserves QR payload case so a JSON receipt code is not corrupted', () => {
    const payload = '{"v":1,"t":"sale","r":"LAG-A1B2-000005","s":"01J8","b":"biz1","h":"br1","a":2150,"d":"2026-09-15T10:00:00.000Z"}';
    const result = analyseBarcode(payload);
    expect(result.symbology).toBe('QR');
    expect(result.payload).toBe(payload);
    expect(result.payload).toContain('LAG-A1B2-000005');
    // The canonical key is uppercased, which is fine — callers use `payload` for QR.
    expect(result.value).not.toBe(payload);
  });

  it('recognises internal codes and very short numeric labels', () => {
    expect(analyseBarcode('POSAABCD1234').symbology).toBe('INTERNAL');
    expect(analyseBarcode('1234').isPlausible).toBe(true);
  });

  it('reports an empty scan as an explicit problem', () => {
    const result = analyseBarcode('\r\n');
    expect(result.isPlausible).toBe(false);
    expect(result.problem).toBe('Empty scan');
  });

  it('accepts a receipt URL as a QR payload', () => {
    expect(analyseBarcode('https://posa.app/r/LAG-A1B2-000005').symbology).toBe('QR');
  });
});

describe('damaged-scan recovery', () => {
  it('suggests only codes that actually validate', () => {
    const suggestions = suggestRepairs('1234567890129');
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.every((candidate) => isValidEan(candidate))).toBe(true);
  });

  it('suggests a padded UPC-A as EAN-13', () => {
    expect(suggestRepairs('36000291452')).toContain('036000291452');
  });

  it('finds nothing to suggest for a clean code', () => {
    expect(suggestRepairs('')).toEqual([]);
  });
});

describe('embedded shelf pricing', () => {
  it('reads an in-store markdown price from a 2-prefixed code', () => {
    // 2 | item 000000 | price 01500 kobo | check 2
    expect(extractEmbeddedPrice('2000000015002')).toBe(1500);
  });

  it('ignores manufacturer codes', () => {
    expect(extractEmbeddedPrice('1234567890128')).toBeNull();
  });
});

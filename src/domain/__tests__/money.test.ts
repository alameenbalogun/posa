import { describe, expect, it } from 'vitest';
import {
  add,
  distribute,
  formatMoney,
  fromMajor,
  parseMoney,
  percentOf,
  scale,
  sub,
  sum,
  toMajor,
  type Minor,
} from '../money';

const m = (value: number): Minor => value as Minor;

describe('money: conversion', () => {
  it('converts major to minor units without floating point drift', () => {
    expect(fromMajor(1500)).toBe(150_000);
    expect(fromMajor(1500.5)).toBe(150_050);
    // The classic float failure: 1.005 * 100 === 100.49999999999999
    expect(fromMajor(1.005)).toBe(101);
    expect(fromMajor(0.615)).toBe(62);
    expect(fromMajor(-1.005)).toBe(-101);
  });

  it('round-trips major and minor', () => {
    expect(toMajor(m(150_050))).toBe(1500.5);
  });

  it('handles currencies with no minor unit', () => {
    expect(fromMajor(500, 'XOF')).toBe(500);
    expect(toMajor(m(500), 'XOF')).toBe(500);
  });

  it('rejects unparseable input instead of silently booking zero', () => {
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('abc')).toBeNull();
    expect(parseMoney('-')).toBeNull();
    expect(parseMoney('₦1,500.50')).toBe(150_050);
    expect(parseMoney('1 500')).toBe(150_000);
  });
});

describe('money: scaling', () => {
  it('scales with half-away-from-zero rounding', () => {
    expect(scale(m(1000), 0.075)).toBe(75);
    expect(scale(m(2150), 1 / 1.075)).toBe(2000);
    expect(scale(m(-1000), 0.075)).toBe(-75);
  });

  it('computes percentages in basis points safely', () => {
    expect(percentOf(m(2000), 7.5)).toBe(150);
    expect(percentOf(m(999), 33.33)).toBe(333);
  });
});

describe('money: exact distribution', () => {
  it('never loses or invents a kobo when splitting a discount', () => {
    const parts = distribute(m(1000), [1000, 1000, 1000]);
    expect(parts).toEqual([334, 333, 333]);
    expect(sum(parts)).toBe(1000);
  });

  it('distributes proportionally to weight', () => {
    const parts = distribute(m(1000), [1, 3]);
    expect(sum(parts)).toBe(1000);
    expect(parts[1]).toBeGreaterThan(parts[0]);
  });

  it('is deterministic for identical inputs', () => {
    const a = distribute(m(7777), [111, 222, 333, 444]);
    const b = distribute(m(7777), [111, 222, 333, 444]);
    expect(a).toEqual(b);
    expect(sum(a)).toBe(7777);
  });

  it('handles refusals and degenerate weights', () => {
    expect(distribute(m(100), [])).toEqual([]);
    const even = distribute(m(100), [0, 0, 0]);
    expect(sum(even)).toBe(100);
  });

  it('handles negative totals for refunds', () => {
    const parts = distribute(m(-1000), [1000, 1000, 1000]);
    expect(sum(parts)).toBe(-1000);
  });
});

describe('money: arithmetic helpers', () => {
  it('adds and subtracts integer minor units only', () => {
    expect(add(m(1), m(2), m(3))).toBe(6);
    expect(sub(m(10), m(4))).toBe(6);
    expect(sum([m(1), m(2)])).toBe(3);
  });
});

describe('money: formatting', () => {
  it('formats Naira with the symbol in front', () => {
    expect(formatMoney(m(150_000))).toBe('₦1,500.00');
    expect(formatMoney(m(150_000), { compact: true })).toBe('₦1,500');
  });

  it('formats negatives as a signed prefix', () => {
    expect(formatMoney(m(-2500))).toBe('-₦25.00');
  });

  it('supports suffix-currency conventions', () => {
    expect(formatMoney(m(150_000), { currency: 'KES' })).toContain('KSh');
  });

  it('can omit the symbol for dense tables', () => {
    expect(formatMoney(m(1234), { bare: true })).toBe('12.34');
  });
});

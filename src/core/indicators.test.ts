import { describe, it, expect } from 'vitest';
import { ema, macd } from './indicators';

describe('EMA', () => {
  it('seeds from first close and warms up', () => {
    const out = ema([1, 2, 3, 4, 5], 3);
    // first value = close[0]
    expect(out[0]).toBe(1);
    // warm-up: index < period-1 (i.e. index 0,1) are null? we seed 0 as value.
    // With period 3: values start being "valid" at i>=2.
    expect(out[1]).toBe(null);
    expect(out[2]).not.toBe(null);
    // EMA after 3 bars is between 2 and 3
    expect(out[2]!).toBeGreaterThan(2);
    expect(out[2]!).toBeLessThan(3);
  });

  it('handles empty input', () => {
    expect(ema([], 5)).toEqual([]);
  });

  it('EMA(1) equals closes', () => {
    const closes = [10, 20, 30];
    const out = ema(closes, 1);
    expect(out).toEqual([10, 20, 30]);
  });
});

describe('MACD', () => {
  it('produces aligned macd/signal/hist', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5);
    const out = macd(closes, 12, 26, 9);
    expect(out).toHaveLength(60);
    // early values warm up (EMA slow not yet seeded by period 26)
    expect(out[10].macd).toBe(null);
    expect(out[30].macd).not.toBe(null);
    // late values have all three defined
    const last = out[out.length - 1];
    expect(last.macd).not.toBe(null);
    expect(last.signal).not.toBe(null);
    expect(last.hist).not.toBe(null);
    // In a steady uptrend macd is positive and hist eventually positive
    expect(last.macd!).toBeGreaterThan(0);
  });

  it('MACD of constant series is zero', () => {
    const closes = Array.from({ length: 40 }, () => 50);
    const out = macd(closes, 12, 26, 9);
    const last = out[out.length - 1];
    expect(last.macd!).toBeCloseTo(0, 8);
    expect(last.signal!).toBeCloseTo(0, 8);
    expect(last.hist!).toBeCloseTo(0, 8);
  });
});

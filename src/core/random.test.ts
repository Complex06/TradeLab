import { describe, it, expect } from 'vitest';
import { nyseOpenMs, findMarketOpenIndex, randomTradingDay, makeRng, resolveStartIndex } from './random';

describe('nyseOpenMs (DST aware)', () => {
  it('summer (EDT, UTC-4): Beijing 21:30', () => {
    // Local calendar date 2026-07-15 → NY 2026-07-15 09:30 EDT = 13:30 UTC = 21:30 Beijing
    const d = new Date(2026, 6, 15, 0, 0); // local midnight
    const open = nyseOpenMs(d);
    const iso = new Date(open).toISOString();
    expect(iso).toBe('2026-07-15T13:30:00.000Z');
  });

  it('winter (EST, UTC-5): Beijing 22:30', () => {
    // Local calendar date 2026-01-15 → NY 2026-01-15 09:30 EST = 14:30 UTC = 22:30 Beijing
    const d = new Date(2026, 0, 15, 0, 0);
    const open = nyseOpenMs(d);
    const iso = new Date(open).toISOString();
    expect(iso).toBe('2026-01-14T14:30:00.000Z');
  });
});

describe('findMarketOpenIndex', () => {
  it('returns the bar containing the NYSE open', () => {
    // Build 5m bars for 2026-07-15 UTC (summer). Open at 13:30 UTC.
    const start = Date.UTC(2026, 6, 15, 0, 0);
    const tfMs = 5 * 60 * 1000;
    const bars = Array.from({ length: 24 * 12 }, (_, i) => ({
      t: start + i * tfMs,
      o: 1,
      h: 1,
      l: 1,
      c: 1,
    }));
    const date = new Date(2026, 6, 15, 0, 0);
    const idx = findMarketOpenIndex(bars, tfMs, date);
    // Bar at 13:30 UTC = index (13.5h * 12 bars/h) = 162
    expect(idx).toBe(162);
  });

  it('aligns to the interval boundary for 10m/15m/30m', () => {
    // Same July 15 2026 series; open at 13:30 UTC (= 21:30 Beijing, summer).
    const start = Date.UTC(2026, 6, 15, 0, 0);
    const date = new Date(2026, 6, 15, 0, 0);
    for (const mins of [10, 15, 30]) {
      const tfMs = mins * 60 * 1000;
      const bars = Array.from({ length: (24 * 60) / mins }, (_, i) => ({
        t: start + i * tfMs,
        o: 1,
        h: 1,
        l: 1,
        c: 1,
      }));
      const idx = findMarketOpenIndex(bars, tfMs, date);
      expect(new Date(bars[idx].t).toISOString()).toBe('2026-07-15T13:30:00.000Z');
    }
  });

  it('returns -1 when date is before the series', () => {
    const start = Date.UTC(2026, 6, 15, 0, 0);
    const bars = Array.from({ length: 10 }, (_, i) => ({ t: start + i * 300000, o: 1, h: 1, l: 1, c: 1 }));
    const date = new Date(2020, 0, 1);
    expect(findMarketOpenIndex(bars, 300000, date)).toBe(-1);
  });
});

describe('resolveStartIndex (market-open)', () => {
  it('re-draws out-of-range days until the market-open bar is usable', () => {
    // One year of 5m bars ending 2026-07-31 (HYPE-like coverage). Today is
    // 2026-08-05; seed 4 previously drew a future day (2026-08-24) and fell
    // back to a random bar (15:55) instead of the market open.
    const start = Date.UTC(2025, 7, 1);
    const bars = Array.from({ length: 105120 }, (_, i) => ({
      t: start + i * 300000,
      o: 1,
      h: 1,
      l: 1,
      c: 1,
    }));
    const today = new Date(2026, 7, 5, 21, 0);
    const res = resolveStartIndex(bars, 300000, 'market-open', null, makeRng(4), today, 200);
    const bar = bars[res.startIndex];
    expect(new Date(bar.t).getUTCHours()).toBe(13);
    expect(new Date(bar.t).getUTCMinutes()).toBe(30);
  });

  it('always lands on the market-open bar across many seeds', () => {
    const start = Date.UTC(2025, 7, 1);
    const bars = Array.from({ length: 105120 }, (_, i) => ({
      t: start + i * 300000,
      o: 1,
      h: 1,
      l: 1,
      c: 1,
    }));
    const today = new Date(2026, 7, 5, 21, 0);
    for (let seed = 0; seed < 500; seed += 1) {
      const res = resolveStartIndex(bars, 300000, 'market-open', null, makeRng(seed), today, 200);
      const bar = bars[res.startIndex];
      const hours = new Date(bar.t).getUTCHours();
      const minutes = new Date(bar.t).getUTCMinutes();
      expect([hours, minutes]).toEqual([13, 30]);
    }
  });
});

describe('randomTradingDay', () => {
  it('never returns a weekend', () => {
    const rng = makeRng(42);
    const around = new Date();
    for (let i = 0; i < 50; i++) {
      const d = randomTradingDay(rng, around);
      expect([0, 6]).not.toContain(d.getDay());
    }
  });
});

import { describe, it, expect } from 'vitest';
import { nyseOpenMs, findMarketOpenIndex, randomTradingDay, makeRng } from './random';

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

  it('returns -1 when date is before the series', () => {
    const start = Date.UTC(2026, 6, 15, 0, 0);
    const bars = Array.from({ length: 10 }, (_, i) => ({ t: start + i * 300000, o: 1, h: 1, l: 1, c: 1 }));
    const date = new Date(2020, 0, 1);
    expect(findMarketOpenIndex(bars, 300000, date)).toBe(-1);
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

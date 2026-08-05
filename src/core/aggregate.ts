// Aggregation: only 5m bars are stored; higher timeframes are derived at
// runtime by strict grouping (all Binance timeframes are multiples of 5m,
// so aggregation is lossless). See PLAN.md D28/D29.

import type { Bar } from './types';

export const TF_OPTIONS = [
  { label: '5m', ms: 5 * 60 * 1000 },
  { label: '10m', ms: 10 * 60 * 1000 },
  { label: '15m', ms: 15 * 60 * 1000 },
  { label: '30m', ms: 30 * 60 * 1000 },
  { label: '1h', ms: 60 * 60 * 1000 },
  { label: '4h', ms: 4 * 60 * 60 * 1000 },
  { label: '1d', ms: 24 * 60 * 60 * 1000 },
] as const;

export function tfLabel(ms: number): string {
  return TF_OPTIONS.find((t) => t.ms === ms)?.label ?? `${ms}ms`;
}

export function is5mMultiple(tfMs: number): boolean {
  const base = 5 * 60 * 1000;
  return tfMs % base === 0;
}

/** Aggregate an array of 5m bars into bars of interval tfMs.
 *  Requires bars sorted ascending by t; interval must be a multiple of 5m.
 *  Partial leading/trailing groups are dropped to keep strict alignment. */
export function aggregate5m(bars: Bar[], tfMs: number): Bar[] {
  if (tfMs === 5 * 60 * 1000) return bars;
  if (!is5mMultiple(tfMs)) throw new Error(`tfMs ${tfMs} is not a multiple of 5m`);
  const group = tfMs / (5 * 60 * 1000);
  const out: Bar[] = [];
  const count = bars.length;
  // Drop leading partial group so groups align to tfMs boundary.
  let start = 0;
  const firstT = bars[0]?.t ?? 0;
  if (firstT % tfMs !== 0) {
    start = group - (firstT % tfMs) / (5 * 60 * 1000);
  }
  for (let i = start; i + group <= count; i += group) {
    const o = bars[i].o;
    let h = -Infinity;
    let l = Infinity;
    let c = bars[i].c;
    let v = 0;
    for (let j = 0; j < group; j++) {
      const b = bars[i + j];
      if (b.h > h) h = b.h;
      if (b.l < l) l = b.l;
      c = b.c;
      v += b.v;
    }
    out.push({ t: bars[i].t, o, h, l, c, v });
  }
  return out;
}

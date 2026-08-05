// Technical indicators: EMA and MACD. Pure functions over close prices.

/** Exponential moving average over closes. Leading NaNs for warm-up. */
export function ema(closes: number[], period: number): (number | null)[] {
  const k = 2 / (period + 1);
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length === 0 || period <= 0) return out;
  let prev = closes[0];
  out[0] = closes[0];
  for (let i = 1; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
    out[i] = i >= period - 1 ? prev : null; // warm-up until `period` bars
  }
  return out;
}

export interface MacdPoint {
  macd: number | null;
  signal: number | null;
  hist: number | null;
}

/** MACD: MACD = EMA_fast − EMA_slow; signal = EMA(macd); hist = macd − signal. */
export function macd(closes: number[], fast = 12, slow = 26, signalPeriod = 9): MacdPoint[] {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const n = closes.length;
  const out: MacdPoint[] = [];
  // Build the raw macd line first.
  const macdLine: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (emaFast[i] !== null && emaSlow[i] !== null) {
      macdLine[i] = emaFast[i]! - emaSlow[i]!;
    }
  }
  // Signal = EMA of the non-null macd values.
  const signal: (number | null)[] = new Array(n).fill(null);
  // We need contiguous macd to seed EMA; find first valid index.
  let start = -1;
  for (let i = 0; i < n; i++) {
    if (macdLine[i] !== null) {
      start = i;
      break;
    }
  }
  if (start >= 0) {
    const k = 2 / (signalPeriod + 1);
    let prev = macdLine[start]!;
    signal[start] = prev;
    for (let i = start + 1; i < n; i++) {
      prev = macdLine[i]! * k + prev * (1 - k);
      signal[i] = i >= start + signalPeriod - 1 ? prev : null;
    }
  }
  for (let i = 0; i < n; i++) {
    const m = macdLine[i];
    const s = signal[i];
    out.push({
      macd: m,
      signal: s,
      hist: m !== null && s !== null ? m - s : null,
    });
  }
  return out;
}

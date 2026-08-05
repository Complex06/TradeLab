// Deterministic PRNG (mulberry32) + practice-start resolution (random time,
// random symbol, market-open mode). All randomness is seeded so a practice
// is reproducible from its snapshot. See PLAN.md D21–D27.

/** mulberry32 seeded PRNG. Returns a function yielding floats in [0,1). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInt(rng: () => number, min: number, maxExclusive: number): number {
  return Math.floor(rng() * (maxExclusive - min)) + min;
}

/** Market-open: NYSE trading days only (skip Sat/Sun). Returns a start-of-day
 *  timestamp (local midnight) for a random weekday near `around`. */
export function randomTradingDay(rng: () => number, around: Date): Date {
  let d = new Date(around);
  // Walk backwards to a weekday, then randomly offset -120..+30 days.
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  const offset = randomInt(rng, -120, 31);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset);
  // If the random offset lands on a weekend, shift to Monday.
  let dd = target.getDay();
  if (dd === 0) target.setDate(target.getDate() + 1);
  else if (dd === 6) target.setDate(target.getDate() + 2);
  return target;
}

/** UTC offset (minutes west of UTC) of America/New_York at a UTC instant. */
function nyOffsetUtcMinAt(utcMs: number): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(utcMs));
  const map: Record<string, number> = {};
  for (const x of p) if (x.type !== 'literal') map[x.type] = parseInt(x.value, 10);
  const asUtc = Date.UTC(map.year, map.month - 1, map.day, map.hour, map.minute, map.second);
  return Math.round((utcMs - asUtc) / 60000);
}

/** NYSE regular open = 09:30 America/New_York on the NY calendar day matching
 *  the input Date's LOCAL calendar date (DST aware). Returns UTC ms. */
export function nyseOpenMs(date: Date): number {
  // Local calendar date of the input.
  const y = date.getFullYear();
  const m = date.getMonth();
  const d = date.getDate();
  // Noon probe (local): avoids DST transitions around midnight, and pins the
  // NY calendar day that corresponds to this local date.
  const probeLocal = new Date(y, m, d, 12, 0);
  const probeUtc = probeLocal.getTime();
  const offMin = nyOffsetUtcMinAt(probeUtc);
  // NY date at the probe instant.
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(probeUtc));
  const pm: Record<string, number> = {};
  for (const x of p) if (x.type !== 'literal') pm[x.type] = parseInt(x.value, 10);
  // Midnight (UTC) of that NY date.
  const nyMidnightUtc = Date.UTC(pm.year, pm.month - 1, pm.day, 0, 0) + offMin * 60000;
  return nyMidnightUtc + 9.5 * 3600 * 1000;
}

/** Find the index of the bar whose interval contains the NYSE open for `date`,
 *  for a bar series with given tfMs. Returns -1 if the date is out of range. */
export function findMarketOpenIndex(bars: { t: number }[], tfMs: number, date: Date): number {
  const openMs = nyseOpenMs(date);
  // Binance bars start at interval boundaries; the bar containing openMs is
  // the one starting at floor(openMs / tfMs) * tfMs (UTC-aligned).
  const target = openMs - (openMs % tfMs);
  // Binary search.
  let lo = 0;
  let hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t < target) lo = mid + 1;
    else if (bars[mid].t > target) hi = mid - 1;
    else return mid;
  }
  // Not found exactly: find closest start <= target.
  if (hi < 0) return -1;
  return hi;
}

export interface StartResolution {
  startIndex: number;
  historyCount: number;
}

/** Resolve the practice start bar index from settings + a random draw.
 *  mode: 'custom' | 'random' | 'market-open' */
export function resolveStartIndex(
  bars: { t: number }[],
  tfMs: number,
  mode: 'custom' | 'random' | 'market-open',
  customIndex: number | null,
  rng: () => number,
  today: Date,
  historyCount: number
): StartResolution {
  if (bars.length === 0) throw new Error('empty dataset');
  const lastUsable = Math.max(0, bars.length - 1 - historyCount);
  let startIndex: number;
  if (mode === 'custom') {
    startIndex = Math.max(0, Math.min(customIndex ?? 0, lastUsable));
  } else if (mode === 'market-open') {
    // The drawn day may be out of the dataset's coverage (e.g. a future date,
    // or before the symbol was listed). Re-draw until a day whose market-open
    // bar is within the usable range; bounded attempts keep this deterministic
    // and fast for any data window.
    let idx = -1;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const day = randomTradingDay(rng, today);
      const candidate = findMarketOpenIndex(bars, tfMs, day);
      if (candidate >= 0 && candidate <= lastUsable) {
        idx = candidate;
        break;
      }
    }
    // Last resort (e.g. dataset shorter than the usable window): random start.
    startIndex = idx >= 0 ? idx : randomInt(rng, 0, Math.max(1, lastUsable + 1));
  } else {
    startIndex = randomInt(rng, 0, Math.max(1, lastUsable + 1));
  }
  return { startIndex, historyCount };
}

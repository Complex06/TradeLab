// Generates a synthetic offline data pack so the app can be used for testing
// immediately without downloading real Binance data. Produces a 5m-interval
// JSON pack file (data/example.pack.json) that you import in the app.
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIVE_MIN = 5 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Deterministic PRNG so the generated pack is reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random walk with occasional trend waves — produces realistic OHLC. */
function generateBars(symbol, startTs, days, seed) {
  const rng = mulberry32(seed);
  const n = Math.floor((days * DAY) / FIVE_MIN);
  const bars = [];
  let price = 100 + rng() * 200; // starting price per symbol
  let drift = 0;
  for (let i = 0; i < n; i++) {
    // regime switch every ~300 bars
    if (i % 300 === 0) drift = (rng() - 0.5) * 0.004;
    const shock = (rng() - 0.5) * 0.01;
    const open = price;
    const change = drift + shock;
    const close = Math.max(1, open * (1 + change));
    const high = Math.max(open, close) * (1 + rng() * 0.003);
    const low = Math.min(open, close) * (1 - rng() * 0.003);
    const vol = rng() * 50;
    bars.push([startTs + i * FIVE_MIN, round(open), round(high), round(low), round(close), round(vol)]);
    price = close;
  }
  return bars;
}

function round(x) {
  return Math.round(x * 1e6) / 1e6;
}

const SYMBOLS = [
  ['BTCUSDT', 64000, 11],
  ['ETHUSDT', 3400, 7],
  ['SOLUSDT', 150, 13],
  ['BNBUSDT', 590, 17],
  ['XRPUSDT', 0.55, 3],
  ['DOGEUSDT', 0.13, 5],
];

// Use a fixed end so the pack is stable across runs.
const endTs = Date.now();
const days = 365; // 1 year
const startTs = endTs - days * DAY;

const datasets = SYMBOLS.map(([symbol, basePrice, seed]) => ({
  symbol,
  bars: generateBars(symbol, startTs, days, seed * 7919),
}));

const pack = {
  version: 1,
  generatedAt: endTs,
  interval: '5m',
  datasets,
};

const outPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'example.pack.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(pack));
const totalBars = datasets.reduce((a, d) => a + d.bars.length, 0);
console.log(`wrote ${outPath}`);
console.log(`  symbols: ${datasets.map((d) => d.symbol).join(', ')}`);
console.log(`  bars/symbol: ${datasets[0].bars.length}, total: ${totalBars}`);

// Downloads Binance USDT-M futures klines from the public data archive
// (data.binance.vision) into a data pack file the app can import.
//
// Usage:
//   node scripts/download-binance-data.mjs --symbols BTCUSDT,ETHUSDT --days 365
//   node scripts/download-binance-data.mjs --all-top --days 730
//
// The data.binance.vision archive exposes monthly files per symbol/interval:
//   https://data.binance.vision/data/futures/um/monthly/klines/{symbol}/5m/{symbol}-5m-YYYY-MM.zip
// Each zip contains a CSV: open_time, open, high, low, close, volume, close_time, ...
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const FIVE_MIN = 5 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

const BASE = 'https://data.binance.vision/data/futures/um/monthly/klines';
const TOP_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'BNBUSDT',
  'SOLUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'ADAUSDT',
  'AVAXUSDT',
  'LINKUSDT',
  'LTCUSDT',
  'BCHUSDT',
  'NEARUSDT',
];

const KNOWN = new Set(TOP_SYMBOLS);

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  let symbols = get('--symbols')?.split(',') ?? [];
  let days = parseInt(get('--days') ?? '365', 10);
  let endDate = new Date();
  const allTop = args.includes('--all-top');
  if (allTop) symbols = TOP_SYMBOLS;
  if (symbols.length === 0) {
    console.error('usage: --symbols BTCUSDT,ETHUSDT [--days 365] [--all-top]');
    process.exit(1);
  }
  return { symbols, days, endDate };
}

async function fetchZipBytes(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Minimal ZIP extraction: find the end-of-central-directory record, walk the
 * central directory for the single CSV entry, and inflate its deflate data.
 */
function unzipSingleEntry(zipBuf) {
  // EOCD signature: PK\x05\x06 (0x06054b50), search backwards from end.
  let eocd = -1;
  for (let i = zipBuf.length - 22; i >= 0; i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('no EOCD in zip');
  const cdOffset = zipBuf.readUInt32LE(eocd + 16);
  const cdSize = zipBuf.readUInt32LE(eocd + 12);
  const cdEnd = cdOffset + cdSize;
  let pos = cdOffset;
  let entry = null;
  while (pos < cdEnd) {
    if (zipBuf.readUInt32LE(pos) !== 0x02014b50) break; // central dir sig
    const method = zipBuf.readUInt16LE(pos + 10);
    const compSize = zipBuf.readUInt32LE(pos + 20);
    const localOffset = zipBuf.readUInt32LE(pos + 42);
    // Parse the local file header to find the actual data start.
    if (zipBuf.readUInt32LE(localOffset) !== 0x04034b50) {
      pos += 46 + zipBuf.readUInt16LE(pos + 28) + zipBuf.readUInt16LE(pos + 30);
      continue;
    }
    const lfNameLen = zipBuf.readUInt16LE(localOffset + 26);
    const lfExtraLen = zipBuf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lfNameLen + lfExtraLen;
    if (method === 0) {
      entry = zipBuf.subarray(dataStart, dataStart + compSize);
      break;
    } else if (method === 8) {
      entry = inflateRawSync(zipBuf.subarray(dataStart, dataStart + compSize));
      break;
    }
    pos += 46 + zipBuf.readUInt16LE(pos + 28) + zipBuf.readUInt16LE(pos + 30);
  }
  if (!entry) throw new Error('no CSV entry in zip');
  return entry;
}

/** Parse a Binance klines CSV row (first 6 fields matter). */
function parseCsv(buf) {
  const text = buf.toString('utf8');
  const rows = [];
  const endOf = (line) => line.indexOf('\n');
  let rest = text;
  // skip header if present
  let first = rest;
  const nl = rest.indexOf('\n');
  if (nl >= 0) first = rest.slice(0, nl);
  if (/open_time|openTime/i.test(first)) {
    rest = rest.slice(nl + 1);
  }
  for (const line of rest.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split(',');
    if (parts.length < 6) continue;
    rows.push([
      Number(parts[0]),
      Number(parts[1]),
      Number(parts[2]),
      Number(parts[3]),
      Number(parts[4]),
      Number(parts[5]),
    ]);
  }
  void endOf;
  return rows;
}

async function downloadSymbol(symbol, days, endDate) {
  const rows = [];
  const months = Math.ceil(days / 30);
  // Start from the LAST COMPLETED month (Binance only archives full months;
  // the current partial month has no zip yet).
  const start = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), 1));
  for (let m = 0; m < months; m++) {
    const d = new Date(start);
    d.setUTCMonth(start.getUTCMonth() - 1 - m);
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const url = `${BASE}/${symbol}/5m/${symbol}-5m-${ym}.zip`;
    try {
      const bytes = await fetchZipBytes(url);
      const csv = unzipSingleEntry(bytes);
      const monthRows = parseCsv(csv);
      rows.push(...monthRows);
      console.log(`  ${symbol} ${ym}: ${monthRows.length} bars`);
    } catch (e) {
      console.warn(`  ${symbol} ${ym}: skip (${e.message})`);
    }
  }
  // sort by open_time, dedupe
  rows.sort((a, b) => a[0] - b[0]);
  const seen = new Set();
  const deduped = rows.filter((r) => {
    if (seen.has(r[0])) return false;
    seen.add(r[0]);
    return true;
  });
  return deduped;
}

async function main() {
  const { symbols, days, endDate } = parseArgs();
  const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data');
  mkdirSync(outDir, { recursive: true });
  const datasets = [];
  for (const symbol of symbols) {
    if (!KNOWN.has(symbol)) {
      console.warn(`  ${symbol} not in known list, continuing anyway`);
    }
    console.log(`downloading ${symbol} (${days}d)`);
    const bars = await downloadSymbol(symbol, days, endDate);
    datasets.push({ symbol, bars });
    console.log(`  ${symbol}: ${bars.length} bars total`);
  }
  const pack = {
    version: 1,
    generatedAt: Date.now(),
    interval: '5m',
    datasets,
  };
  const outPath = resolve(outDir, `binance.pack.json`);
  writeFileSync(outPath, JSON.stringify(pack));
  console.log(`wrote ${outPath}`);
  const mb = (outPath.length / 1024 / 1024).toFixed(1);
  console.log(`  size: ~${mb} MB on disk (JSON)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// First-run data bootstrap: downloads the default symbols' recent 5m klines
// from Binance's public data archive and stores them in IndexedDB, so the app
// is fully offline afterwards. See PLAN.md §4.4.

import { saveDataset } from './db';
import type { Bar, Dataset } from '../core/types';

export const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'HYPEUSDT'];

const DAY = 24 * 60 * 60 * 1000;
const FIVE_MIN = 5 * 60 * 1000;
const BASE = 'https://data.binance.vision/data/futures/um/monthly/klines';
const API_BASE = 'https://data-api.binance.vision/api/v3/klines';

export interface DownloadProgress {
  done: number;
  total: number;
  message?: string;
}

export interface DownloadOptions {
  symbols?: string[];
  days?: number;
  onProgress?: (progress: DownloadProgress) => void;
}

/** Download (missing) default datasets and persist them one by one. */
export async function downloadDefaultDatasets(options: DownloadOptions = {}): Promise<Dataset[]> {
  const symbols = options.symbols ?? DEFAULT_SYMBOLS;
  const days = options.days ?? 365;
  const months = monthKeysSince(Date.now() - days * DAY);
  const total = symbols.length;
  const out: Dataset[] = [];
  let done = 0;

  for (const symbol of symbols) {
    const bars = await downloadSymbol(symbol, months, (message) => {
      options.onProgress?.({ done, total, message });
    });
    const dataset: Dataset = { symbol, bars, importedAt: Date.now() };
    await saveDataset(dataset);
    out.push(dataset);
    done += 1;
    options.onProgress?.({ done, total, message: `${symbol} 完成` });
  }
  return out;
}

/** Months like "2025-08" from `fromMs` through the current month, inclusive. */
function monthKeysSince(fromMs: number): string[] {
  const out: string[] = [];
  const cursor = new Date(fromMs);
  const now = new Date();
  while (
    cursor.getUTCFullYear() < now.getUTCFullYear() ||
    (cursor.getUTCFullYear() === now.getUTCFullYear() && cursor.getUTCMonth() <= now.getUTCMonth())
  ) {
    out.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}

async function downloadSymbol(
  symbol: string,
  months: string[],
  onMonth?: (message: string) => void
): Promise<Bar[]> {
  let zipError: string | null = null;
  try {
    const byTime = new Map<number, Bar>();
    for (const month of months) {
      onMonth?.(`${symbol} ${month}`);
      const csv = await fetchMonthCsv(symbol, month);
      // Binance doesn't publish the current (incomplete) month's archive and
      // symbols listed later have no files for earlier months: a 404 simply
      // means "no data for this month" — skip it, don't fail the symbol.
      if (csv === null) continue;
      for (const bar of parseCsvBars(csv)) {
        byTime.set(bar.t, bar);
      }
    }
    const bars = [...byTime.values()].sort((a, b) => a.t - b.t);
    if (bars.length === 0) throw new Error(`${symbol} 没有可用数据`);
    return bars;
  } catch (err) {
    zipError = err instanceof Error ? err.message : String(err);
  }

  // Fallback: paginated klines API (plain JSON, no unzip required). This
  // keeps the app working in webviews without DecompressionStream support
  // or where the monthly archive fetch fails.
  const fromMs =
    months.length > 0
      ? Date.UTC(Number(months[0].slice(0, 4)), Number(months[0].slice(5, 7)) - 1, 1)
      : Date.now() - 365 * DAY;
  try {
    const bars = await downloadSymbolViaApi(symbol, fromMs, Date.now(), onMonth);
    if (bars.length === 0) throw new Error(`${symbol} 没有可用数据`);
    return bars;
  } catch (apiErr) {
    throw new Error(
      `${symbol} 下载失败：月度数据包 ${zipError}；数据 API ${apiErr instanceof Error ? apiErr.message : String(apiErr)}`
    );
  }
}

async function downloadSymbolViaApi(
  symbol: string,
  fromMs: number,
  toMs: number,
  onMonth?: (message: string) => void
): Promise<Bar[]> {
  const out: Bar[] = [];
  let start = fromMs;
  while (start < toMs) {
    onMonth?.(`${symbol} API ${new Date(start).toISOString().slice(0, 7)}`);
    const url =
      `${API_BASE}?symbol=${encodeURIComponent(symbol)}&interval=5m&startTime=${start}&endTime=${toMs}&limit=1000`;
    const rows = await fetchJsonRows(url);
    if (rows.length === 0) break;
    for (const r of rows) {
      out.push({
        t: Number(r[0]),
        o: Number(r[1]),
        h: Number(r[2]),
        l: Number(r[3]),
        c: Number(r[4]),
        v: Number(r[5]),
      });
    }
    const next = Number(rows[rows.length - 1][0]) + FIVE_MIN;
    if (next <= start) break; // safety: never advance backwards
    start = next;
  }
  return out;
}

async function fetchJsonRows(url: string): Promise<Array<Array<string | number>>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Array<Array<string | number>>;
      if (!Array.isArray(data)) throw new Error('返回格式异常');
      return data;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fetchMonthCsv(symbol: string, month: string): Promise<string | null> {
  const url = `${BASE}/${symbol}/5m/${symbol}-5m-${month}.zip`;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(url);
      if (res.status === 404) return null; // month has no archive file
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
      const buf = await res.arrayBuffer();
      return await unzipFirstCsv(buf);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// --- minimal ZIP reader (EOCD + central directory + deflate-raw) -----------

export async function unzipFirstCsv(buf: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buf);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(bytes, view);
  const entry = findCsvEntry(bytes, view, eocd);
  return extractEntry(bytes, view, entry);
}

function findEocd(
  bytes: Uint8Array,
  view: DataView
): { cdOffset: number; cdSize: number; count: number } {
  const min = Math.max(0, bytes.length - 22 - 65535);
  for (let i = bytes.length - 22; i >= min; i -= 1) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      return {
        count: view.getUint16(i + 10, true),
        cdSize: view.getUint32(i + 12, true),
        cdOffset: view.getUint32(i + 16, true),
      };
    }
  }
  throw new Error('ZIP 文件格式错误（找不到 EOCD）');
}

function findCsvEntry(
  bytes: Uint8Array,
  view: DataView,
  eocd: { cdOffset: number; cdSize: number; count: number }
): { localOffset: number; method: number; compSize: number } {
  const end = Math.min(bytes.length, eocd.cdOffset + eocd.cdSize);
  let off = eocd.cdOffset;
  for (let i = 0; i < eocd.count && off + 46 <= end; i += 1) {
    if (view.getUint32(off, true) !== 0x02014b50) {
      throw new Error('ZIP 文件格式错误（中央目录损坏）');
    }
    const method = view.getUint16(off + 10, true);
    const compSize = view.getUint32(off + 20, true);
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const commentLen = view.getUint16(off + 32, true);
    const localOffset = view.getUint32(off + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(off + 46, off + 46 + nameLen));
    if (name.toLowerCase().endsWith('.csv')) {
      return { localOffset, method, compSize };
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('ZIP 文件格式错误（找不到 CSV）');
}

async function extractEntry(
  bytes: Uint8Array,
  view: DataView,
  entry: { localOffset: number; method: number; compSize: number }
): Promise<string> {
  const off = entry.localOffset;
  if (view.getUint32(off, true) !== 0x04034b50) {
    throw new Error('ZIP 文件格式错误（本地文件头损坏）');
  }
  const nameLen = view.getUint16(off + 26, true);
  const extraLen = view.getUint16(off + 28, true);
  const data = bytes.subarray(off + 30 + nameLen + extraLen, off + 30 + nameLen + extraLen + entry.compSize);
  if (entry.method === 0) return new TextDecoder().decode(data);
  if (entry.method === 8) return inflateRaw(data);
  throw new Error(`ZIP 压缩方式不支持（method=${entry.method}）`);
}

async function inflateRaw(data: Uint8Array): Promise<string> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持解压，请使用较新的 Chrome / Safari / Edge');
  }
  const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

// --- CSV parsing -----------------------------------------------------------

export function parseCsvBars(csv: string): Bar[] {
  const out: Bar[] = [];
  const lines = csv.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const f = line.split(',');
    if (f.length < 6) continue;
    const t = Number(f[0]);
    const o = Number(f[1]);
    const h = Number(f[2]);
    const l = Number(f[3]);
    const c = Number(f[4]);
    const v = Number(f[5]);
    if (
      !Number.isFinite(t) ||
      !Number.isFinite(o) ||
      !Number.isFinite(h) ||
      !Number.isFinite(l) ||
      !Number.isFinite(c)
    ) {
      continue; // also skips the header row ("open_time", ...)
    }
    out.push({ t, o, h, l, c, v: Number.isFinite(v) ? v : 0 });
  }
  return out;
}

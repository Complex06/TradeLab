// Tests for the first-run bootstrap: ZIP extraction + CSV parsing + storage.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { deflateRawSync } from 'node:zlib';

vi.mock('./db', () => ({
  saveDataset: vi.fn(async () => {}),
}));

import { downloadDefaultDatasets } from './download';
import { saveDataset } from './db';
import type { Bar } from '../core/types';

const CSV =
  'open_time,open,high,low,close,volume,close_time\n' +
  '1704067200000,42000,42100,41900,42050,12.5,1704067500000\n' +
  '1704067500000,42050,42200,41950,42100,8.2,1704067800000\n';

/** Build a minimal single-file ZIP (deflate-raw) in memory. */
function buildZip(csv: string): ArrayBuffer {
  const enc = new TextEncoder();
  const name = 'BTCUSDT-5m-2026-01.csv';
  const nameBytes = enc.encode(name);
  const raw = enc.encode(csv);
  const data = deflateRawSync(raw);

  // Local file header
  const local = new Uint8Array(30 + nameBytes.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true);
  lv.setUint16(8, 8, true); // deflate
  lv.setUint32(14, 0, true); // crc (unchecked)
  lv.setUint32(18, data.length, true);
  lv.setUint32(22, raw.length, true);
  lv.setUint16(26, nameBytes.length, true);
  lv.setUint16(28, 0, true);
  local.set(nameBytes, 30);

  // Central directory entry
  const cd = new Uint8Array(46 + nameBytes.length);
  const cv = new DataView(cd.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(4, 20, true);
  cv.setUint16(6, 20, true);
  cv.setUint16(10, 8, true);
  cv.setUint32(16, 0, true);
  cv.setUint32(20, data.length, true);
  cv.setUint32(24, raw.length, true);
  cv.setUint16(28, nameBytes.length, true);
  cv.setUint32(42, 0, true); // local header offset
  cd.set(nameBytes, 46);

  // End of central directory
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true); // entries on this disk
  ev.setUint16(10, 1, true); // total entries
  ev.setUint32(12, cd.length, true);
  ev.setUint32(16, local.length + data.length, true);

  const total = new Uint8Array(local.length + data.length + cd.length + eocd.length);
  total.set(local, 0);
  total.set(data, local.length);
  total.set(cd, local.length + data.length);
  total.set(eocd, local.length + data.length + cd.length);
  return total.buffer;
}

describe('downloadDefaultDatasets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to the klines API when monthly zips fail', async () => {
    let apiCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/data/futures/um/monthly/klines/')) {
        return new Response('', { status: 500 });
      }
      apiCalls += 1;
      if (apiCalls === 1) {
        return Response.json([
          [1704067200000, '42000', '42100', '41900', '42050', '12.5', 1704067500000, 0, 1, 0, 0, 0],
        ]);
      }
      return Response.json([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    await downloadDefaultDatasets({ symbols: ['BTCUSDT'], days: 40 });

    expect(saveDataset).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(saveDataset).mock.calls[0][0];
    expect(saved.symbol).toBe('BTCUSDT');
    expect(saved.bars).toEqual([
      { t: 1704067200000, o: 42000, h: 42100, l: 41900, c: 42050, v: 12.5 },
    ] satisfies Bar[]);

    vi.unstubAllGlobals();
  });

  it('skips months without an archive file (404) instead of failing', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('-2026-08.zip')) return new Response('', { status: 404 });
      return new Response(buildZip(CSV));
    });
    vi.stubGlobal('fetch', fetchMock);

    await downloadDefaultDatasets({ symbols: ['BTCUSDT'], days: 40 });

    // The current (incomplete) month was attempted and skipped.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('-2026-08.zip'))).toBe(true);
    expect(saveDataset).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(saveDataset).mock.calls[0][0];
    expect(saved.symbol).toBe('BTCUSDT');
    expect(saved.bars).toEqual([
      { t: 1704067200000, o: 42000, h: 42100, l: 41900, c: 42050, v: 12.5 },
      { t: 1704067500000, o: 42050, h: 42200, l: 41950, c: 42100, v: 8.2 },
    ] satisfies Bar[]);

    vi.unstubAllGlobals();
  });

  it('downloads monthly zips, parses bars, dedupes and persists the dataset', async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(buildZip(CSV)));
    vi.stubGlobal('fetch', fetchMock);

    const progress: Array<{ done: number; total: number }> = [];
    const datasets = await downloadDefaultDatasets({
      symbols: ['BTCUSDT'],
      days: 40, // ~3 calendar months as of the test date
      onProgress: (p) => progress.push(p),
    });

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).toMatch(
        /^https:\/\/data\.binance\.vision\/data\/futures\/um\/monthly\/klines\/BTCUSDT\/5m\/BTCUSDT-5m-\d{4}-\d{2}\.zip$/
      );
    }

    expect(saveDataset).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(saveDataset).mock.calls[0][0];
    expect(saved.symbol).toBe('BTCUSDT');
    expect(saved.bars).toEqual([
      { t: 1704067200000, o: 42000, h: 42100, l: 41900, c: 42050, v: 12.5 },
      { t: 1704067500000, o: 42050, h: 42200, l: 41950, c: 42100, v: 8.2 },
    ] satisfies Bar[]);
    expect(typeof saved.importedAt).toBe('number');

    expect(datasets).toHaveLength(1);
    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(progress[0]).toMatchObject({ done: 0, total: 1 });
    expect(progress[progress.length - 1]).toMatchObject({ done: 1, total: 1 });

    vi.unstubAllGlobals();
  });
});

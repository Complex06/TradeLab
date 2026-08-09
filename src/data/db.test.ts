import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  saveDataset,
  getDataset,
  getAllDatasets,
  deleteDataset,
  savePractice,
  getPractice,
  getAllPractices,
  deletePractice,
  getSetting,
  setSetting,
} from './db';
import { createPractice } from '../core/engine';
import type { Dataset, PracticeSettings } from '../core/types';

function five(n: number): Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> {
  return Array.from({ length: n }, (_, i) => ({
    t: 1_600_000_000_000 + i * 300000,
    o: 1,
    h: 1,
    l: 1,
    c: 1,
    v: 1,
  }));
}

function settings(over: Partial<PracticeSettings> = {}): PracticeSettings {
  return {
    tf: 300000,
    symbol: 'BTCUSDT',
    startIndex: 0,
    historyCount: 0,
    initialCapital: 1000,
    defaultLeverage: 10,
    ...over,
  };
}

describe('IndexedDB data layer', () => {
  it('saves, lists, reads and deletes a dataset', async () => {
    const ds: Dataset = { symbol: 'TESTX', bars: five(3), importedAt: 1 };
    await saveDataset(ds);
    expect(await getDataset('TESTX')).toEqual(ds);
    expect((await getAllDatasets()).map((d) => d.symbol)).toContain('TESTX');

    await deleteDataset('TESTX');
    expect(await getDataset('TESTX')).toBeUndefined();
    expect((await getAllDatasets()).map((d) => d.symbol)).not.toContain('TESTX');
  });

  it('saves, lists, reads and deletes a practice snapshot', async () => {
    const p = createPractice(settings(), 42);
    await savePractice(p);
    expect(await getPractice(p.sessionId)).toEqual(p);
    expect((await getAllPractices()).map((x) => x.sessionId)).toContain(p.sessionId);

    await deletePractice(p.sessionId);
    expect(await getPractice(p.sessionId)).toBeUndefined();
    expect((await getAllPractices()).map((x) => x.sessionId)).not.toContain(p.sessionId);
  });

  it('round-trips settings keys', async () => {
    await setSetting('bootstrapDone', true);
    expect(await getSetting<boolean>('bootstrapDone')).toBe(true);
    await setSetting('bootstrapDone', false);
    expect(await getSetting<boolean>('bootstrapDone')).toBe(false);
  });
});

// IndexedDB persistence layer. Stores 5m datasets, practice snapshots and
// small meta keys. See PLAN.md §6.

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Dataset, PracticeState } from '../core/types';

const DB_NAME = 'tradelab';
const DB_VERSION = 1;

interface TradeLabDB extends DBSchema {
  datasets: {
    key: string;
    value: Dataset;
  };
  practices: {
    key: string;
    value: PracticeState;
  };
  settings: {
    key: string;
    value: unknown;
  };
}

let dbPromise: Promise<IDBPDatabase<TradeLabDB>> | null = null;

function getDB(): Promise<IDBPDatabase<TradeLabDB>> {
  if (!dbPromise) {
    dbPromise = openDB<TradeLabDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('datasets')) {
          db.createObjectStore('datasets', { keyPath: 'symbol' });
        }
        if (!db.objectStoreNames.contains('practices')) {
          db.createObjectStore('practices', { keyPath: 'sessionId' });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings');
        }
      },
    });
  }
  return dbPromise;
}

/** True when the cached connection was closed — iOS Safari closes IndexedDB
 *  connections while the page is in the background. */
function isClosedConnectionError(err: unknown): boolean {
  if (err instanceof DOMException) {
    return err.name === 'InvalidStateError' || /closing/i.test(err.message);
  }
  return err instanceof Error && /closing/i.test(err.message);
}

/**
 * Run an IndexedDB operation with one retry on a fresh connection. Safari
 * (iOS) closes the connection when the page is backgrounded; the retry drops
 * the stale handle and reopens so in-flight saves/downloads don't fail.
 */
async function withDb<T>(fn: (db: IDBPDatabase<TradeLabDB>) => Promise<T> | T): Promise<T> {
  try {
    return await fn(await getDB());
  } catch (err) {
    if (!isClosedConnectionError(err)) throw err;
    dbPromise = null; // drop the stale connection
    return await fn(await getDB());
  }
}

/** Test hook: close the underlying connection to simulate iOS backgrounding. */
export function closeDbForTest(): void {
  void dbPromise?.then((db) => db.close());
}

// --- datasets --------------------------------------------------------------

export async function getAllDatasets(): Promise<Dataset[]> {
  return withDb((db) => db.getAll('datasets'));
}

export async function getDataset(symbol: string): Promise<Dataset | undefined> {
  return withDb((db) => db.get('datasets', symbol));
}

export async function saveDataset(dataset: Dataset): Promise<void> {
  return withDb(async (db) => {
    await db.put('datasets', dataset);
  });
}

export async function deleteDataset(symbol: string): Promise<void> {
  return withDb(async (db) => {
    await db.delete('datasets', symbol);
  });
}

// --- practices -------------------------------------------------------------

export async function getAllPractices(): Promise<PracticeState[]> {
  return withDb(async (db) => {
    const all = await db.getAll('practices');
    // Unfinished sessions first, completed ones after.
    return all.sort((a, b) => Number(a.completed) - Number(b.completed));
  });
}

export async function getPractice(sessionId: string): Promise<PracticeState | undefined> {
  return withDb((db) => db.get('practices', sessionId));
}

export async function savePractice(practice: PracticeState): Promise<void> {
  return withDb(async (db) => {
    await db.put('practices', practice);
  });
}

export async function deletePractice(sessionId: string): Promise<void> {
  return withDb(async (db) => {
    await db.delete('practices', sessionId);
  });
}

// --- settings / meta -------------------------------------------------------

export async function getSetting<T>(key: string): Promise<T | undefined> {
  return withDb(async (db) => (await db.get('settings', key)) as T | undefined);
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  return withDb(async (db) => {
    await db.put('settings', value, key);
  });
}

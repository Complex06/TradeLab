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

// --- datasets --------------------------------------------------------------

export async function getAllDatasets(): Promise<Dataset[]> {
  const db = await getDB();
  return db.getAll('datasets');
}

export async function getDataset(symbol: string): Promise<Dataset | undefined> {
  const db = await getDB();
  return db.get('datasets', symbol);
}

export async function saveDataset(dataset: Dataset): Promise<void> {
  const db = await getDB();
  await db.put('datasets', dataset);
}

export async function deleteDataset(symbol: string): Promise<void> {
  const db = await getDB();
  await db.delete('datasets', symbol);
}

// --- practices -------------------------------------------------------------

export async function getAllPractices(): Promise<PracticeState[]> {
  const db = await getDB();
  const all = await db.getAll('practices');
  // Unfinished sessions first, completed ones after.
  return all.sort((a, b) => Number(a.completed) - Number(b.completed));
}

export async function getPractice(sessionId: string): Promise<PracticeState | undefined> {
  const db = await getDB();
  return db.get('practices', sessionId);
}

export async function savePractice(practice: PracticeState): Promise<void> {
  const db = await getDB();
  await db.put('practices', practice);
}

export async function deletePractice(sessionId: string): Promise<void> {
  const db = await getDB();
  await db.delete('practices', sessionId);
}

// --- settings / meta -------------------------------------------------------

export async function getSetting<T>(key: string): Promise<T | undefined> {
  const db = await getDB();
  return (await db.get('settings', key)) as T | undefined;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const db = await getDB();
  await db.put('settings', value, key);
}

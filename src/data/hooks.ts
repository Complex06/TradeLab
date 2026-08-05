// React data hooks bridging the UI to the IndexedDB + bootstrap downloader.

import { useCallback, useEffect, useRef, useState } from 'react';
import { getAllDatasets, getAllPractices, getSetting, setSetting } from './db';
import {
  downloadDefaultDatasets,
  DEFAULT_SYMBOLS,
  type DownloadProgress,
} from './download';
import type { Dataset, PracticeState } from '../core/types';

export type BootstrapStatus = 'idle' | 'downloading' | 'ready' | 'error';

export interface BootstrapState {
  status: BootstrapStatus;
  progress?: DownloadProgress;
  error?: string;
}

const BOOTSTRAP_KEY = 'bootstrapDone';

// Module-level guard so concurrent mounts (React StrictMode) share one run.
let running: Promise<void> | null = null;

export function useBootstrap() {
  const [state, setState] = useState<BootstrapState>({ status: 'idle' });
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    const all = await getAllDatasets();
    if (mounted.current) setDatasets(all);
  }, []);

  const run = useCallback(async () => {
    if (running) return running;
    running = (async () => {
      setState({ status: 'downloading', progress: { done: 0, total: DEFAULT_SYMBOLS.length, message: '准备数据…' } });
      try {
        const existing = await getAllDatasets();
        const have = new Set(existing.map((d) => d.symbol));
        const missing = DEFAULT_SYMBOLS.filter((s) => !have.has(s));
        const bootstrapDone = (await getSetting<boolean>(BOOTSTRAP_KEY)) ?? false;

        if (missing.length === 0 || bootstrapDone) {
          // Nothing to fetch (fresh install with data, or a past successful
          // bootstrap — don't re-download after the user deletes datasets).
          await refresh();
          if (mounted.current) setState({ status: 'ready' });
          return;
        }

        const alreadyDone = existing.filter((d) => DEFAULT_SYMBOLS.includes(d.symbol)).length;
        await downloadDefaultDatasets({
          symbols: missing,
          onProgress: (p) => {
            if (!mounted.current) return;
            setState({
              status: 'downloading',
              progress: {
                ...p,
                done: alreadyDone + p.done,
                total: DEFAULT_SYMBOLS.length,
              },
            });
          },
        });
        await setSetting(BOOTSTRAP_KEY, true);
        await refresh();
        if (mounted.current) setState({ status: 'ready' });
      } catch (err) {
        if (mounted.current) {
          setState({
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        running = null;
      }
    })();
    return running;
  }, [refresh]);

  useEffect(() => {
    mounted.current = true;
    void run();
    return () => {
      mounted.current = false;
    };
  }, [run]);

  const retry = useCallback(() => {
    if (running) return;
    void run();
  }, [run]);

  return { state, datasets, refresh, retry };
}

export function usePractices() {
  const [practices, setPractices] = useState<PracticeState[]>([]);

  const refresh = useCallback(async () => {
    setPractices(await getAllPractices());
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const all = await getAllPractices();
      if (!cancelled) setPractices(all);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { practices, refresh };
}

export function useDatasets() {
  const [datasets, setDatasets] = useState<Dataset[]>([]);

  const refresh = useCallback(async () => {
    setDatasets(await getAllDatasets());
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const all = await getAllDatasets();
      if (!cancelled) setDatasets(all);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { datasets, refresh };
}

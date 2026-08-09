import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useDatasets } from '../data/hooks';
import { getDataset, savePractice } from '../data/db';
import { TF_OPTIONS, aggregate5m } from '../core/aggregate';
import { makeRng, resolveStartIndex } from '../core/random';
import { createPractice } from '../core/engine';
import type { PracticeSettings } from '../core/types';

type StartMode = 'custom' | 'random' | 'market-open';

interface FormState {
  tfMs: number;
  symbol: string;
  startMode: StartMode;
  customIndex: string;
  historyCount: string;
  initialCapital: string;
  defaultLeverage: string;
  hidden: boolean;
  allRandom: boolean;
}

const DEFAULT_FORM: FormState = {
  tfMs: 5 * 60 * 1000,
  symbol: '',
  startMode: 'random',
  customIndex: '0',
  historyCount: '200',
  initialCapital: '1000',
  defaultLeverage: '10',
  hidden: false,
  allRandom: false,
};

export function SetupPage() {
  const { datasets } = useDatasets();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const initialSymbol = params.get('symbol') ?? '';

  const [form, setForm] = useState<FormState>({
    ...DEFAULT_FORM,
    symbol: initialSymbol,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const symbols = useMemo(() => datasets.map((d) => d.symbol).sort(), [datasets]);

  useEffect(() => {
    if (initialSymbol) setForm((f) => ({ ...f, symbol: initialSymbol }));
  }, [initialSymbol]);

  function set<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function pickRandom(): Promise<void> {
    setError(null);
    setInfo(null);
    if (symbols.length === 0) {
      setError('请先导入数据（Library 页导入数据包）');
      return;
    }
    // UI-randomize uses plain Math.random (not reproducible; that's fine).
    const tf = TF_OPTIONS[Math.floor(Math.random() * TF_OPTIONS.length)];
    const sym = symbols[Math.floor(Math.random() * symbols.length)];
    // Directly start practice with random settings without updating form fields
    await startPractice(tf.ms, sym, 'random', true);
  }

  async function startPractice(tfMs: number, symbol: string, startMode: StartMode, hidden: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const ds = await getDataset(symbol);
      if (!ds) {
        setError(`找不到品种 ${symbol} 的数据`);
        return;
      }
      const seed = (Math.random() * 0xffffffff) >>> 0;
      const rng = makeRng(seed);
      const historyCount = Math.max(0, parseInt(form.historyCount) || 0);

      // Practice indices live in AGGREGATED-bar space: aggregate first, then
      // resolve the start index against the exact series the practice shows.
      const bars = aggregate5m(ds.bars, tfMs);
      const today = new Date();
      const resolution = resolveStartIndex(
        bars,
        tfMs,
        startMode,
        startMode === 'custom' ? parseInt(form.customIndex) || 0 : null,
        rng,
        today,
        historyCount
      );
      const startIndex = resolution.startIndex;

      const settings: PracticeSettings = {
        tf: tfMs,
        symbol,
        startIndex,
        historyCount,
        initialCapital: parseFloat(form.initialCapital) || 1000,
        defaultLeverage: parseFloat(form.defaultLeverage) || 10,
      };

      const practice = createPractice(settings, seed, hidden);
      await savePractice(practice);
      navigate(`/practice/${practice.sessionId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (symbols.length === 0) {
      setError('请先导入数据（Library 页导入数据包）');
      return;
    }
    // Handle random symbol selection
    let symbol = form.symbol;
    if (symbol === 'random' || symbol === '') {
      symbol = symbols[Math.floor(Math.random() * symbols.length)];
    }
    await startPractice(form.tfMs, symbol, form.startMode, form.hidden);
  }

  const marketOpenDisabled = ![5, 10, 15, 30].includes(form.tfMs / 60000);

  return (
    <div className="page" style={{ maxWidth: 640 }}>
      <h1>新建练习</h1>
      <form onSubmit={onSubmit}>
        <div className="card">
          <h2>基础设置</h2>
          <div className="row" style={{ alignItems: 'stretch', flexWrap: 'wrap', gap: 14 }}>
            <label className="field grow">
              K 线频率
              <select
                value={form.tfMs}
                onChange={(e) => set('tfMs', Number(e.target.value))}
              >
                {TF_OPTIONS.map((t) => (
                  <option key={t.ms} value={t.ms}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field grow">
              品种
              <select value={form.symbol} onChange={(e) => set('symbol', e.target.value)}>
                <option value="">选择品种…</option>
                <option value="random">🎲 随机</option>
                {symbols.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="row" style={{ alignItems: 'stretch', flexWrap: 'wrap', gap: 14, marginTop: 12 }}>
            <label className="field grow">
              起始时间模式
              <select
                value={form.startMode}
                onChange={(e) => set('startMode', e.target.value as StartMode)}
              >
                <option value="random">随机</option>
                <option value="custom">指定（输入起始 K 索引）</option>
                <option value="market-open">美股开盘模式</option>
              </select>
            </label>
            {form.startMode === 'custom' && (
              <label className="field grow">
                起始 K 索引
                <input
                  type="number"
                  min={0}
                  value={form.customIndex}
                  onChange={(e) => set('customIndex', e.target.value)}
                />
              </label>
            )}
          </div>

          {form.startMode === 'market-open' && marketOpenDisabled && (
            <p className="down" style={{ margin: '8px 0 0' }}>
              开盘模式仅支持 5m / 10m / 15m / 30m 频率。
            </p>
          )}

          <div className="row" style={{ alignItems: 'stretch', flexWrap: 'wrap', gap: 14, marginTop: 12 }}>
            <label className="field grow">
              初始资金（USDT）
              <input
                type="number"
                min={1}
                value={form.initialCapital}
                onChange={(e) => set('initialCapital', e.target.value)}
              />
            </label>
            <label className="field grow">
              默认杠杆
              <input
                type="number"
                min={1}
                value={form.defaultLeverage}
                onChange={(e) => set('defaultLeverage', e.target.value)}
              />
            </label>
          </div>

          <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 14, marginTop: 12 }}>
            <label className="field grow">
              背景历史 K 数量
              <input
                type="number"
                min={0}
                value={form.historyCount}
                onChange={(e) => set('historyCount', e.target.value)}
              />
            </label>
          </div>
        </div>

        {error && <p className="down">{error}</p>}
        {info && <p className="up">{info}</p>}

        <button type="submit" className="btn primary" disabled={busy} style={{ marginTop: 14, width: '100%' }}>
          {busy ? '创建中…' : '开始练习'}
        </button>

        <div className="card" style={{ marginTop: 14 }}>
          <h2>快速开始</h2>
          <div style={{ textAlign: 'center' }}>
            <button
              type="button"
              className="btn primary random-btn"
              onClick={pickRandom}
            >
              🎲 全部随机
            </button>
            <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
              随机频率 + 品种 + 起始时间，并隐藏品种与日期
            </p>
          </div>
        </div>
      </form>
    </div>
  );
}

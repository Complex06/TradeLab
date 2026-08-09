import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getDataset, getPractice, savePractice } from '../data/db';
import { aggregate5m, tfLabel } from '../core/aggregate';
import {
  advance,
  cancelOrder,
  finalizeStats,
  orderNotionalAndMargin,
  placeOrder,
  PRACTICE_VERSION,
  resetToStart,
  availableBalance,
  equity,
  unrealizedPnl,
} from '../core/engine';
import { liqPrice, feeRate } from '../core/calc';
import { KChart, DEFAULT_INDICATORS, type IndicatorConfig, type TradeMarker } from '../components/KChart';
import type { UTCTimestamp } from 'lightweight-charts';
import { fmtPrice, fmtQty, fmtSigned, fmtUsd, fmtTime, fmtDuration } from '../lib/format';
import type { Action, OrderType, PracticeState, QuantityUnit } from '../core/types';

export function PracticePage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<PracticeState | null>(null);
  const [bars, setBars] = useState<import('../core/types').Bar[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [indicators, setIndicators] = useState<IndicatorConfig>(DEFAULT_INDICATORS);

  // panel tabs — Binance-style 开仓/平仓
  const [panelTab, setPanelTab] = useState<'open' | 'close'>('open');

  // order form state — open panel only
  const [orderType, setOrderType] = useState<OrderType>('market');
  const [qtyStr, setQtyStr] = useState('100');
  const [priceStr, setPriceStr] = useState('');
  const [leverageStr, setLeverageStr] = useState('10');
  const [levOpen, setLevOpen] = useState(false);
  const [pctValue, setPctValue] = useState(10);
  const [quickSel, setQuickSel] = useState('');
  const [tpSlEnabled, setTpSlEnabled] = useState(false);
  const [tpPriceStr, setTpPriceStr] = useState('');
  const [slPriceStr, setSlPriceStr] = useState('');

  // close panel state — independent sizing for closing orders
  const [closeType, setCloseType] = useState<OrderType>('limit');
  const [closePriceStr, setClosePriceStr] = useState('');
  const [closePct, setClosePct] = useState(100);
  const [closeQuickSel, setCloseQuickSel] = useState('');

  const stateRef = useRef<PracticeState | null>(null);
  stateRef.current = state;

  // Load practice + dataset.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!sessionId) return;
      const p = await getPractice(sessionId);
      if (!p) {
        setError('练习不存在');
        return;
      }
      const ds = await getDataset(p.symbol);
      if (!ds) {
        setError(`找不到品种 ${p.symbol} 的数据`);
        return;
      }
      if (cancelled) return;
      const agg = aggregate5m(ds.bars, p.tfMs);
      setBars(agg);

      // v1 snapshots stored indices in raw 5m space; migrate them once to
      // aggregated-bar space (v2+). New practices are created aggregated.
      let loaded = p;
      if (p.version < PRACTICE_VERSION) {
        const aggRatio = p.tfMs / (5 * 60 * 1000);
        loaded = {
          ...p,
          version: PRACTICE_VERSION,
          startIndex: Math.floor(p.startIndex / aggRatio),
          currentIndex: Math.floor(p.currentIndex / aggRatio),
        };
        void savePractice(loaded);
      }
      setState(loaded);
      setLeverageStr(String(p.settings.defaultLeverage));
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Chart height adapts to the viewport (recreated by KChart on change).
  const [chartHeight, setChartHeight] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches ? 300 : 420
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 760px)');
    const onChange = () => setChartHeight(mq.matches ? 300 : 420);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const persist = useCallback(
    (s: PracticeState) => {
      void savePractice(s);
    },
    []
  );

  // Derived display data.
  const displayBars = useMemo(() => {
    if (!state) return [];
    const start = state.startIndex - state.historyCount;
    const end = state.currentIndex + 1;
    return bars.slice(Math.max(0, start), Math.max(0, end));
  }, [bars, state]);

  const currentBar = state ? bars[state.currentIndex] : undefined;
  const markPrice = currentBar?.c ?? undefined;
  const uPnl = state && markPrice ? unrealizedPnl(state, markPrice) : 0;
  const eq = state && markPrice ? equity(state, markPrice) : state?.balance ?? 0;
  const avail = state ? availableBalance(state) : 0;

  // Live estimates for the open panel (reference price → margin/liq/max open).
  const refPrice = useMemo(() => {
    if (orderType !== 'market') {
      const p = parseFloat(priceStr);
      if (Number.isFinite(p) && p > 0) return p;
    }
    return markPrice ?? state?.position?.avgPrice ?? 100;
  }, [orderType, priceStr, markPrice, state]);

  const qtyNum = parseFloat(qtyStr) || 0;
  const levNum = parseFloat(leverageStr) || 10;

  const est = useMemo(() => {
    const zero = { qtyBase: 0, notional: 0, margin: 0, liqLong: NaN, liqShort: NaN, maxNotional: 0 };
    if (!state || qtyNum <= 0) return zero;
    const { qtyBase, notional, margin } = orderNotionalAndMargin(
      'marginUsdt',
      qtyNum,
      levNum,
      state,
      refPrice,
      feeRate(orderType)
    );
    // Max openable notional accounts for the opening fee (fee-reserved).
    const maxNotional = (avail / (1 + feeRate(orderType) * levNum)) * levNum;
    return {
      qtyBase,
      notional,
      margin,
      liqLong: liqPrice(refPrice, 'long', levNum),
      liqShort: liqPrice(refPrice, 'short', levNum),
      maxNotional,
    };
  }, [state, qtyNum, levNum, refPrice, avail, orderType]);

  // Close-panel estimates at the reference price (mirrors the open panel).
  const closeEst = useMemo(() => {
    const pos = state?.position;
    if (!pos) return { qty: 0, fee: 0, pnl: 0, remaining: 0 };
    const qty = pos.qty * (closePct / 100);
    let ref: number;
    if (closeType !== 'market') {
      const p = parseFloat(closePriceStr);
      ref = Number.isFinite(p) && p > 0 ? p : (markPrice ?? pos.avgPrice);
    } else {
      ref = markPrice ?? pos.avgPrice;
    }
    const fee = qty * ref * feeRate(closeType);
    const gross = pos.side === 'long' ? (ref - pos.avgPrice) * qty : (pos.avgPrice - ref) * qty;
    return { qty, fee, pnl: gross - fee, remaining: Math.max(0, pos.qty - qty) };
  }, [state, closePct, closeType, closePriceStr, markPrice]);

  // Trade fill markers: B below the bar for buys, S above for sells.
  const tradeMarkers = useMemo<TradeMarker[]>(() => {
    if (!state) return [];
    const out: TradeMarker[] = [];
    for (const r of state.tradeRecords) {
      const bar = bars[r.index];
      if (!bar) continue;
      const buy = r.action === 'openLong' || r.action === 'closeShort';
      out.push({
        time: (bar.t / 1000) as UTCTimestamp,
        color: buy ? '#22c55e' : '#ef4444',
        text: buy ? 'B' : 'S',
        price: buy ? bar.l : bar.h,
        anchor: buy ? 'below' : 'above',
      });
    }
    return out;
  }, [state, bars]);

  const isLast = state ? state.currentIndex >= bars.length - 1 : false;
  const showHidden = state?.hidden && !state.revealed;

  // --- actions ---
  const onNext = useCallback(() => {
    if (!state || !bars.length || isLast) return;
    const nextIdx = state.currentIndex + 1;
    const bar = bars[nextIdx];
    if (!bar) return;
    const beforeStatus = new Map(state.orders.map((o) => [o.id, o.status]));
    let s = advance(state, bar, nextIdx, nextIdx >= bars.length - 1);
    if (s.completed) {
      s = finalizeStats(s);
    }
    setState(s);
    persist(s);
    const newlyIgnored = s.orders.filter(
      (o) => beforeStatus.get(o.id) === 'active' && o.status === 'ignored'
    );
    if (newlyIgnored.length > 0) {
      setNotice('有挂单未成交：可用余额不足（保证金 + 手续费）');
      setTimeout(() => setNotice(null), 3000);
    }
  }, [state, bars, isLast, persist]);

  const onReset = useCallback(() => {
    if (!state) return;
    const s = resetToStart(state);
    setState(s);
    persist(s);
    setNotice('已重置回起点');
    setTimeout(() => setNotice(null), 1500);
  }, [state, persist]);

  /** Percentage buttons/slider: fill the margin box with avail × pct%. */
  const applyPct = useCallback(
    (p: number) => {
      const clamped = Math.max(1, Math.min(100, Math.round(p)));
      setPctValue(clamped);
      setQtyStr((avail * (clamped / 100)).toFixed(2));
    },
    [avail]
  );

  /** Close-panel percentage: quick buttons / slider / typed input. */
  const applyClosePct = useCallback((p: number) => {
    const clamped = Math.max(1, Math.min(100, Math.round(p)));
    setClosePct(clamped);
  }, []);

  /** Open a position with the given side (long/short). */
  const openOrder = useCallback(
    (side: 'long' | 'short') => {
      setOrderError(null);
      if (!state) return;
      // Open panel qty: if the qty box holds a pct slider value... In this
      // design the pct slider updates the qty box directly with a USDT
      // notional, so we always submit as notional (or btcQty per unit).
      const qty = parseFloat(qtyStr);
      if (!Number.isFinite(qty) || qty <= 0) {
        setOrderError('数量无效');
        return;
      }
      let price: number | undefined;
      if (orderType !== 'market') {
        price = parseFloat(priceStr);
        if (!Number.isFinite(price) || price <= 0) {
          setOrderError('请输入有效价格');
          return;
        }
      }
      const leverage = parseFloat(leverageStr) || 10;
      const ref = markPrice ?? (state.position?.avgPrice ?? price ?? 100);
      const unit: QuantityUnit = 'marginUsdt';
      const action: Action = side === 'long' ? 'openLong' : 'openShort';
      const res = placeOrder(
        state,
        {
          action,
          orderType,
          qty,
          unit,
          price,
          triggerRef: side === 'long' ? 'high' : 'low', // D09: buy/breakout=high, sell/stop=low
          leverage,
        },
        ref
      );
      if (res.error) {
        setOrderError(res.error);
        return;
      }
      setState(res.state);
      persist(res.state);
      setNotice(`已挂单：${side === 'long' ? '开多' : '开空'}（${orderType === 'market' ? '市价' : orderType === 'limit' ? '限价' : '止损'}）`);
      setTimeout(() => setNotice(null), 1500);
    },
    [state, orderType, qtyStr, priceStr, leverageStr, markPrice, persist]
  );

  /** Place a close order (market/limit/stop) sized by pct of the position. */
  const placeCloseOrder = useCallback(() => {
    setOrderError(null);
    if (!state || !state.position) return;
    const pos = state.position;
    const qty = pos.qty * (closePct / 100);
    if (!Number.isFinite(qty) || qty <= 0) {
      setOrderError('平仓数量无效');
      return;
    }
    let price: number | undefined;
    if (closeType !== 'market') {
      price = parseFloat(closePriceStr);
      if (!Number.isFinite(price) || price <= 0) {
        setOrderError('请输入有效触发价格');
        return;
      }
    }
    const action: Action = pos.side === 'long' ? 'closeLong' : 'closeShort';
    const res = placeOrder(
      state,
      {
        action,
        orderType: closeType,
        qty,
        unit: 'btcQty',
        price,
        triggerRef: pos.side === 'long' ? 'low' : 'high',
        leverage: pos.leverage,
      },
      pos.avgPrice
    );
    if (res.error) {
      setOrderError(res.error);
      return;
    }
    setState(res.state);
    persist(res.state);
    const typeLabel = closeType === 'market' ? '市价' : closeType === 'limit' ? '限价' : '条件';
    setNotice(`${typeLabel}平仓单已挂出（${closePct}%）`);
    setTimeout(() => setNotice(null), 1500);
  }, [state, closeType, closePriceStr, closePct, persist]);

  /** Attach TP (limit) / SL (stop) reduce-only close orders to the position. */
  const placeTpSl = useCallback(
    (kind: 'tp' | 'sl') => {
      setOrderError(null);
      if (!state || !state.position) return;
      const raw = kind === 'tp' ? tpPriceStr : slPriceStr;
      const price = parseFloat(raw);
      if (!Number.isFinite(price) || price <= 0) {
        setOrderError(kind === 'tp' ? '请输入有效止盈价' : '请输入有效止损价');
        return;
      }
      const pos = state.position;
      const action: Action = pos.side === 'long' ? 'closeLong' : 'closeShort';
      const orderType: OrderType = kind === 'tp' ? 'limit' : 'stop';
      const res = placeOrder(
        state,
        {
          action,
          orderType,
          qty: pos.qty,
          unit: 'btcQty',
          price,
          triggerRef: pos.side === 'long' ? 'low' : 'high',
          leverage: pos.leverage,
        },
        pos.avgPrice
      );
      if (res.error) {
        setOrderError(res.error);
        return;
      }
      setState(res.state);
      persist(res.state);
      setNotice(`${kind === 'tp' ? '止盈' : '止损'}单已挂出（${fmtPrice(price)}）`);
      setTimeout(() => setNotice(null), 1500);
    },
    [state, tpPriceStr, slPriceStr, persist]
  );

  const onCancelOrder = useCallback(
    (orderId: string) => {
      if (!state) return;
      const s = cancelOrder(state, orderId);
      setState(s);
      persist(s);
    },
    [state, persist]
  );

  const onFinish = useCallback(() => {
    if (!state) return;
    // compute stats on current state, save, go to report
    const s = finalizeStats(state);
    setState(s);
    persist(s);
    navigate(`/report/${state.sessionId}`);
  }, [state, persist, navigate]);

  if (error) return <div className="page"><p className="down">{error}</p></div>;
  if (!state) return <div className="page"><p className="muted">加载中…</p></div>;

  const activeOrders = state.orders.filter((o) => o.status === 'active');

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      {/* header */}
      <div className="practice-head">
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <h1 style={{ margin: 0, fontSize: 18 }}>
            <span className={showHidden ? 'masked' : ''}>
              {showHidden ? '••••' : state.symbol}
            </span>
            <span className="muted" style={{ marginLeft: 8 }}>{tfLabel(state.tfMs)}</span>
          </h1>
          {currentBar && (
            <span className="muted mono">
              {showHidden ? '日期隐藏' : fmtTime(currentBar.t, { date: true })}
            </span>
          )}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" onClick={onReset}>重置</button>
          <button className="btn" onClick={onFinish}>结束并看报告</button>
          <button className="btn primary" onClick={onNext} disabled={isLast}>
            下一根 →
          </button>
        </div>
      </div>

      {notice && <p className="up" style={{ margin: '6px 0' }}>{notice}</p>}

      <div className="practice-grid">
        {/* chart */}
        <div className="card chart-card">
          <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              <label className="row" style={{ gap: 5, fontSize: 12, color: 'var(--muted)' }}>
                <input type="checkbox" checked={indicators.volume.enabled} onChange={(e) => setIndicators((i) => ({ ...i, volume: { ...i.volume, enabled: e.target.checked } }))} />
                成交量
              </label>
              <label className="row" style={{ gap: 5, fontSize: 12, color: 'var(--muted)' }}>
                <input type="checkbox" checked={indicators.ema.enabled} onChange={(e) => setIndicators((i) => ({ ...i, ema: { ...i.ema, enabled: e.target.checked } }))} />
                EMA
              </label>
              {indicators.ema.enabled && (
                <label className="row" style={{ gap: 5, fontSize: 12 }}>
                  <span className="muted">周期</span>
                  <input
                    type="number"
                    min={1}
                    value={indicators.ema.period}
                    onChange={(e) => setIndicators((i) => ({ ...i, ema: { ...i.ema, period: parseInt(e.target.value) || 1 } }))}
                    style={{ width: 56 }}
                  />
                </label>
              )}
              <label className="row" style={{ gap: 5, fontSize: 12, color: 'var(--muted)' }}>
                <input type="checkbox" checked={indicators.macd.enabled} onChange={(e) => setIndicators((i) => ({ ...i, macd: { ...i.macd, enabled: e.target.checked } }))} />
                MACD
              </label>
              {indicators.macd.enabled && (
                <>
                  <label className="row" style={{ gap: 4, fontSize: 12 }}>
                    <span className="muted">快</span>
                    <input type="number" min={1} value={indicators.macd.fast} onChange={(e) => setIndicators((i) => ({ ...i, macd: { ...i.macd, fast: parseInt(e.target.value) || 1 } }))} style={{ width: 48 }} />
                  </label>
                  <label className="row" style={{ gap: 4, fontSize: 12 }}>
                    <span className="muted">慢</span>
                    <input type="number" min={1} value={indicators.macd.slow} onChange={(e) => setIndicators((i) => ({ ...i, macd: { ...i.macd, slow: parseInt(e.target.value) || 1 } }))} style={{ width: 48 }} />
                  </label>
                  <label className="row" style={{ gap: 4, fontSize: 12 }}>
                    <span className="muted">信号</span>
                    <input type="number" min={1} value={indicators.macd.signal} onChange={(e) => setIndicators((i) => ({ ...i, macd: { ...i.macd, signal: parseInt(e.target.value) || 1 } }))} style={{ width: 48 }} />
                  </label>
                </>
              )}
            </div>
          </div>
          <KChart bars={displayBars} height={chartHeight} indicators={indicators} markers={tradeMarkers} />
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 8, flexWrap: 'wrap', gap: 8 }}>
            <div className="row" style={{ gap: 14 }}>
              <span>余额 <b className="mono">{fmtUsd(state.balance)}</b></span>
              <span>权益 <b className="mono">{fmtUsd(eq)}</b></span>
              <span>可用 <b className="mono">{fmtUsd(avail)}</b></span>
            </div>
            <div className="row" style={{ gap: 14 }}>
              <span>浮动盈亏 <b className={`mono ${uPnl >= 0 ? 'up' : 'down'}`}>{fmtSigned(uPnl)}</b></span>
              <span>进度 <b className="mono">{state.currentIndex - state.startIndex + 1} 根</b></span>
            </div>
          </div>
        </div>

          <div className="practice-bottom">
            {/* order panel — Binance-style 开仓 / 平仓 */}
            <div className="card order-card">
          {/* panel header: mode + leverage */}
          <div className="order-head">
            <button className="lev-btn" onClick={() => setLevOpen((v) => !v)}>
              {levNum}× <span className="muted">▾</span>
            </button>
            {levOpen && (
              <input
                type="number"
                min={1}
                className="lev-input"
                value={leverageStr}
                onChange={(e) => setLeverageStr(e.target.value)}
                onBlur={() => setLevOpen(false)}
              />
            )}
          </div>

          {/* 开仓 / 平仓 tabs */}
          <div className="tabs panel-tabs">
            <button className={`tab ${panelTab === 'open' ? 'active' : ''}`} onClick={() => setPanelTab('open')}>
              开仓
            </button>
            <button className={`tab ${panelTab === 'close' ? 'active' : ''}`} onClick={() => setPanelTab('close')}>
              平仓
            </button>
          </div>

          {panelTab === 'open' ? (
            <>
              {/* order type */}
              <div className="tabs order-type-tabs">
                {(['limit', 'market', 'stop'] as OrderType[]).map((t) => (
                  <button
                    key={t}
                    className={`tab ${orderType === t ? 'active' : ''}`}
                    onClick={() => setOrderType(t)}
                  >
                    {t === 'limit' ? '限价' : t === 'market' ? '市价' : '条件委托'}
                  </button>
                ))}
              </div>

              {/* available balance */}
              <div className="row" style={{ justifyContent: 'space-between', margin: '2px 0 10px' }}>
                <span className="muted" style={{ fontSize: 12 }}>
                  可用 <b className="mono" style={{ color: 'var(--text)' }}>{fmtUsd(avail)}</b> USDT
                </span>
              </div>

              {/* price */}
              {orderType !== 'market' && (
                <div className="inline-label">
                  <span>委托价格</span>
                  <div className="qty-input-wrap grow">
                    <input type="number" step="any" value={priceStr} onChange={(e) => setPriceStr(e.target.value)} placeholder="输入价格" />
                    <span className="unit-tag">USDT</span>
                    <select
                      value={quickSel}
                      onChange={(e) => {
                        const k = e.target.value as '' | 'o' | 'h' | 'l' | 'c';
                        if (k && currentBar) setPriceStr(String(currentBar[k]));
                        setQuickSel('');
                      }}
                      style={{ width: 72, flexShrink: 0 }}
                    >
                      <option value="">快捷</option>
                      <option value="o">开</option>
                      <option value="h">高</option>
                      <option value="l">低</option>
                      <option value="c">收</option>
                    </select>
                  </div>
                </div>
              )}

              {/* quantity / initial margin + unit */}
              <div className="inline-label">
                <span>投入金额</span>
                <div className="qty-input-wrap grow">
                  <input type="number" step="any" value={qtyStr} onChange={(e) => setQtyStr(e.target.value)} />
                  <span className="unit-tag">USDT</span>
                </div>
              </div>

              {/* pct quick buttons + slider */}
              <div className="pct-bar" style={{ marginTop: 6 }}>
                {[25, 50, 75, 100].map((p) => (
                  <button
                    key={p}
                    className={`pct-quick ${Math.round(pctValue) === p ? 'on' : ''}`}
                    onClick={() => applyPct(p)}
                  >
                    {p}%
                  </button>
                ))}
              </div>
              <div className="pct-bar" style={{ marginTop: 6 }}>
                <input
                  type="range"
                  min={1}
                  max={100}
                  value={pctValue}
                  onChange={(e) => applyPct(parseInt(e.target.value, 10))}
                  style={{ flex: 1 }}
                />
                <input
                  type="number"
                  min={1}
                  max={100}
                  className="pct-input mono"
                  value={pctValue}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (Number.isFinite(v)) {
                      const clamped = Math.max(1, Math.min(100, v));
                      setPctValue(clamped);
                      setQtyStr((avail * (clamped / 100)).toFixed(2));
                    }
                  }}
                />
                <span className="muted">%</span>
              </div>
              <p className="muted" style={{ fontSize: 11, margin: '4px 0 0' }}>
                投入金额包含手续费，实际保证金 = 投入金额 − 手续费；百分比按可用余额计算，100% 即投入全部可用。
              </p>

              {/* buy / sell notional reference */}
              <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
                <span className="muted" style={{ fontSize: 12 }}>
                  买入 <b className="mono" style={{ color: 'var(--green)' }}>{fmtUsd(est.notional)}</b> USDT
                </span>
                <span className="muted" style={{ fontSize: 12 }}>
                  卖出 <b className="mono" style={{ color: 'var(--red)' }}>{fmtUsd(est.notional)}</b> USDT
                </span>
              </div>

              {/* TP / SL */}
              <label className="row" style={{ gap: 6, fontSize: 12, color: 'var(--muted)', marginTop: 10 }}>
                <input type="checkbox" checked={tpSlEnabled} onChange={(e) => setTpSlEnabled(e.target.checked)} />
                止盈/止损
              </label>
              {tpSlEnabled && (
                <div className="tp-panel">
                  {state.position ? (
                    <>
                      <div className="inline-label">
                        <span>止盈价</span>
                        <input type="number" step="any" className="grow" value={tpPriceStr} onChange={(e) => setTpPriceStr(e.target.value)} placeholder="输入价格" />
                      </div>
                      <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 6 }}>
                        <button className="btn ghost" style={{ padding: '4px 10px' }} onClick={() => placeTpSl('tp')}>
                          挂止盈单
                        </button>
                      </div>
                      <div className="inline-label">
                        <span>止损价</span>
                        <input type="number" step="any" className="grow" value={slPriceStr} onChange={(e) => setSlPriceStr(e.target.value)} placeholder="输入价格" />
                      </div>
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        <button className="btn ghost" style={{ padding: '4px 10px' }} onClick={() => placeTpSl('sl')}>
                          挂止损单
                        </button>
                      </div>
                      <p className="muted" style={{ fontSize: 11, margin: '6px 0 0' }}>
                        止盈按限价、止损按条件单挂出，按当前持仓 100% 数量。
                      </p>
                    </>
                  ) : (
                    <p className="muted" style={{ fontSize: 11, margin: 0 }}>
                      开仓后可在本面板挂止盈/止损。
                    </p>
                  )}
                </div>
              )}

              {/* two-column open buttons with live estimates */}
              <div className="open-cols">
                <div>
                  <button className="big-order long" onClick={() => openOrder('long')} disabled={!state}>
                    开多
                  </button>
                  <div className="est-row">
                    <span>强平价格</span>
                    <b>{Number.isFinite(est.liqLong) ? fmtPrice(est.liqLong) : '--'} USDT</b>
                  </div>
                  <div className="est-row">
                    <span>保证金</span>
                    <b>{fmtUsd(est.margin)} USDT</b>
                  </div>
                  <div className="est-row">
                    <span>可开</span>
                    <b>{fmtUsd(est.maxNotional)} USDT</b>
                  </div>
                </div>
                <div>
                  <button className="big-order short" onClick={() => openOrder('short')} disabled={!state}>
                    开空
                  </button>
                  <div className="est-row">
                    <span>强平价格</span>
                    <b>{Number.isFinite(est.liqShort) ? fmtPrice(est.liqShort) : '--'} USDT</b>
                  </div>
                  <div className="est-row">
                    <span>保证金</span>
                    <b>{fmtUsd(est.margin)} USDT</b>
                  </div>
                  <div className="est-row">
                    <span>可开</span>
                    <b>{fmtUsd(est.maxNotional)} USDT</b>
                  </div>
                </div>
              </div>

              {orderError && <p className="down" style={{ marginTop: 8 }}>{orderError}</p>}
              <p className="muted" style={{ fontSize: 11, marginTop: 8 }}>
                市价单按下一根 K 开盘价成交；限价/条件单挂单持续检测，直到触发或手动取消。
              </p>
            </>
          ) : (
            <>
              {state.position ? (
                <>
                  {/* Close type tabs — same style as the open panel */}
                  <div className="tabs order-type-tabs">
                    {(['limit', 'market', 'stop'] as OrderType[]).map((t) => (
                      <button
                        key={t}
                        className={`tab ${closeType === t ? 'active' : ''}`}
                        onClick={() => setCloseType(t)}
                      >
                        {t === 'limit' ? '限价' : t === 'market' ? '市价' : '条件委托'}
                      </button>
                    ))}
                  </div>

                  {/* Trigger price + quick fill (only for limit/stop, same as open) */}
                  {closeType !== 'market' && (
                    <div className="inline-label" style={{ marginTop: 10 }}>
                      <span>触发价格</span>
                      <div className="qty-input-wrap grow">
                        <input type="number" step="any" value={closePriceStr} onChange={(e) => setClosePriceStr(e.target.value)} placeholder="输入价格" />
                        <span className="unit-tag">USDT</span>
                        <select
                          value={closeQuickSel}
                          onChange={(e) => {
                            const k = e.target.value as '' | 'o' | 'h' | 'l' | 'c';
                            if (k && currentBar) setClosePriceStr(String(currentBar[k]));
                            setCloseQuickSel('');
                          }}
                          style={{ width: 72, flexShrink: 0 }}
                        >
                          <option value="">快捷</option>
                          <option value="o">开</option>
                          <option value="h">高</option>
                          <option value="l">低</option>
                          <option value="c">收</option>
                        </select>
                      </div>
                    </div>
                  )}

                  {/* Percentage buttons */}
                  <div className="pct-bar" style={{ marginTop: 8 }}>
                    {[25, 50, 75, 100].map((p) => (
                      <button
                        key={p}
                        className={`pct-quick ${Math.round(closePct) === p ? 'on' : ''}`}
                        onClick={() => applyClosePct(p)}
                      >
                        {p}%
                      </button>
                    ))}
                  </div>
                  <div className="pct-bar" style={{ marginTop: 6 }}>
                    <input
                      type="range"
                      min={1}
                      max={100}
                      value={closePct}
                      onChange={(e) => applyClosePct(parseInt(e.target.value, 10))}
                      style={{ flex: 1 }}
                    />
                    <input
                      type="number"
                      min={1}
                      max={100}
                      className="pct-input mono"
                      value={closePct}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        if (Number.isFinite(v)) {
                          setClosePct(Math.max(1, Math.min(100, v)));
                        }
                      }}
                    />
                    <span className="muted">%</span>
                  </div>

                  {/* Close action */}
                  <button className="big-order short" style={{ marginTop: 12 }} onClick={placeCloseOrder}>
                    平仓
                  </button>

                  {/* Estimates — mirror the open panel */}
                  <div className="est-row">
                    <span>平仓数量</span>
                    <b className="mono">{fmtQty(closeEst.qty)}</b>
                  </div>
                  <div className="est-row">
                    <span>预计盈亏</span>
                    <b className={`mono ${closeEst.pnl >= 0 ? 'up' : 'down'}`}>{fmtSigned(closeEst.pnl)} USDT</b>
                  </div>
                  <div className="est-row">
                    <span>手续费</span>
                    <b className="mono">{fmtUsd(closeEst.fee)} USDT</b>
                  </div>
                  <div className="est-row">
                    <span>剩余持仓</span>
                    <b className="mono">{fmtQty(closeEst.remaining)}</b>
                  </div>

                  <p className="muted" style={{ fontSize: 11, marginTop: 8 }}>
                    {closeType === 'market'
                      ? '市价单按下一根 K 开盘价成交。'
                      : `按持仓 ${closePct}% 挂单；触发后剩余仓位继续持有。`}
                  </p>
                </>
              ) : (
                <div className="empty" style={{ padding: '40px 0' }}>当前无持仓</div>
              )}
            </>
          )}
            </div>

            {/* position + orders */}
            <div className="card position-card">
          <h2>持仓</h2>
          {state.position ? (
            <table>
              <tbody>
                <tr><td>方向</td><td><span className={`badge ${state.position.side}`}>{state.position.side === 'long' ? '多' : '空'}</span></td></tr>
                <tr><td>数量</td><td className="mono">{fmtQty(state.position.qty)}</td></tr>
                <tr><td>均价</td><td className="mono">{fmtPrice(state.position.avgPrice)}</td></tr>
                <tr><td>杠杆</td><td className="mono">{state.position.leverage}×</td></tr>
                <tr><td>保证金</td><td className="mono">{fmtUsd(state.position.margin)}</td></tr>
                <tr><td>强平价</td><td className={`mono ${state.position.side === 'long' ? 'down' : 'up'}`}>{fmtPrice(state.position.liqPrice)}</td></tr>
                <tr><td>浮动盈亏</td><td className={`mono ${uPnl >= 0 ? 'up' : 'down'}`}>{fmtSigned(uPnl)}</td></tr>
              </tbody>
            </table>
          ) : (
            <div className="empty">无持仓</div>
          )}

          <h2 style={{ marginTop: 16 }}>挂单 ({activeOrders.length})</h2>
          {activeOrders.length === 0 ? (
            <div className="empty">无挂单</div>
          ) : (
            <table>
              <thead>
                <tr><th>单</th><th>类型</th><th>数量</th><th>价格</th><th></th></tr>
              </thead>
              <tbody>
                {activeOrders.map((o) => (
                  <tr key={o.id}>
                    <td>{actionLabel(o.action)}</td>
                    <td>{o.orderType === 'market' ? '市价' : o.orderType === 'limit' ? '限价' : '止损'}</td>
                    <td className="mono">{fmtQty(o.qty)}</td>
                    <td className="mono">{o.price ? fmtPrice(o.price) : '—'}</td>
                    <td>
                      <button className="btn ghost" style={{ padding: '2px 8px' }} onClick={() => onCancelOrder(o.id)}>
                        取消
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h2 style={{ marginTop: 16 }}>仓位历史 ({state.closedTrades.length})</h2>
          {state.closedTrades.length === 0 ? (
            <div className="empty">暂无历史</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>方向</th>
                  <th>数量</th>
                  <th>开仓价</th>
                  <th>平仓价</th>
                  <th>盈亏</th>
                  <th>手续费</th>
                  <th>持仓时间</th>
                </tr>
              </thead>
              <tbody>
                {state.closedTrades.slice().reverse().map((t, i) => (
                  <tr key={`${t.openedAt}-${t.closedAt}-${i}`}>
                    <td>
                      {t.side ? (
                        <span className={`badge ${t.side}`}>
                          {t.side === 'long' ? '多' : '空'}
                          {t.liq ? '·强平' : ''}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="mono">{t.qty != null ? fmtQty(t.qty) : '—'}</td>
                    <td className="mono">{t.openPrice != null ? fmtPrice(t.openPrice) : '—'}</td>
                    <td className="mono">{t.closePrice != null ? fmtPrice(t.closePrice) : '—'}</td>
                    <td className={`mono ${t.pnl >= 0 ? 'up' : 'down'}`}>{fmtSigned(t.pnl)}</td>
                    <td className="mono">{fmtUsd(t.fee ?? 0)}</td>
                    <td className="mono">{fmtDuration(t.holdIndex * state.tfMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
            </div>
          </div>
        </div>
      </div>
  );
}

function actionLabel(a: Action): string {
  switch (a) {
    case 'openLong':
      return '开多';
    case 'openShort':
      return '开空';
    case 'closeLong':
      return '平多';
    case 'closeShort':
      return '平空';
  }
}

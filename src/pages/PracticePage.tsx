import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getDataset, getPractice, savePractice } from '../data/db';
import { aggregate5m, tfLabel } from '../core/aggregate';
import {
  advance,
  cancelOrder,
  finalizeStats,
  placeOrder,
  resetToStart,
  availableBalance,
  equity,
  unrealizedPnl,
} from '../core/engine';
import { KChart, DEFAULT_INDICATORS, type IndicatorConfig } from '../components/KChart';
import { fmtPrice, fmtQty, fmtSigned, fmtUsd, fmtTime } from '../lib/format';
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

  // order form state — open panel only
  const [orderType, setOrderType] = useState<OrderType>('market');
  const [qtyUnit, setQtyUnit] = useState<'coin' | 'usdt'>('usdt');
  const [qtyStr, setQtyStr] = useState('100');
  const [priceStr, setPriceStr] = useState('');
  const [leverageStr, setLeverageStr] = useState('10');
  const [pctValue, setPctValue] = useState(10);

  // close panel state — independent sizing for closing orders
  const [closeType, setCloseType] = useState<OrderType>('market');
  const [closePriceStr, setClosePriceStr] = useState('');
  const [closePct, setClosePct] = useState(100);

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
      setState(p);
      setLeverageStr(String(p.settings.defaultLeverage));
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

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

  const isLast = state ? state.currentIndex >= bars.length - 1 : false;
  const showHidden = state?.hidden && !state.revealed;

  // --- actions ---
  const onNext = useCallback(() => {
    if (!state || !bars.length || isLast) return;
    const nextIdx = state.currentIndex + 1;
    const bar = bars[nextIdx];
    if (!bar) return;
    let s = advance(state, bar, nextIdx, nextIdx >= bars.length - 1);
    if (s.completed) {
      s = finalizeStats(s);
    }
    setState(s);
    persist(s);
  }, [state, bars, isLast, persist]);

  const onReset = useCallback(() => {
    if (!state) return;
    const s = resetToStart(state);
    setState(s);
    persist(s);
    setNotice('已重置回起点');
    setTimeout(() => setNotice(null), 1500);
  }, [state, persist]);

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
      const unit: QuantityUnit = qtyUnit === 'coin' ? 'btcQty' : 'notional';
      const action: Action = side === 'long' ? 'openLong' : 'openShort';
      const res = placeOrder(
        state,
        {
          action,
          orderType,
          qty,
          unit,
          price,
          triggerRef: side === 'short' ? 'high' : 'low',
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
    [state, orderType, qtyUnit, qtyStr, priceStr, leverageStr, markPrice, persist]
  );

  /** Market close the full position (one-click). */
  const closeMarket = useCallback(() => {
    setOrderError(null);
    if (!state || !state.position) return;
    const action: Action = state.position.side === 'long' ? 'closeLong' : 'closeShort';
    const res = placeOrder(
      state,
      { action, orderType: 'market', qty: state.position.qty, unit: 'btcQty', leverage: state.position.leverage },
      state.position.avgPrice
    );
    if (res.error) {
      setOrderError(res.error);
      return;
    }
    setState(res.state);
    persist(res.state);
    setNotice('市价平仓挂单已下，下一根成交');
    setTimeout(() => setNotice(null), 1500);
  }, [state, persist]);

  /** Place a limit/stop close order sized by pct of the position. */
  const closeLimitStop = useCallback(() => {
    setOrderError(null);
    if (!state || !state.position) return;
    const price = parseFloat(closePriceStr);
    if (!Number.isFinite(price) || price <= 0) {
      setOrderError('请输入平仓触发价格');
      return;
    }
    // qty = pct of current position → base qty directly.
    const qty = state.position.qty * (closePct / 100);
    if (!Number.isFinite(qty) || qty <= 0) {
      setOrderError('平仓数量无效');
      return;
    }
    const action: Action = state.position.side === 'long' ? 'closeLong' : 'closeShort';
    const res = placeOrder(
      state,
      {
        action,
        orderType: closeType,
        qty,
        unit: 'btcQty',
        price,
        triggerRef: state.position.side === 'long' ? 'low' : 'high',
        leverage: state.position.leverage,
      },
      state.position.avgPrice
    );
    if (res.error) {
      setOrderError(res.error);
      return;
    }
    setState(res.state);
    persist(res.state);
    setNotice(`已挂平仓单（${closeType === 'limit' ? '限价' : '止损'} @ ${fmtPrice(price)}）`);
    setTimeout(() => setNotice(null), 1500);
  }, [state, closeType, closePriceStr, closePct, persist]);

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
  const recentRecords = state.tradeRecords.slice(-8).reverse();

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      {/* header */}
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
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

      <div className="row" style={{ gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* chart */}
        <div className="card" style={{ flex: '1 1 620px', minWidth: 320 }}>
          <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
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
          <KChart bars={displayBars} height={420} indicators={indicators} />
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

        {/* order panel — open positions only (Binance style) */}
        <div className="card" style={{ flex: '0 1 340px', minWidth: 300 }}>
          <h2>开仓</h2>

          {/* order type tabs */}
          <div className="tabs">
            {(['limit', 'market', 'stop'] as OrderType[]).map((t) => (
              <button
                key={t}
                className={`tab ${orderType === t ? 'active' : ''}`}
                onClick={() => setOrderType(t)}
              >
                {t === 'limit' ? '限价' : t === 'market' ? '市价' : '止损'}
              </button>
            ))}
          </div>

          {orderType !== 'market' && (
            <div className="inline-label">
              <span>价格</span>
              <input type="number" step="any" className="grow" value={priceStr} onChange={(e) => setPriceStr(e.target.value)} placeholder="输入价格" />
            </div>
          )}

          {/* quantity + unit */}
          <div className="inline-label">
            <span>数量</span>
            <div className="qty-input-wrap grow">
              <input type="number" step="any" value={qtyStr} onChange={(e) => setQtyStr(e.target.value)} />
              <select
                value={qtyUnit}
                onChange={(e) => setQtyUnit(e.target.value as 'coin' | 'usdt')}
                style={{ width: 76, flexShrink: 0 }}
              >
                <option value="coin">币</option>
                <option value="usdt">USDT</option>
              </select>
            </div>
          </div>

          {/* pct quick buttons + slider — always visible, updates qty box */}
          <div className="pct-bar" style={{ marginTop: 6 }}>
            {[25, 50, 75, 100].map((p) => (
              <button
                key={p}
                className={`pct-quick ${Math.round(pctValue) === p ? 'on' : ''}`}
                onClick={() => {
                  setPctValue(p);
                  setQtyStr((avail * (p / 100)).toFixed(2));
                }}
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
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                setPctValue(v);
                setQtyStr((avail * (v / 100)).toFixed(2));
              }}
              style={{ flex: 1 }}
            />
            <span className="mono" style={{ width: 42, textAlign: 'right', flexShrink: 0 }}>
              {pctValue}%
            </span>
          </div>
          <p className="muted" style={{ fontSize: 11, margin: '4px 0 0' }}>
            百分比按可用余额的 {pctValue}% 换算成保证金填入数量格。
          </p>

          {/* leverage */}
          <div className="inline-label" style={{ marginTop: 10 }}>
            <span>杠杆</span>
            <input type="number" min={1} className="grow" value={leverageStr} onChange={(e) => setLeverageStr(e.target.value)} />
          </div>

          {/* big open buttons */}
          <button className="big-order long" onClick={() => openOrder('long')} disabled={!state}>
            开多 · 做多
          </button>
          <button className="big-order short" onClick={() => openOrder('short')} disabled={!state}>
            开空 · 做空
          </button>

          {orderError && <p className="down" style={{ marginTop: 8 }}>{orderError}</p>}
          <p className="muted" style={{ fontSize: 11, marginTop: 8 }}>
            市价单按下一根 K 开盘价成交；限价/止损单挂单持续检测，直到触发或手动取消。
          </p>
        </div>

        {/* position + orders */}
        <div className="card" style={{ flex: '1 1 380px', minWidth: 300 }}>
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

          {/* independent close panel — only when a position exists */}
          {state.position && (
            <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
                <span className="muted" style={{ fontSize: 12 }}>平仓</span>
                <button className="close-full" style={{ marginTop: 0, width: 'auto', padding: '5px 12px' }} onClick={closeMarket}>
                  市价全平
                </button>
              </div>

              <div className="tabs" style={{ marginBottom: 8 }}>
                {(['limit', 'stop'] as OrderType[]).map((t) => (
                  <button
                    key={t}
                    className={`tab ${closeType === t ? 'active' : ''}`}
                    onClick={() => setCloseType(t)}
                    style={{ padding: '5px 10px', fontSize: 12 }}
                  >
                    {t === 'limit' ? '限价平仓' : '止损平仓'}
                  </button>
                ))}
              </div>

              <div className="inline-label" style={{ margin: '4px 0' }}>
                <span>触发价</span>
                <input type="number" step="any" className="grow" value={closePriceStr} onChange={(e) => setClosePriceStr(e.target.value)} placeholder="输入价格" />
              </div>

              <div className="pct-bar" style={{ margin: '4px 0' }}>
                {[25, 50, 75, 100].map((p) => (
                  <button
                    key={p}
                    className={`pct-quick ${Math.round(closePct) === p ? 'on' : ''}`}
                    onClick={() => setClosePct(p)}
                  >
                    {p}%
                  </button>
                ))}
                <input
                  type="range"
                  min={1}
                  max={100}
                  value={closePct}
                  onChange={(e) => setClosePct(parseInt(e.target.value, 10))}
                  style={{ flex: 1 }}
                />
              </div>

              <button className="btn" style={{ width: '100%', marginTop: 6 }} onClick={closeLimitStop}>
                挂{closeType === 'limit' ? '限价' : '止损'}平仓单（{closePct}%）
              </button>
              <p className="muted" style={{ fontSize: 11, margin: '4px 0 0' }}>
                按持仓 {closePct}% 挂单；触发后剩余仓位继续持有。
              </p>
            </div>
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

          <h2 style={{ marginTop: 16 }}>最近成交</h2>
          {recentRecords.length === 0 ? (
            <div className="empty">暂无成交</div>
          ) : (
            <table>
              <thead>
                <tr><th>动作</th><th>数量</th><th>价格</th><th>手续费</th></tr>
              </thead>
              <tbody>
                {recentRecords.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.liq ? <span className="badge" style={{ background: 'rgba(239,68,68,.2)', color: '#ef4444' }}>强平</span> : actionLabel(r.action)}
                    </td>
                    <td className="mono">{fmtQty(r.qty)}</td>
                    <td className="mono">{fmtPrice(r.price)}</td>
                    <td className="mono">{fmtUsd(r.fee)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
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

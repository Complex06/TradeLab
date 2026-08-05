// Core practice engine — pure, framework-agnostic, fully serializable.
// Every transition returns a NEW state (no mutation). See PLAN.md §5.

import type {
  Bar,
  PracticeState,
  PracticeSettings,
  Position,
  Order,
  OrderInput,
  PracticeStats,
} from './types';
import { liqPrice, feeRate, requiredMargin, round6 } from './calc';

const clone = <T>(x: T): T => structuredClone(x);

let seq = 0;
const nextId = (prefix: string): string => `${prefix}${++seq}_${Math.random().toString(36).slice(2, 8)}`;

// ---------------------------------------------------------------------------
// Derived values
// ---------------------------------------------------------------------------

export function unrealizedPnl(state: PracticeState, mark: number): number {
  const p = state.position;
  if (!p) return 0;
  return p.side === 'long' ? (mark - p.avgPrice) * p.qty : (p.avgPrice - mark) * p.qty;
}

export function equity(state: PracticeState, mark: number): number {
  return state.balance + unrealizedPnl(state, mark);
}

export function availableBalance(state: PracticeState): number {
  return state.balance - (state.position?.margin ?? 0);
}

// ---------------------------------------------------------------------------
// Practice creation
// ---------------------------------------------------------------------------

export function createPractice(
  settings: PracticeSettings,
  seed: number,
  hidden = false
): PracticeState {
  return {
    version: 1,
    sessionId: nextId('s_'),
    seed,
    settings,
    symbol: settings.symbol,
    tfMs: settings.tf,
    startIndex: settings.startIndex,
    currentIndex: settings.startIndex,
    historyCount: settings.historyCount,
    position: null,
    orders: [],
    balance: settings.initialCapital,
    initialCapital: settings.initialCapital,
    equityCurve: [settings.initialCapital],
    tradeRecords: [],
    closedTrades: [],
    hidden,
    revealed: false,
    completed: false,
    stats: null,
  };
}

// ---------------------------------------------------------------------------
// Quantity resolution
// ---------------------------------------------------------------------------

export function resolveBaseQty(
  unit: OrderInput['unit'],
  qty: number,
  leverage: number,
  state: PracticeState,
  refPrice: number,
  feeRateNum: number
): number {
  const avail = availableBalance(state);
  switch (unit) {
    case 'btcQty':
      return qty;
    case 'notional':
      return qty / refPrice;
    case 'marginUsdt':
      // Fee-inclusive invested amount: margin = qty/(1+leverage×fee), so the
      // opening fee is paid out of the invested amount, not reserved extra.
      return (qty * leverage) / ((1 + leverage * feeRateNum) * refPrice);
    case 'marginPct':
      return (avail * (qty / 100) * leverage) / refPrice;
  }
}

/** Compute margin required & notional for a given order + unit. */
export function orderNotionalAndMargin(
  unit: OrderInput['unit'],
  qty: number,
  leverage: number,
  state: PracticeState,
  refPrice: number,
  feeRateNum: number
): { qtyBase: number; notional: number; margin: number } {
  const qtyBase = resolveBaseQty(unit, qty, leverage, state, refPrice, feeRateNum);
  const notional = qtyBase * refPrice;
  const margin = requiredMargin(notional, leverage);
  return { qtyBase, notional, margin };
}

// ---------------------------------------------------------------------------
// Order placement / cancellation
// ---------------------------------------------------------------------------

export interface OrderResult {
  state: PracticeState;
  order?: Order;
  error?: string;
}

export function placeOrder(state: PracticeState, input: OrderInput, refPrice: number): OrderResult {
  if (!Number.isFinite(input.qty) || input.qty <= 0) {
    return { state, error: '数量必须大于 0' };
  }
  if (input.leverage <= 0) {
    return { state, error: '杠杆必须大于 0' };
  }
  if (input.orderType !== 'market' && (!input.price || input.price <= 0)) {
    return { state, error: '限价/止损单需要价格' };
  }
  if (input.orderType === 'stop' && !input.triggerRef) {
    return { state, error: '止损单需要触发参考（最高/最低）' };
  }

  const pos = state.position;
  if (pos) {
    const oppositeOpen =
      (input.action === 'openLong' && pos.side === 'short') ||
      (input.action === 'openShort' && pos.side === 'long');
    if (oppositeOpen) {
      return { state, error: `持仓方向冲突：当前${pos.side === 'long' ? '多' : '空'}单，请先平仓` };
    }
  }
  if (input.action === 'closeLong' || input.action === 'closeShort') {
    if (!pos) return { state, error: '无持仓，无法下平仓单' };
    const match = input.action === 'closeLong' ? pos.side === 'long' : pos.side === 'short';
    if (!match) return { state, error: '平仓方向与持仓不匹配' };
  }

  const { qtyBase } = orderNotionalAndMargin(
    input.unit,
    input.qty,
    input.leverage,
    state,
    refPrice,
    feeRate(input.orderType)
  );
  if (!Number.isFinite(qtyBase) || qtyBase <= 0) {
    return { state, error: '无法计算下单数量（请检查保证金/余额）' };
  }

  const order: Order = {
    id: nextId('o_'),
    action: input.action,
    orderType: input.orderType,
    qty: qtyBase,
    price: input.orderType === 'market' ? undefined : input.price,
    triggerRef: input.triggerRef,
    leverage: input.leverage,
    createdAtIndex: state.currentIndex,
    reduceOnly: input.action === 'closeLong' || input.action === 'closeShort',
    status: 'active',
  };

  const next = clone(state);
  next.orders.push(order);
  return { state: next, order };
}

export function cancelOrder(state: PracticeState, orderId: string): PracticeState {
  const next = clone(state);
  const o = next.orders.find((x) => x.id === orderId);
  if (o && o.status === 'active') o.status = 'cancelled';
  return next;
}

// ---------------------------------------------------------------------------
// Fill helpers
// ---------------------------------------------------------------------------

function recordFill(state: PracticeState, order: Order, price: number, index: number, ts: number, liq = false): void {
  state.tradeRecords.push({
    id: nextId('r_'),
    action: order.action,
    qty: order.qty,
    price,
    fee: order.fee ?? 0,
    index,
    ts,
    parentOrderId: order.id,
    liq,
  });
}

function openFill(state: PracticeState, order: Order, price: number, index: number, ts: number): boolean {
  const o = state.orders.find((x) => x.id === order.id);
  if (!o || o.status !== 'active') return false;
  const pos = state.position;
  const side = o.action === 'openLong' ? 'long' : 'short';
  const notional = o.qty * price;
  const margin = requiredMargin(notional, o.leverage);
  const fee = notional * feeRate(o.orderType);

  // Insufficient available balance → order ignored.
  if (availableBalance(state) < margin + fee) {
    o.status = 'ignored';
    return false;
  }

  state.balance -= fee;
  if (pos && pos.side === side) {
    // Add to existing position, recompute average & liq (D15).
    const totalQty = pos.qty + o.qty;
    pos.avgPrice = (pos.qty * pos.avgPrice + o.qty * price) / totalQty;
    pos.qty = totalQty;
    pos.margin += margin;
    pos.leverage = o.leverage;
    pos.liqPrice = liqPrice(pos.avgPrice, side, pos.leverage);
  } else {
    state.position = {
      side,
      qty: o.qty,
      avgPrice: price,
      leverage: o.leverage,
      margin,
      liqPrice: liqPrice(price, side, o.leverage),
      realizedPnl: 0,
      openedIndex: index,
    };
  }

  o.status = 'filled';
  o.fillPrice = price;
  o.fillIndex = index;
  o.fee = fee;
  recordFill(state, o, price, index, ts);
  return true;
}

function closeFill(state: PracticeState, order: Order, price: number, index: number, ts: number): boolean {
  const o = state.orders.find((x) => x.id === order.id);
  const pos = state.position;
  if (!o || o.status !== 'active') return false;
  if (!pos) {
    o.status = 'ignored'; // reduce-only with no position → ignored (D16)
    return false;
  }
  const match = o.action === 'closeLong' ? pos.side === 'long' : pos.side === 'short';
  if (!match) {
    o.status = 'ignored';
    return false;
  }

  const closeQty = Math.min(o.qty, pos.qty); // clamp (D16)
  const notional = closeQty * price;
  const fee = notional * feeRate(o.orderType);
  const pnl = pos.side === 'long' ? (price - pos.avgPrice) * closeQty : (pos.avgPrice - price) * closeQty;
  const pnlNet = pnl - fee;

  state.balance += pnlNet;
  pos.realizedPnl += pnlNet;
  pos.qty -= closeQty;
  // Release margin proportionally.
  pos.margin -= pos.margin * (closeQty / (pos.qty + closeQty));
  if (pos.qty < 1e-10) pos.qty = 0;

  o.status = 'filled';
  o.fillPrice = price;
  o.fillIndex = index;
  o.fee = fee;
  o.qty = closeQty;
  recordFill(state, o, price, index, ts);

  if (pos.qty <= 0) {
    state.closedTrades.push({ pnl: round6(pos.realizedPnl), holdIndex: index - pos.openedIndex, liq: false });
    state.position = null;
  }
  return true;
}

function liquidate(state: PracticeState, pos: Position, index: number, ts: number): void {
  state.balance -= pos.margin;
  const liqOrder: Order = {
    id: nextId('o_'),
    action: pos.side === 'long' ? 'closeLong' : 'closeShort',
    orderType: 'market',
    qty: pos.qty,
    leverage: pos.leverage,
    createdAtIndex: pos.openedIndex,
    reduceOnly: true,
    status: 'filled',
    fillPrice: pos.liqPrice,
    fillIndex: index,
    fee: 0,
  };
  state.tradeRecords.push({
    id: nextId('r_'),
    action: pos.side === 'long' ? 'closeLong' : 'closeShort',
    qty: pos.qty,
    price: pos.liqPrice,
    fee: 0,
    index,
    ts,
    parentOrderId: liqOrder.id,
    liq: true,
  });
  state.closedTrades.push({ pnl: -pos.margin, holdIndex: index - pos.openedIndex, liq: true });
  state.position = null;
}

/** Priority of an event (stop) order per D05: liq > stop-loss > take-profit > open. */
function stopPriority(o: Order, pos: Position | null): number {
  if (o.action === 'closeLong' || o.action === 'closeShort') {
    // A close order is not a real event without a position (D16: ignored).
    if (!pos) return 0;
    // stop-loss: for long, price <= avg; for short, price >= avg (worst case first)
    const isSL = o.action === 'closeLong' ? o.price! <= pos.avgPrice : o.price! >= pos.avgPrice;
    return isSL ? 3 : 2;
  }
  return 1; // open
}

// ---------------------------------------------------------------------------
// Advance one bar
// ---------------------------------------------------------------------------

export function advance(state: PracticeState, bar: Bar, index: number, isLastBar: boolean): PracticeState {
  let s = clone(state);

  // --- Stage 1: market orders fill at open (D03) ---
  for (const o of s.orders) {
    if (o.status !== 'active' || o.orderType !== 'market') continue;
    if (o.reduceOnly) closeFill(s, o, bar.o, index, bar.t);
    else openFill(s, o, bar.o, index, bar.t);
  }

  // --- Stage 2: event (stop) orders — at most ONE fires ---
  const pos = s.position;
  let liqHit = false;
  if (pos) {
    liqHit = pos.side === 'long' ? bar.l <= pos.liqPrice : bar.h >= pos.liqPrice;
    if (liqHit) {
      liquidate(s, pos, index, bar.t);
      // Liquidation cancels ALL event orders (D06).
      for (const o of s.orders) if (o.status === 'active' && o.orderType === 'stop') o.status = 'cancelled';
    }
  }
  // Event scan runs with or without a position: open stop orders must be able
  // to trigger (buy stop needs high ≥ price; sell stop needs low ≤ price).
  if (!liqHit) {
    let best: Order | null = null;
    let bestPrio = -1;
    for (const o of s.orders) {
      if (o.status !== 'active' || o.orderType !== 'stop') continue;
      // Reduce-only close orders without a position are ignored, not events.
      if (o.reduceOnly && !s.position) continue;
      const sellSide = o.action === 'openShort' || o.action === 'closeLong';
      const triggered = sellSide ? bar.l <= o.price! : bar.h >= o.price!;
      if (!triggered) continue;
      const prio = stopPriority(o, s.position);
      let isBetter: boolean;
      if (best === null) {
        isBetter = true;
      } else if (prio !== bestPrio) {
        isBetter = prio > bestPrio;
      } else {
        // Same priority layer → earliest created wins (deterministic tie-break).
        isBetter = o.createdAtIndex < best.createdAtIndex ||
          (o.createdAtIndex === best.createdAtIndex && o.id < best.id);
      }
      if (isBetter) {
        best = o;
        bestPrio = prio;
      }
    }
    if (best) {
      const sellSide = best.action === 'openShort' || best.action === 'closeLong';
      const gapFill = sellSide ? bar.o <= best.price! : bar.o >= best.price!;
      const fillPrice = gapFill ? bar.o : best.price!; // D10
      if (best.reduceOnly) closeFill(s, best, fillPrice, index, bar.t);
      else openFill(s, best, fillPrice, index, bar.t);
      // Cancel all other active stop orders (D05).
      for (const o of s.orders) {
        if (o.status === 'active' && o.orderType === 'stop' && o.id !== best.id) o.status = 'cancelled';
      }
    }
  }

  // --- Stage 3: limit orders (may fill multiple, independent of events, D07) ---
  for (const o of s.orders) {
    if (o.status !== 'active' || o.orderType !== 'limit') continue;
    let fillPrice: number | null = null;
    const buy = o.action === 'openLong' || o.action === 'closeShort';
    if (buy) {
      if (bar.o <= o.price!) fillPrice = bar.o; // gap down through limit → open (D08)
      else if (bar.l <= o.price!) fillPrice = o.price!;
    } else {
      if (bar.o >= o.price!) fillPrice = bar.o;
      else if (bar.h >= o.price!) fillPrice = o.price!;
    }
    if (fillPrice !== null) {
      if (o.reduceOnly) closeFill(s, o, fillPrice, index, bar.t);
      else openFill(s, o, fillPrice, index, bar.t);
    }
  }

  // --- Stage 4: finalize ---
  s.currentIndex = index;
  s.equityCurve.push(round6(equity(s, bar.c)));
  if (isLastBar) s.completed = true;
  return s;
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

export function resetToStart(state: PracticeState): PracticeState {
  const next = clone(state);
  next.position = null;
  next.orders = [];
  next.balance = next.initialCapital;
  next.currentIndex = next.startIndex;
  next.equityCurve = [next.initialCapital];
  next.tradeRecords = [];
  next.closedTrades = [];
  next.completed = false;
  next.stats = null;
  // settings (incl. hidden state) preserved (D32)
  return next;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export function computeStats(state: PracticeState): PracticeStats {
  const netPnl = state.balance - state.initialCapital;
  const wins = state.closedTrades.filter((t) => t.pnl > 0);
  const losses = state.closedTrades.filter((t) => t.pnl < 0);
  const decided = wins.length + losses.length;
  const winRate = decided > 0 ? wins.length / decided : 0;
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  const holdMs = state.closedTrades.map((t) => t.holdIndex * state.tfMs);
  const avgHoldTimeMs = holdMs.length > 0 ? holdMs.reduce((a, b) => a + b, 0) / holdMs.length : 0;
  const totalFee = state.tradeRecords.reduce((a, r) => a + r.fee, 0);

  let peak = -Infinity;
  let maxDD = 0;
  for (const v of state.equityCurve) {
    if (v > peak) peak = v;
    if (peak > 0) maxDD = Math.max(maxDD, (peak - v) / peak);
  }

  return {
    netPnl,
    pnlPct: state.initialCapital > 0 ? netPnl / state.initialCapital : 0,
    winRate,
    profitFactor,
    maxDrawdown: maxDD,
    avgHoldTimeMs,
    tradeCount: state.closedTrades.length,
    winCount: wins.length,
    lossCount: losses.length,
    totalFee,
    totalLiqCount: state.closedTrades.filter((t) => t.liq).length,
  };
}

export function finalizeStats(state: PracticeState): PracticeState {
  const next = clone(state);
  next.stats = computeStats(next);
  return next;
}

import { describe, it, expect } from 'vitest';
import {
  createPractice,
  placeOrder,
  advance,
  resetToStart,
  finalizeStats,
} from './engine';
import { aggregate5m } from './aggregate';
import { liqPrice } from './calc';
import type { Bar, PracticeSettings, OrderInput, PracticeState } from './types';

const TF5M = 5 * 60 * 1000;
const TF15M = 15 * 60 * 1000;

/** Build a bar series with simple OHLC semantics from a list of [h,l,o,c]. */
function bars(rows: Array<[number, number, number, number]>, start = 1_600_000_000_000, tf = TF5M): Bar[] {
  return rows.map(([o, h, l, c], i) => ({
    t: start + i * tf,
    o,
    h,
    l,
    c,
    v: 1,
  }));
}

function settings(over: Partial<PracticeSettings> = {}): PracticeSettings {
  return {
    tf: TF5M,
    symbol: 'BTCUSDT',
    startIndex: 0,
    historyCount: 0,
    initialCapital: 1000,
    defaultLeverage: 10,
    ...over,
  };
}

/** Create a fresh practice with an initial market long. */
function practiceWithLong(over?: Partial<PracticeSettings>): PracticeState {
  let s = createPractice(settings(over), 1);
  const res = placeOrder(
    s,
    { action: 'openLong', orderType: 'market', qty: 0.1, unit: 'btcQty', leverage: 10 } as OrderInput,
    100
  );
  return res.state;
}

describe('aggregation', () => {
  it('aggregates 5m into 15m losslessly', () => {
    // start at t=0 so bars align to 15m boundaries (0, 300s, 600s = group)
    const raw = bars(
      [
        [100, 105, 99, 103],
        [103, 107, 102, 106],
        [106, 108, 101, 102],
        [102, 104, 98, 99],
      ],
      0
    );
    const agg = aggregate5m(raw, TF15M);
    expect(agg).toHaveLength(1);
    expect(agg[0].o).toBe(100);
    expect(agg[0].h).toBe(108);
    expect(agg[0].l).toBe(99);
    expect(agg[0].c).toBe(102);
    expect(agg[0].v).toBe(3);
  });

  it('drops partial leading group', () => {
    // bars start at 300s — mid 15m group; first two bars form a partial group
    // that must be dropped; bars 900s/1200s/1500s form a full group.
    const raw = bars(
      [
        [1, 2, 0, 1],
        [2, 3, 1, 2],
        [10, 12, 9, 11],
        [11, 13, 10, 12],
        [12, 14, 11, 13],
      ],
      300_000
    );
    const agg = aggregate5m(raw, TF15M);
    expect(agg).toHaveLength(1);
    expect(agg[0].o).toBe(10);
    expect(agg[0].h).toBe(14);
    expect(agg[0].l).toBe(9);
    expect(agg[0].c).toBe(13);
  });
});

describe('market order fills at next bar open', () => {
  it('market long fills at open of next bar', () => {
    let s = createPractice(settings(), 1);
    const res = placeOrder(
      s,
      { action: 'openLong', orderType: 'market', qty: 1, unit: 'btcQty', leverage: 10 } as OrderInput,
      100
    );
    s = res.state;
    // advance to bar index 1: market order fills at bar.o
    const b = { t: 1_600_000_005_000, o: 110, h: 115, l: 105, c: 112, v: 1 };
    s = advance(s, b, 1, false);
    expect(s.position).not.toBeNull();
    expect(s.position!.avgPrice).toBe(110);
    expect(s.position!.qty).toBe(1);
  });

  it('market close reduces position', () => {
    let s = practiceWithLong();
    // Fill the long at bar 1
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 110, l: 99, c: 108, v: 1 }, 1, false);
    const res = placeOrder(
      s,
      { action: 'closeLong', orderType: 'market', qty: 0.1, unit: 'btcQty', leverage: 10 } as OrderInput,
      s.position!.avgPrice
    );
    s = res.state;
    s = advance(s, { t: 1_600_000_010_000, o: 120, h: 125, l: 118, c: 123, v: 1 }, 2, false);
    expect(s.position).toBeNull();
    expect(s.closedTrades).toHaveLength(1);
    expect(s.closedTrades[0].pnl).toBeGreaterThan(0);
  });
});

describe('event order priority (D05)', () => {
  it('liq > stop-loss close > take-profit close > open', () => {
    let s = practiceWithLong(); // long 0.1 @ ~100
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 102, l: 99, c: 101, v: 1 }, 1, false);
    const avg = s.position!.avgPrice;

    // Take-profit sell-stop above avg (triggerRef low irrelevant for stops);
    // stop-loss sell-stop below avg.
    const tp = placeOrder(
      s,
      { action: 'closeLong', orderType: 'stop', qty: 0.1, unit: 'btcQty', leverage: 10, price: avg * 1.05, triggerRef: 'low' } as OrderInput,
      avg
    );
    s = tp.state;
    const sl = placeOrder(
      s,
      { action: 'closeLong', orderType: 'stop', qty: 0.1, unit: 'btcQty', leverage: 10, price: avg * 0.97, triggerRef: 'low' } as OrderInput,
      avg
    );
    s = sl.state;

    // Bar: low=96 (triggers both SL@97 and TP? no — TP is 105, high=104 never
    // reaches it). Only SL triggers → worst-case SL fires, TP stays active.
    s = advance(s, { t: 1_600_000_010_000, o: 97, h: 104, l: 96, c: 102, v: 1 }, 2, false);
    expect(s.position).toBeNull();
    expect(s.orders.find((o) => o.id === sl.order!.id)!.status).toBe('filled');
    expect(s.orders.find((o) => o.id === tp.order!.id)!.status).toBe('cancelled');
    expect(s.closedTrades[0].pnl).toBeLessThan(0);
  });

  it('stop-loss beats take-profit when both trigger in same bar', () => {
    let s = practiceWithLong(); // long @100
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 1, false);
    const avg = s.position!.avgPrice;
    // SL at 95 (still above liq), TP at 108 — both within bar high/low range
    const sl = placeOrder(
      s,
      { action: 'closeLong', orderType: 'stop', qty: 0.1, unit: 'btcQty', leverage: 10, price: avg * 0.95, triggerRef: 'low' } as OrderInput,
      avg
    );
    s = sl.state;
    const tp = placeOrder(
      s,
      { action: 'closeLong', orderType: 'stop', qty: 0.1, unit: 'btcQty', leverage: 10, price: avg * 1.08, triggerRef: 'low' } as OrderInput,
      avg
    );
    s = tp.state;
    // Bar: low=93, high=110 → both trigger → stop-loss (worst case) wins
    s = advance(s, { t: 1_600_000_010_000, o: 100, h: 110, l: 93, c: 104, v: 1 }, 2, false);
    expect(s.position).toBeNull();
    expect(s.orders.find((o) => o.id === sl.order!.id)!.status).toBe('filled');
    expect(s.orders.find((o) => o.id === tp.order!.id)!.status).toBe('cancelled');
  });

  it('liquidation cancels all event orders', () => {
    let s = practiceWithLong({ defaultLeverage: 10 }); // long @100
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 1, false);
    const liq = s.position!.liqPrice;
    const sl = placeOrder(
      s,
      { action: 'closeLong', orderType: 'stop', qty: 0.1, unit: 'btcQty', leverage: 10, price: liq * 0.99, triggerRef: 'low' } as OrderInput,
      s.position!.avgPrice
    );
    s = sl.state;
    // bar low goes below liq price
    s = advance(s, { t: 1_600_000_010_000, o: liq * 0.95, h: liq * 0.98, l: liq * 0.9, c: liq * 0.96, v: 1 }, 2, false);
    expect(s.position).toBeNull();
    expect(s.closedTrades[0].liq).toBe(true);
    expect(s.orders.find((o) => o.id === sl.order!.id)!.status).toBe('cancelled');
  });
});

describe('limit orders (D07/D08)', () => {
  it('gap through limit fills at open', () => {
    let s = createPractice(settings(), 1);
    const res = placeOrder(
      s,
      { action: 'openLong', orderType: 'limit', qty: 1, unit: 'btcQty', leverage: 10, price: 100 } as OrderInput,
      105
    );
    s = res.state;
    // next bar opens at 95, below limit 100
    s = advance(s, { t: 1_600_000_005_000, o: 95, h: 105, l: 94, c: 102, v: 1 }, 1, false);
    expect(s.position).not.toBeNull();
    expect(s.position!.avgPrice).toBe(95);
  });

  it('limit fills at limit price on touch', () => {
    let s = createPractice(settings(), 1);
    const res = placeOrder(
      s,
      { action: 'openLong', orderType: 'limit', qty: 1, unit: 'btcQty', leverage: 10, price: 100 } as OrderInput,
      105
    );
    s = res.state;
    s = advance(s, { t: 1_600_000_005_000, o: 105, h: 100, l: 99, c: 100.5, v: 1 }, 1, false);
    expect(s.position!.avgPrice).toBe(100);
  });
});

describe('one-way position rules (D14)', () => {
  it('rejects opening short while long', () => {
    let s = practiceWithLong();
    // Fill the market long first.
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 1, false);
    expect(s.position).not.toBeNull();
    const before = s.orders.length;
    const res = placeOrder(
      s,
      { action: 'openShort', orderType: 'market', qty: 1, unit: 'btcQty', leverage: 10 } as OrderInput,
      100
    );
    expect(res.error).toContain('方向冲突');
    expect(res.state.orders.length).toBe(before); // no new order added
  });
});

describe('reduce-only & partial close (D16)', () => {
  it('ignores reduce-only close when no position', () => {
    let s = createPractice(settings(), 1);
    const res = placeOrder(
      s,
      { action: 'closeLong', orderType: 'stop', qty: 1, unit: 'btcQty', leverage: 10, price: 50, triggerRef: 'low' } as OrderInput,
      100
    );
    // Placement of a close order with no position is rejected at placement.
    expect(res.error).toBeTruthy();
  });

  it('partial close clamps and releases margin proportionally', () => {
    let s = practiceWithLong();
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 1, false);
    const marginBefore = s.position!.margin;
    const res = placeOrder(
      s,
      { action: 'closeLong', orderType: 'market', qty: 0.05, unit: 'btcQty', leverage: 10 } as OrderInput,
      s.position!.avgPrice
    );
    s = res.state;
    s = advance(s, { t: 1_600_000_010_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 2, false);
    expect(s.position).not.toBeNull();
    expect(s.position!.qty).toBeCloseTo(0.05, 5);
    expect(s.position!.margin).toBeLessThan(marginBefore);
  });
});

describe('leverage & liquidation price', () => {
  it('computes liq price per Binance isolated formula', () => {
    const entry = 100;
    const lev = 10;
    const mmr = 0.005;
    const liq = liqPrice(entry, 'long', lev);
    expect(liq).toBeCloseTo(entry * (1 - (1 - mmr) / lev), 6);
  });

  it('liquidation consumes the position margin', () => {
    let s = practiceWithLong();
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 1, false);
    const balBefore = s.balance;
    const margin = s.position!.margin;
    s = advance(s, { t: 1_600_000_010_000, o: 50, h: 55, l: 45, c: 50, v: 1 }, 2, false);
    expect(s.position).toBeNull();
    expect(s.closedTrades[0].liq).toBe(true);
    // balance reduced by margin (isolated)
    expect(s.balance).toBeCloseTo(balBefore - margin, 4);
  });
});

describe('fees', () => {
  it('marginPct locks pct% of available balance as margin', () => {
    // Regression: "use 50% of available margin" must lock avail × 0.5 as
    // margin, so available drops by ~50% after fill.
    let s = createPractice(settings({ initialCapital: 1000 }), 1);
    const res = placeOrder(
      s,
      { action: 'openLong', orderType: 'market', qty: 50, unit: 'marginPct', leverage: 10 } as OrderInput,
      100
    );
    s = res.state;
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 1, false);
    expect(s.position).not.toBeNull();
    // margin = avail×0.5 = 500; qty = (1000×0.5×10)/100 = 50 base
    expect(s.position!.qty).toBeCloseTo(50, 6);
    expect(s.position!.margin).toBeCloseTo(500, 4);
    // available = balance - margin ≈ 1000 - fee(100×50×0.0005=2.5) - 500
    const avail = s.balance - s.position!.margin;
    expect(avail).toBeCloseTo(1000 - 2.5 - 500, 4);
  });

  it('notional (USDT) market order fills within margin', () => {
    // Regression: placing an order in USDT notional that fits the balance
    // must actually fill, not be silently ignored (see pct-mode bug).
    let s = createPractice(settings({ initialCapital: 1000 }), 1);
    const res = placeOrder(
      s,
      { action: 'openLong', orderType: 'market', qty: 100, unit: 'notional', leverage: 10 } as OrderInput,
      100
    );
    s = res.state;
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 1, false);
    expect(s.position).not.toBeNull();
    // qty = 100/100 = 1 base
    expect(s.position!.qty).toBeCloseTo(1, 6);
    const o = s.orders[0];
    expect(o.status).toBe('filled');
  });

  it('over-sized notional order is ignored, not filled', () => {
    // 1000 USDT notional @10x → margin 100, but fee 0.5 on top → fits.
    // 100000 USDT notional @10x → margin 10000 > balance → ignored.
    let s = createPractice(settings({ initialCapital: 1000 }), 1);
    const res = placeOrder(
      s,
      { action: 'openLong', orderType: 'market', qty: 100000, unit: 'notional', leverage: 10 } as OrderInput,
      100
    );
    s = res.state;
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 1, false);
    expect(s.position).toBeNull();
    expect(s.orders[0].status).toBe('ignored');
  });

  it('charges taker fee on market orders', () => {
    let s = createPractice(settings(), 1);
    const res = placeOrder(
      s,
      { action: 'openLong', orderType: 'market', qty: 1, unit: 'btcQty', leverage: 10 } as OrderInput,
      100
    );
    s = res.state;
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 1, false);
    // fee = notional * taker(0.0005) = 100 * 0.0005 = 0.05
    expect(s.balance).toBeCloseTo(1000 - 0.05, 5);
  });

  it('charges maker fee on limit orders', () => {
    let s = createPractice(settings(), 1);
    const res = placeOrder(
      s,
      { action: 'openLong', orderType: 'limit', qty: 1, unit: 'btcQty', leverage: 10, price: 100 } as OrderInput,
      105
    );
    s = res.state;
    s = advance(s, { t: 1_600_000_005_000, o: 95, h: 100, l: 94, c: 97, v: 1 }, 1, false);
    // fills at open=95 (gap through limit) → fee = 95 * maker(0.0002) = 0.019
    expect(s.balance).toBeCloseTo(1000 - 95 * 0.0002, 3);
  });
});

describe('reset & stats', () => {
  it('reset returns to start with settings intact', () => {
    let s = practiceWithLong();
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 1, false);
    s = resetToStart(s);
    expect(s.position).toBeNull();
    expect(s.balance).toBe(1000);
    expect(s.currentIndex).toBe(s.startIndex);
    expect(s.hidden).toBe(false);
  });

  it('computes stats with wins/losses', () => {
    // Win trade: long 0.1 @100, close @120 → pnl = (120-100)*0.1 = 2
    // Loss trade: long 0.1 @120, close @100 → pnl = (100-120)*0.1 = -2
    let s = practiceWithLong();
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 1, false);
    const closeWin = placeOrder(
      s,
      { action: 'closeLong', orderType: 'market', qty: 0.1, unit: 'btcQty', leverage: 10 } as OrderInput,
      s.position!.avgPrice
    );
    s = closeWin.state;
    s = advance(s, { t: 1_600_000_010_000, o: 120, h: 125, l: 118, c: 123, v: 1 }, 2, false);
    // open again then lose
    const reopen = placeOrder(
      s,
      { action: 'openLong', orderType: 'market', qty: 0.1, unit: 'btcQty', leverage: 10 } as OrderInput,
      120
    );
    s = reopen.state;
    s = advance(s, { t: 1_600_000_015_000, o: 120, h: 120, l: 120, c: 120, v: 1 }, 3, false);
    const closeLoss = placeOrder(
      s,
      { action: 'closeLong', orderType: 'market', qty: 0.1, unit: 'btcQty', leverage: 10 } as OrderInput,
      s.position!.avgPrice
    );
    s = closeLoss.state;
    s = advance(s, { t: 1_600_000_020_000, o: 100, h: 105, l: 95, c: 102, v: 1 }, 4, false);
    s = finalizeStats(s);
    const st = s.stats!;
    expect(st.tradeCount).toBe(2);
    expect(st.winCount).toBe(1);
    expect(st.lossCount).toBe(1);
    expect(st.winRate).toBe(0.5);
    // qty=0.1: open@100 fee=0.005, close@120 fee=0.006, open@120 fee=0.006,
    // close@100 fee=0.005 → total fee 0.022. net = 2-2-0.022 = -0.022
    expect(st.netPnl).toBeCloseTo(-0.022, 3);
  });
});

describe('serialization round-trip', () => {
  it('state survives JSON clone', () => {
    let s = practiceWithLong();
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 1, false);
    const res = placeOrder(
      s,
      { action: 'openLong', orderType: 'limit', qty: 0.5, unit: 'btcQty', leverage: 10, price: 80 } as OrderInput,
      s.position!.avgPrice
    );
    s = res.state;
    const revived = JSON.parse(JSON.stringify(s)) as PracticeState;
    expect(revived).toEqual(s);
  });
});

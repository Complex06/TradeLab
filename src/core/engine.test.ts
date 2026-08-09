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

describe('liquidation vs stop-loss ordering (D06)', () => {
  it('a protective stop-loss fills before intra-bar liquidation', () => {
    let s = practiceWithLong({ defaultLeverage: 10 }); // long 0.1 @ ~100, liq ≈ 90.05
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 1, false);
    const liq = s.position!.liqPrice;
    const slPrice = (liq + s.position!.avgPrice) / 2; // between entry and liq
    const sl = placeOrder(
      s,
      { action: 'closeLong', orderType: 'stop', qty: 0.1, unit: 'btcQty', leverage: 10, price: slPrice, triggerRef: 'low' } as OrderInput,
      s.position!.avgPrice
    );
    s = sl.state;
    // Bar opens above liq, low dips below both the SL and the liq price.
    s = advance(s, { t: 1_600_000_010_000, o: liq + 2, h: liq + 4, l: liq - 1, c: liq + 1, v: 1 }, 2, false);
    expect(s.position).toBeNull();
    expect(s.orders.find((o) => o.id === sl.order!.id)!.status).toBe('filled');
    expect(s.closedTrades[0].liq).toBe(false);
    expect(s.closedTrades[0].closePrice).toBeGreaterThan(liq); // stopped out, not liquidated
  });

  it('a gap through the liq price liquidates even with a protective stop-loss', () => {
    let s = practiceWithLong({ defaultLeverage: 10 });
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 1, false);
    const liq = s.position!.liqPrice;
    const slPrice = (liq + s.position!.avgPrice) / 2;
    const sl = placeOrder(
      s,
      { action: 'closeLong', orderType: 'stop', qty: 0.1, unit: 'btcQty', leverage: 10, price: slPrice, triggerRef: 'low' } as OrderInput,
      s.position!.avgPrice
    );
    s = sl.state;
    // Bar opens below the liq price → insolvent at open → liquidation.
    s = advance(s, { t: 1_600_000_010_000, o: liq * 0.98, h: liq * 0.99, l: liq * 0.97, c: liq * 0.98, v: 1 }, 2, false);
    expect(s.position).toBeNull();
    expect(s.closedTrades[0].liq).toBe(true);
    expect(s.orders.find((o) => o.id === sl.order!.id)!.status).toBe('cancelled');
  });
});

describe('same-side event ordering (D05)', () => {
  it('two stop-losses on the low side settle by trigger price (higher first)', () => {
    let s = practiceWithLong({ defaultLeverage: 10 });
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 1, false);
    const avg = s.position!.avgPrice;
    const high = placeOrder(
      s,
      { action: 'closeLong', orderType: 'stop', qty: 0.1, unit: 'btcQty', leverage: 10, price: avg * 0.97, triggerRef: 'low' } as OrderInput,
      avg
    );
    s = high.state;
    const low = placeOrder(
      s,
      { action: 'closeLong', orderType: 'stop', qty: 0.1, unit: 'btcQty', leverage: 10, price: avg * 0.95, triggerRef: 'low' } as OrderInput,
      avg
    );
    s = low.state;
    // Bar low 93 is below both stop prices; descending path crosses 97 first.
    // 97 fully closes the position, so 95 is cancelled (no reverse opens).
    s = advance(s, { t: 1_600_000_010_000, o: 100, h: 100, l: 93, c: 94, v: 1 }, 2, false);
    expect(s.orders.find((o) => o.id === high.order!.id)!.status).toBe('filled');
    expect(s.orders.find((o) => o.id === low.order!.id)!.status).toBe('cancelled');
  });

  it('two partial stop-losses on the same side both fill in order', () => {
    let s = createPractice(settings({ initialCapital: 1000 }), 1);
    s = placeOrder(
      s,
      { action: 'openLong', orderType: 'market', qty: 1, unit: 'btcQty', leverage: 10 } as OrderInput,
      100
    ).state;
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 1, false);
    const avg = s.position!.avgPrice;
    const high = placeOrder(
      s,
      { action: 'closeLong', orderType: 'stop', qty: 0.5, unit: 'btcQty', leverage: 10, price: avg * 0.97, triggerRef: 'low' } as OrderInput,
      avg
    );
    s = high.state;
    const low = placeOrder(
      s,
      { action: 'closeLong', orderType: 'stop', qty: 0.5, unit: 'btcQty', leverage: 10, price: avg * 0.95, triggerRef: 'low' } as OrderInput,
      avg
    );
    s = low.state;
    // Both triggered in one bar → settle sequentially, NOT cancelled.
    s = advance(s, { t: 1_600_000_010_000, o: 100, h: 100, l: 93, c: 94, v: 1 }, 2, false);
    expect(s.orders.find((o) => o.id === high.order!.id)!.status).toBe('filled');
    expect(s.orders.find((o) => o.id === low.order!.id)!.status).toBe('filled');
    expect(s.position).toBeNull();
    expect(s.closedTrades).toHaveLength(1);
    expect(s.closedTrades[0].qty).toBeCloseTo(1, 6);
  });

  it('remaining TP/SL orders are cancelled once an event fully closes the position', () => {
    let s = practiceWithLong({ defaultLeverage: 10 });
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 1, false);
    const avg = s.position!.avgPrice;
    const sl = placeOrder(
      s,
      { action: 'closeLong', orderType: 'stop', qty: 0.1, unit: 'btcQty', leverage: 10, price: avg * 0.95, triggerRef: 'low' } as OrderInput,
      avg
    );
    s = sl.state;
    // Resting take-profit (limit) that is NOT reached this bar.
    const tpLimit = placeOrder(
      s,
      { action: 'closeLong', orderType: 'limit', qty: 0.1, unit: 'btcQty', leverage: 10, price: avg * 1.08 } as OrderInput,
      avg
    );
    s = tpLimit.state;
    // Bar: high 102 < TP 108, low 94 ≤ SL 95 → SL fully closes the position.
    s = advance(s, { t: 1_600_000_010_000, o: 100, h: 102, l: 94, c: 96, v: 1 }, 2, false);
    expect(s.position).toBeNull();
    expect(s.orders.find((o) => o.id === sl.order!.id)!.status).toBe('filled');
    expect(s.orders.find((o) => o.id === tpLimit.order!.id)!.status).toBe('cancelled');
  });

  it('an opposite-side open order cannot replace an existing position (one-way)', () => {
    let s = createPractice(settings({ initialCapital: 1000 }), 1);
    // Resting openShort stop placed while flat.
    const short = placeOrder(
      s,
      { action: 'openShort', orderType: 'stop', qty: 1, unit: 'btcQty', leverage: 10, price: 95, triggerRef: 'low' } as OrderInput,
      100
    );
    s = short.state;
    // Open a long with a market order (fills at bar 1 open).
    s = placeOrder(
      s,
      { action: 'openLong', orderType: 'market', qty: 1, unit: 'btcQty', leverage: 10 } as OrderInput,
      100
    ).state;
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 1, false);
    // Bar 2: low 94 triggers the openShort stop, but the long must not be
    // replaced (liq 90.05 is not touched).
    s = advance(s, { t: 1_600_000_010_000, o: 96, h: 97, l: 94, c: 95, v: 1 }, 2, false);
    expect(s.position?.side).toBe('long');
    expect(s.orders.find((o) => o.id === short.order!.id)!.status).toBe('ignored');
  });

  it('two take-profit stops on the high side settle by trigger price (lower first)', () => {
    let s = practiceWithLong({ defaultLeverage: 10 });
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 1, false);
    const avg = s.position!.avgPrice;
    const lowTp = placeOrder(
      s,
      { action: 'closeLong', orderType: 'stop', qty: 0.1, unit: 'btcQty', leverage: 10, price: avg * 1.08, triggerRef: 'low' } as OrderInput,
      avg
    );
    s = lowTp.state;
    const highTp = placeOrder(
      s,
      { action: 'closeLong', orderType: 'stop', qty: 0.1, unit: 'btcQty', leverage: 10, price: avg * 1.12, triggerRef: 'low' } as OrderInput,
      avg
    );
    s = highTp.state;
    // Bar low 105 triggers both (low ≤ 108); 108 fills, 112 is cancelled after
    // the position is fully closed (same side, settled in order).
    s = advance(s, { t: 1_600_000_010_000, o: 100, h: 115, l: 105, c: 110, v: 1 }, 2, false);
    expect(s.orders.find((o) => o.id === lowTp.order!.id)!.status).toBe('filled');
    expect(s.orders.find((o) => o.id === highTp.order!.id)!.status).toBe('cancelled');
  });
});

describe('scenario coverage (G/N enumeration)', () => {
  it('G2: bar opens through the stop-loss but above liq → SL fills at open', () => {
    let s = practiceWithLong({ defaultLeverage: 10 }); // long 0.1 @ 100, liq 90.05
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 1, false);
    const avg = s.position!.avgPrice;
    const sl = placeOrder(
      s,
      { action: 'closeLong', orderType: 'stop', qty: 0.1, unit: 'btcQty', leverage: 10, price: avg * 0.95, triggerRef: 'low' } as OrderInput,
      avg
    );
    s = sl.state;
    // Open 93: above liq (90.05), at/below SL (95) → SL gap-fills at 93.
    s = advance(s, { t: 1_600_000_010_000, o: 93, h: 96, l: 92, c: 94, v: 1 }, 2, false);
    expect(s.position).toBeNull();
    expect(s.orders.find((o) => o.id === sl.order!.id)!.status).toBe('filled');
    expect(s.closedTrades[0].liq).toBe(false);
    expect(s.closedTrades[0].closePrice).toBeCloseTo(93, 4);
  });

  it('G3: bar opens through the take-profit → TP (limit) fills at open', () => {
    let s = practiceWithLong();
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 1, false);
    const tp = placeOrder(
      s,
      { action: 'closeLong', orderType: 'limit', qty: 0.1, unit: 'btcQty', leverage: 10, price: 105 } as OrderInput,
      s.position!.avgPrice
    );
    s = tp.state;
    // Open 108 ≥ limit 105 → sell limit fills at the open.
    s = advance(s, { t: 1_600_000_010_000, o: 108, h: 110, l: 106, c: 109, v: 1 }, 2, false);
    expect(s.position).toBeNull();
    expect(s.orders.find((o) => o.id === tp.order!.id)!.status).toBe('filled');
    expect(s.closedTrades[0].closePrice).toBeCloseTo(108, 4);
  });

  it('N1: take-profit (limit) fills at the limit price on touch', () => {
    let s = practiceWithLong();
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 1, false);
    const tp = placeOrder(
      s,
      { action: 'closeLong', orderType: 'limit', qty: 0.1, unit: 'btcQty', leverage: 10, price: 105 } as OrderInput,
      s.position!.avgPrice
    );
    s = tp.state;
    s = advance(s, { t: 1_600_000_010_000, o: 102, h: 106, l: 101, c: 105, v: 1 }, 2, false);
    expect(s.position).toBeNull();
    expect(s.closedTrades[0].closePrice).toBeCloseTo(105, 4);
  });

  it('N6: protective partial SL fills, then the remainder is liquidated', () => {
    let s = createPractice(settings({ initialCapital: 1000 }), 1);
    s = placeOrder(
      s,
      { action: 'openLong', orderType: 'market', qty: 1, unit: 'btcQty', leverage: 10 } as OrderInput,
      100
    ).state;
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 1, false);
    const avg = s.position!.avgPrice;
    const sl = placeOrder(
      s,
      { action: 'closeLong', orderType: 'stop', qty: 0.5, unit: 'btcQty', leverage: 10, price: avg * 0.95, triggerRef: 'low' } as OrderInput,
      avg
    );
    s = sl.state;
    // Low 88 crosses SL (95) and liq (90.05): SL fills 0.5 @95, rest liquidates.
    s = advance(s, { t: 1_600_000_010_000, o: 100, h: 100, l: 88, c: 90, v: 1 }, 2, false);
    expect(s.position).toBeNull();
    expect(s.orders.find((o) => o.id === sl.order!.id)!.status).toBe('filled');
    expect(s.closedTrades).toHaveLength(1);
    const t = s.closedTrades[0];
    expect(t.liq).toBe(true);
    expect(t.qty).toBeCloseTo(1, 6);
    expect(t.closePrice).toBeCloseTo(90.05, 4); // liquidation price of the remainder
    // Accounting invariant: balance = initial − openFee + round-trip pnl.
    const openFee = s.tradeRecords[0].fee;
    expect(s.balance).toBeCloseTo(1000 - openFee + t.pnl, 3);
    expect(t.fee).toBeGreaterThan(openFee);
  });

  it('N7: TP + liq both touched (cross-side) → liquidation wins, TP cancelled', () => {
    let s = practiceWithLong({ defaultLeverage: 10 });
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 1, false);
    const tp = placeOrder(
      s,
      { action: 'closeLong', orderType: 'stop', qty: 0.1, unit: 'btcQty', leverage: 10, price: 108, triggerRef: 'low' } as OrderInput,
      s.position!.avgPrice
    );
    s = tp.state;
    // High 112 ≥ TP, low 88 ≤ liq → path ambiguous → liq priority.
    s = advance(s, { t: 1_600_000_010_000, o: 100, h: 112, l: 88, c: 95, v: 1 }, 2, false);
    expect(s.position).toBeNull();
    expect(s.closedTrades[0].liq).toBe(true);
    expect(s.orders.find((o) => o.id === tp.order!.id)!.status).toBe('cancelled');
  });

  it('N9: TP + SL + liq all touched → SL settles, remainder liquidates, TP cancelled', () => {
    let s = createPractice(settings({ initialCapital: 1000 }), 1);
    s = placeOrder(
      s,
      { action: 'openLong', orderType: 'market', qty: 1, unit: 'btcQty', leverage: 10 } as OrderInput,
      100
    ).state;
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 1, false);
    const avg = s.position!.avgPrice;
    const sl = placeOrder(
      s,
      { action: 'closeLong', orderType: 'stop', qty: 0.5, unit: 'btcQty', leverage: 10, price: avg * 0.95, triggerRef: 'low' } as OrderInput,
      avg
    );
    s = sl.state;
    const tp = placeOrder(
      s,
      { action: 'closeLong', orderType: 'stop', qty: 0.5, unit: 'btcQty', leverage: 10, price: avg * 1.08, triggerRef: 'low' } as OrderInput,
      avg
    );
    s = tp.state;
    // High 112 ≥ TP, low 88 ≤ SL and ≤ liq: SL side first, remainder liq, TP cancelled.
    s = advance(s, { t: 1_600_000_010_000, o: 100, h: 112, l: 88, c: 95, v: 1 }, 2, false);
    expect(s.position).toBeNull();
    expect(s.orders.find((o) => o.id === sl.order!.id)!.status).toBe('filled');
    expect(s.orders.find((o) => o.id === tp.order!.id)!.status).toBe('cancelled');
    expect(s.closedTrades[0].liq).toBe(true);
    expect(s.closedTrades[0].qty).toBeCloseTo(1, 6);
    const openFee = s.tradeRecords[0].fee;
    expect(s.balance).toBeCloseTo(1000 - openFee + s.closedTrades[0].pnl, 3);
  });

  it('N8: cross-side TP + SL — a partial SL lets the TP fill the remainder', () => {
    let s = createPractice(settings({ initialCapital: 1000 }), 1);
    s = placeOrder(
      s,
      { action: 'openLong', orderType: 'market', qty: 1, unit: 'btcQty', leverage: 10 } as OrderInput,
      100
    ).state;
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 1, false);
    const avg = s.position!.avgPrice;
    const sl = placeOrder(
      s,
      { action: 'closeLong', orderType: 'stop', qty: 0.5, unit: 'btcQty', leverage: 10, price: avg * 0.95, triggerRef: 'low' } as OrderInput,
      avg
    );
    s = sl.state;
    const tp = placeOrder(
      s,
      { action: 'closeLong', orderType: 'stop', qty: 0.5, unit: 'btcQty', leverage: 10, price: avg * 1.08, triggerRef: 'low' } as OrderInput,
      avg
    );
    s = tp.state;
    // Low 93 crosses both; liq (90.05) not touched → SL fills 0.5, TP fills 0.5.
    s = advance(s, { t: 1_600_000_010_000, o: 100, h: 112, l: 93, c: 102, v: 1 }, 2, false);
    expect(s.position).toBeNull();
    expect(s.orders.find((o) => o.id === sl.order!.id)!.status).toBe('filled');
    expect(s.orders.find((o) => o.id === tp.order!.id)!.status).toBe('filled');
    expect(s.closedTrades[0].liq).toBe(false);
    expect(s.closedTrades[0].qty).toBeCloseTo(1, 6);
  });

  it('N5: two partial take-profits on the same side both fill in order', () => {
    let s = createPractice(settings({ initialCapital: 1000 }), 1);
    s = placeOrder(
      s,
      { action: 'openLong', orderType: 'market', qty: 1, unit: 'btcQty', leverage: 10 } as OrderInput,
      100
    ).state;
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 1, false);
    const avg = s.position!.avgPrice;
    const tpLow = placeOrder(
      s,
      { action: 'closeLong', orderType: 'stop', qty: 0.5, unit: 'btcQty', leverage: 10, price: avg * 1.08, triggerRef: 'low' } as OrderInput,
      avg
    );
    s = tpLow.state;
    const tpHigh = placeOrder(
      s,
      { action: 'closeLong', orderType: 'stop', qty: 0.5, unit: 'btcQty', leverage: 10, price: avg * 1.12, triggerRef: 'low' } as OrderInput,
      avg
    );
    s = tpHigh.state;
    // Low 105 triggers both (no liq touch) → both fill sequentially.
    s = advance(s, { t: 1_600_000_010_000, o: 100, h: 115, l: 105, c: 110, v: 1 }, 2, false);
    expect(s.orders.find((o) => o.id === tpLow.order!.id)!.status).toBe('filled');
    expect(s.orders.find((o) => o.id === tpHigh.order!.id)!.status).toBe('filled');
    expect(s.position).toBeNull();
    expect(s.closedTrades[0].qty).toBeCloseTo(1, 6);
  });

  it('N10: nothing touched → close stop stays active', () => {
    let s = practiceWithLong();
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 1, false);
    const sl = placeOrder(
      s,
      { action: 'closeLong', orderType: 'stop', qty: 0.1, unit: 'btcQty', leverage: 10, price: 95, triggerRef: 'low' } as OrderInput,
      s.position!.avgPrice
    );
    s = sl.state;
    s = advance(s, { t: 1_600_000_010_000, o: 100, h: 101, l: 97, c: 98, v: 1 }, 2, false);
    expect(s.position).not.toBeNull();
    expect(s.orders.find((o) => o.id === sl.order!.id)!.status).toBe('active');
  });
});

describe('open stop (conditional) orders trigger without a position', () => {
  it('buy stop opens a long when high crosses the trigger', () => {
    let s = createPractice(settings(), 1);
    const res = placeOrder(
      s,
      { action: 'openLong', orderType: 'stop', qty: 1, unit: 'btcQty', leverage: 10, price: 105, triggerRef: 'high' } as OrderInput,
      100
    );
    s = res.state;
    // Bar high 108 >= 105 triggers; open 106 >= 105 → fills at open (D10).
    s = advance(s, { t: 1_600_000_005_000, o: 106, h: 108, l: 104, c: 107, v: 1 }, 1, false);
    expect(s.position).not.toBeNull();
    expect(s.position!.side).toBe('long');
    expect(s.position!.avgPrice).toBe(106);
    expect(s.orders[0].status).toBe('filled');
  });

  it('buy stop fills at the trigger price when the bar opens below it', () => {
    let s = createPractice(settings(), 1);
    const res = placeOrder(
      s,
      { action: 'openLong', orderType: 'stop', qty: 1, unit: 'btcQty', leverage: 10, price: 105, triggerRef: 'high' } as OrderInput,
      100
    );
    s = res.state;
    // Open 103 < 105, high 106 >= 105 → fill at trigger 105 (D10).
    s = advance(s, { t: 1_600_000_005_000, o: 103, h: 106, l: 102, c: 105, v: 1 }, 1, false);
    expect(s.position).not.toBeNull();
    expect(s.position!.avgPrice).toBe(105);
  });

  it('sell stop opens a short when low crosses the trigger', () => {
    let s = createPractice(settings(), 1);
    const res = placeOrder(
      s,
      { action: 'openShort', orderType: 'stop', qty: 1, unit: 'btcQty', leverage: 10, price: 95, triggerRef: 'low' } as OrderInput,
      100
    );
    s = res.state;
    // Open 94 <= 95 → gap fill at open (D10).
    s = advance(s, { t: 1_600_000_005_000, o: 94, h: 97, l: 92, c: 95, v: 1 }, 1, false);
    expect(s.position).not.toBeNull();
    expect(s.position!.side).toBe('short');
    expect(s.position!.avgPrice).toBe(94);
  });

  it('stays active when the bar never crosses the trigger price', () => {
    let s = createPractice(settings(), 1);
    const res = placeOrder(
      s,
      { action: 'openLong', orderType: 'stop', qty: 1, unit: 'btcQty', leverage: 10, price: 105, triggerRef: 'high' } as OrderInput,
      100
    );
    s = res.state;
    s = advance(s, { t: 1_600_000_005_000, o: 102, h: 104, l: 101, c: 103, v: 1 }, 1, false);
    expect(s.position).toBeNull();
    expect(s.orders[0].status).toBe('active');
  });

  it('only the earliest-created open stop fires when several trigger in one bar', () => {
    let s = createPractice(settings(), 1);
    const a = placeOrder(
      s,
      { action: 'openLong', orderType: 'stop', qty: 1, unit: 'btcQty', leverage: 10, price: 105, triggerRef: 'high' } as OrderInput,
      100
    );
    s = a.state;
    const b = placeOrder(
      s,
      { action: 'openLong', orderType: 'stop', qty: 1, unit: 'btcQty', leverage: 10, price: 106, triggerRef: 'high' } as OrderInput,
      100
    );
    s = b.state;
    // Bar: open 107 >= both triggers → earliest (105) wins, the other cancels.
    s = advance(s, { t: 1_600_000_005_000, o: 107, h: 110, l: 106, c: 109, v: 1 }, 1, false);
    expect(s.orders.find((o) => o.id === a.order!.id)!.status).toBe('filled');
    expect(s.orders.find((o) => o.id === b.order!.id)!.status).toBe('cancelled');
    expect(s.position!.qty).toBe(1);
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

  it('marginUsdt amount is fee-inclusive: fee comes out of the invested amount', () => {
    // Invest 200 USDT at 10x, taker fee 0.05%:
    // actual margin = 200/(1+10×0.0005) ≈ 199.005; fee ≈ 0.995, so
    // margin + fee = invested amount exactly.
    let s = createPractice(settings({ initialCapital: 1000 }), 1);
    const res = placeOrder(
      s,
      { action: 'openLong', orderType: 'market', qty: 200, unit: 'marginUsdt', leverage: 10 } as OrderInput,
      100
    );
    s = res.state;
    const expectedMargin = 200 / (1 + 10 * 0.0005);
    // qtyBase × refPrice = notional = margin × leverage
    expect(s.orders[0].qty * 100).toBeCloseTo(expectedMargin * 10, 4);
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 1, false);
    expect(s.position).not.toBeNull();
    expect(s.position!.margin).toBeCloseTo(expectedMargin, 4);
    expect(s.position!.margin + (s.orders[0].fee ?? 0)).toBeCloseTo(200, 4);
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

describe('closed trade history', () => {
  it('records side, prices, qty, fees and hold time on a round trip', () => {
    let s = createPractice(settings({ initialCapital: 1000 }), 1);
    s = placeOrder(
      s,
      { action: 'openLong', orderType: 'market', qty: 1, unit: 'btcQty', leverage: 10 } as OrderInput,
      100
    ).state;
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 105, l: 99, c: 103, v: 1 }, 1, false);
    s = placeOrder(
      s,
      { action: 'closeLong', orderType: 'market', qty: 1, unit: 'btcQty', leverage: 10 } as OrderInput,
      s.position!.avgPrice
    ).state;
    s = advance(s, { t: 1_600_000_010_000, o: 110, h: 112, l: 108, c: 111, v: 1 }, 2, false);

    expect(s.closedTrades).toHaveLength(1);
    const t = s.closedTrades[0];
    expect(t.side).toBe('long');
    expect(t.qty).toBeCloseTo(1, 6);
    expect(t.openPrice).toBeCloseTo(100, 4);
    expect(t.closePrice).toBeCloseTo(110, 4);
    expect(t.holdIndex).toBe(1); // opened bar 1 → closed bar 2
    expect(t.openedAt).toBe(1);
    expect(t.closedAt).toBe(2);
    expect(t.fee).toBeCloseTo(100 * 0.0005 + 110 * 0.0005, 5); // open + close fees
    expect(t.pnl).toBeGreaterThan(0);
    expect(t.liq).toBe(false);
  });

  it('partial closes accumulate into one history entry', () => {
    let s = createPractice(settings({ initialCapital: 1000 }), 1);
    s = placeOrder(
      s,
      { action: 'openLong', orderType: 'market', qty: 1, unit: 'btcQty', leverage: 10 } as OrderInput,
      100
    ).state;
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 1, false);
    // Close 40% at bar 2 open.
    s = placeOrder(
      s,
      { action: 'closeLong', orderType: 'market', qty: 0.4, unit: 'btcQty', leverage: 10 } as OrderInput,
      100
    ).state;
    s = advance(s, { t: 1_600_000_010_000, o: 110, h: 112, l: 108, c: 111, v: 1 }, 2, false);
    // Close the remaining 60% at bar 3 open.
    s = placeOrder(
      s,
      { action: 'closeLong', orderType: 'market', qty: 1, unit: 'btcQty', leverage: 10 } as OrderInput,
      110
    ).state;
    s = advance(s, { t: 1_600_000_015_000, o: 120, h: 122, l: 118, c: 121, v: 1 }, 3, false);

    expect(s.closedTrades).toHaveLength(1);
    expect(s.closedTrades[0].qty).toBeCloseTo(1, 6);
    expect(s.closedTrades[0].fee).toBeGreaterThan(0);
    expect(s.closedTrades[0].holdIndex).toBe(2);
  });

  it('liquidation history marks liq with the liquidation price', () => {
    let s = practiceWithLong({ defaultLeverage: 10 }); // long 0.1 @ 100
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 1, false);
    const liq = s.position!.liqPrice;
    s = advance(s, { t: 1_600_000_010_000, o: liq * 0.98, h: liq * 0.99, l: liq * 0.97, c: liq * 0.98, v: 1 }, 2, false);

    expect(s.closedTrades).toHaveLength(1);
    expect(s.closedTrades[0].liq).toBe(true);
    expect(s.closedTrades[0].closePrice).toBeCloseTo(liq, 4);
    expect(s.closedTrades[0].qty).toBeCloseTo(0.1, 6);
    expect(s.closedTrades[0].fee).toBeGreaterThan(0); // opening fee only
  });

  it('liquidation after a partial close keeps the realized PnL in history', () => {
    let s = createPractice(settings({ initialCapital: 1000 }), 1);
    s = placeOrder(
      s,
      { action: 'openLong', orderType: 'market', qty: 400, unit: 'marginUsdt', leverage: 10 } as OrderInput,
      100
    ).state;
    const openQty = s.orders[0].qty;
    s = advance(s, { t: 1_600_000_005_000, o: 100, h: 100, l: 100, c: 100, v: 1 }, 1, false);
    // Close half at bar 2 open (110) → realize a profit.
    s = placeOrder(
      s,
      { action: 'closeLong', orderType: 'market', qty: s.position!.qty / 2, unit: 'btcQty', leverage: 10 } as OrderInput,
      100
    ).state;
    s = advance(s, { t: 1_600_000_010_000, o: 110, h: 112, l: 108, c: 111, v: 1 }, 2, false);
    const realizedBeforeLiq = s.position!.realizedPnl;
    const marginAtLiq = s.position!.margin;
    const liq = s.position!.liqPrice;
    // Liquidate the remainder at bar 3.
    s = advance(s, { t: 1_600_000_015_000, o: liq * 0.98, h: liq * 0.99, l: liq * 0.97, c: liq * 0.98, v: 1 }, 3, false);

    expect(s.closedTrades).toHaveLength(1);
    const t = s.closedTrades[0];
    expect(t.liq).toBe(true);
    // The history pnl must be the round-trip net: prior realized − liq loss.
    expect(t.pnl).toBeCloseTo(realizedBeforeLiq - marginAtLiq, 4);
    // And it must be consistent with the actual balance change.
    const openFee = s.tradeRecords[0].fee;
    expect(s.balance).toBeCloseTo(1000 - openFee + t.pnl, 2);
    // Quantity covers the whole round trip, not just the liquidated remainder.
    expect(t.qty).toBeCloseTo(openQty, 3);
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

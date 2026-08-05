// TradeLab core types — pure data, fully JSON-serializable (no closures,
// no DOM refs). See PLAN.md §5.

export interface Bar {
  t: number; // bar open time (ms), UTC-aligned
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type Side = 'long' | 'short';

export type Action = 'openLong' | 'openShort' | 'closeLong' | 'closeShort';

export type OrderType = 'market' | 'limit' | 'stop';

export type OrderStatus = 'active' | 'filled' | 'cancelled' | 'ignored';

export interface Position {
  side: Side;
  qty: number;
  avgPrice: number;
  leverage: number;
  margin: number; // margin currently locked in this position
  liqPrice: number;
  realizedPnl: number; // cumulative realized PnL of this position (partial closes)
  openedIndex: number; // bar index at which the position was opened
}

export interface Order {
  id: string;
  action: Action;
  orderType: OrderType;
  qty: number;
  price?: number; // limit price or stop trigger price
  triggerRef?: 'high' | 'low'; // stop trigger reference (bar of order creation)
  leverage: number; // per-order leverage at placement (D19)
  createdAtIndex: number;
  reduceOnly: boolean;
  status: OrderStatus;
  fillPrice?: number;
  fillIndex?: number;
  fee?: number;
}

export interface OrderInput {
  action: Action;
  orderType: OrderType;
  qty: number; // in the chosen unit
  unit: QuantityUnit;
  price?: number; // required for limit/stop
  triggerRef?: 'high' | 'low'; // required for stop
  leverage: number;
}

export interface ClosedTrade {
  pnl: number; // realized PnL incl. fees
  holdIndex: number; // bars held
  liq: boolean; // closed by liquidation
}

export interface TradeRecord {
  id: string;
  action: Action;
  qty: number;
  price: number;
  fee: number;
  index: number; // bar index of fill
  ts: number; // timestamp of the fill (bar open time)
  parentOrderId?: string;
  liq?: boolean; // true if this fill was a liquidation
}

export interface PracticeStats {
  netPnl: number;
  pnlPct: number;
  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
  avgHoldTimeMs: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  totalFee: number;
  totalLiqCount: number;
}

export interface PracticeSettings {
  tf: number; // bar interval ms (5m/10m/15m/30m/1h/4h/1d)
  symbol: string;
  startIndex: number; // bar index of the practice start (the "T" bar)
  historyCount: number; // background historical bars shown before T
  initialCapital: number;
  defaultLeverage: number;
}

export interface PracticeState {
  version: number;
  sessionId: string;
  seed: number;
  settings: PracticeSettings;
  symbol: string;
  tfMs: number;
  startIndex: number;
  currentIndex: number; // index of the bar being displayed (T ..)
  historyCount: number;
  position: Position | null;
  orders: Order[];
  balance: number; // realized equity (withdrawable)
  initialCapital: number;
  equityCurve: number[];
  tradeRecords: TradeRecord[];
  closedTrades: ClosedTrade[];
  hidden: boolean; // hide symbol + date until reveal (D26/D32)
  revealed: boolean;
  completed: boolean;
  stats: PracticeStats | null;
}

export interface Dataset {
  symbol: string;
  bars: Bar[]; // 5m bars only
  importedAt: number;
}

export type QuantityUnit =
  | 'btcQty' // nominal BTC quantity
  | 'notional' // nominal USDT amount
  | 'marginUsdt' // margin invested in USDT
  | 'marginPct'; // margin as % of available balance

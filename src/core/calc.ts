// Position / margin / liquidation / fee math. See PLAN.md D11–D18.

import type { OrderType } from './types';

export const FEE_TAKER = 0.0005; // 0.05%
export const FEE_MAKER = 0.0002; // 0.02%
export const MMR = 0.005; // maintenance margin rate (flat, S01)
export const PRICE_DECIMALS = 8;

export function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** Binance-style isolated liquidation price. Uses the position's average
 *  entry price and leverage, with a flat MMR. See PLAN.md D11. */
export function liqPrice(entry: number, side: 'long' | 'short', leverage: number): number {
  if (leverage <= 0 || entry <= 0) return NaN;
  const factor = (1 - MMR) / leverage;
  return side === 'long' ? entry * (1 - factor) : entry * (1 + factor);
}

/** Fee rate for an order type: limit=maker, market/stop=taker. */
export function feeRate(orderType: OrderType): number {
  return orderType === 'limit' ? FEE_MAKER : FEE_TAKER;
}

/** Unrealized PnL of a position at a reference price. */
export function unrealizedPnl(side: 'long' | 'short', qty: number, avg: number, ref: number): number {
  return side === 'long' ? (ref - avg) * qty : (avg - ref) * qty;
}

/** Margin needed to open a position of qty at price with leverage. */
export function requiredMargin(notional: number, leverage: number): number {
  return notional / leverage;
}

/** How much a filled order of given notional costs in fees. */
export function orderFee(notional: number, orderType: OrderType): number {
  return notional * feeRate(orderType);
}

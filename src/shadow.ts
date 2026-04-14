/**
 * shadow.ts — Simulates bets without real orders.
 */

import { log } from "./logger.js";
import { getTokenPrice } from "./websocket.js";
import type { ActiveBet, Market, BetRule } from "./types.js";

function generateId(): string {
  return `shadow-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function simulateBet(market: Market, slotId: number, stakeUsd: number, rule: BetRule): ActiveBet {
  const betId = generateId();
  const price = market.winSidePrice;
  const expectedPayoutUsd = Math.round((stakeUsd / price) * 100) / 100;

  // Capture the best bid at entry as the TP/SL baseline.
  // The ask (priceAtBet) is always higher than the bid due to spread,
  // so deltas must be measured from the bid to be meaningful.
  const bidAtEntry = getTokenPrice(market.tokenIdToBuy)?.bestBid ?? price;

  const bet: ActiveBet = {
    betId, market, slotId, stakeUsd, expectedPayoutUsd,
    orderId: undefined,
    placedAt: new Date().toISOString(),
    shadow: true,
    side: market.winSide,
    priceAtBet: price,
    bidPriceAtBet: bidAtEntry,
    rule,
  };

  log.info("SHADOW_BET_SIMULATED", {
    betId, slotId, marketId: market.id,
    question: market.question, asset: market.asset,
    duration: market.duration, winSide: market.winSide,
    priceAtBet: price, stakeUsd, expectedPayoutUsd,
    closesAt: market.closesAt,
    timeRemainingSeconds: market.timeRemainingSeconds,
    rule,
  });

  return bet;
}
/**
 * shadow.ts
 *
 * Shadow mode: simulate a bet without spending real money.
 * Only responsible for creating the fake ActiveBet object.
 *
 * Resolution watching has moved to trader.ts (startFallbackResolutionWatcher),
 * which handles both shadow and live bets identically. The WebSocket
 * market_resolved event is the primary resolution mechanism; the fallback
 * poll in trader.ts covers the case where the WS event is missed.
 */

import { CONFIG } from "./config.js";
import { log } from "./logger.js";
import type { ActiveBet, Market } from "./types.js";

function generateId(): string {
  return `shadow-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Simulate placing a bet. Returns a fake ActiveBet with shadow: true.
 * Does not interact with the blockchain or CLOB API.
 */
export function simulateBet(market: Market, slotId: number, stakeUsd: number): ActiveBet {
  const betId = generateId();
  const price = market.winSidePrice;
  const expectedPayoutUsd = Math.floor((stakeUsd / price) * 100) / 100;

  const bet: ActiveBet = {
    betId,
    market,
    slotId,
    stakeUsd,
    expectedPayoutUsd,
    orderId: undefined,
    placedAt: new Date().toISOString(),
    shadow: true,
    side: market.winSide,
    priceAtBet: price,
  };

  log.info("SHADOW_BET_SIMULATED", {
    betId,
    slotId,
    marketId: market.id,
    question: market.question,
    asset: market.asset,
    duration: market.duration,
    winSide: market.winSide,
    priceAtBet: price,
    stakeUsd,
    expectedPayoutUsd,
    closesAt: market.closesAt,
    timeRemainingSeconds: market.timeRemainingSeconds,
  });

  return bet;
}
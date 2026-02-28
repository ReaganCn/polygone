/**
 * shadow.ts
 *
 * Shadow mode: simulate bets without spending real money.
 *
 * When shadow mode is enabled:
 *   - "Orders" are logged but no on-chain transactions occur.
 *   - The real market's resolution is polled from the Gamma API.
 *   - The slot state machine is driven exactly the same as in live mode,
 *     so compounding, profit extraction, and loss resets all work identically.
 *
 * This makes shadow mode useful for validating your strategy before going live.
 *
 * All shadow log events are tagged with shadow: true (set by logger.ts via CONFIG).
 */

import { CONFIG } from "./config.js";
import { log } from "./logger.js";
import { fetchMarketResolution } from "./polymarket.js";
import { recordWin, recordLoss } from "./slots.js";
import { untrackMarket } from "./scanner.js";
import type { ActiveBet, Market } from "./types.js";

// ─── helper ───────────────────────────────────────────────────────────────────

function generateId(): string {
  return `shadow-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ─── public API ───────────────────────────────────────────────────────────────

/**
 * Simulate placing a bet. Returns a fake ActiveBet with shadow: true.
 * Does not interact with the blockchain or CLOB API.
 */
export function simulateBet(market: Market, slotId: number, stakeUsd: number): ActiveBet {
  const betId = generateId();
  const price = market.winSidePrice;

  // Expected payout = stake / price (buying tokens at price, each pays $1 on win)
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

/**
 * Begin polling the real Gamma API for market resolution.
 * When resolved, drives the slot machine (win or loss) and cleans up.
 *
 * @param bet - the shadow bet to track
 */
export function watchShadowBet(bet: ActiveBet): void {
  const pollInterval = CONFIG.resolutionPollIntervalMs;

  log.info("RESOLUTION_POLLING", {
    betId: bet.betId,
    marketId: bet.market.id,
    pollIntervalMs: pollInterval,
    shadow: true,
  });

  const poll = setInterval(async () => {
    try {
      const resolution = await fetchMarketResolution(bet.market.id, bet.side);

      if (resolution.outcome === "PENDING") {
        // Not resolved yet — keep polling
        return;
      }

      clearInterval(poll);

      if (resolution.outcome === "CANCELLED") {
        // Treat cancelled as a loss (worst case)
        log.warn("RESOLUTION_LOSS", {
          betId: bet.betId,
          marketId: bet.market.id,
          outcome: "CANCELLED",
          betSide: bet.side,
          note: "Market cancelled — treating as loss for conservative accounting.",
          shadow: true,
        });
        recordLoss(bet.slotId);
        untrackMarket(bet.market.id);
        return;
      }

      const won = resolution.outcome === bet.side;

      if (won) {
        // Payout = tokens bought × $1.00 per token
        const tokensBought = bet.stakeUsd / bet.priceAtBet;
        const payoutUsd = Math.floor(tokensBought * 100) / 100;

        log.info("SHADOW_RESOLUTION_WIN", {
          betId: bet.betId,
          slotId: bet.slotId,
          marketId: bet.market.id,
          question: bet.market.question,
          betSide: bet.side,
          outcome: resolution.outcome,
          stakeUsd: bet.stakeUsd,
          payoutUsd,
          profitUsd: Math.round((payoutUsd - bet.stakeUsd) * 100) / 100,
          priceAtBet: bet.priceAtBet,
          resolvedAt: resolution.resolvedAt,
        });

        recordWin(bet.slotId, payoutUsd);
      } else {
        log.info("SHADOW_RESOLUTION_LOSS", {
          betId: bet.betId,
          slotId: bet.slotId,
          marketId: bet.market.id,
          question: bet.market.question,
          betSide: bet.side,
          outcome: resolution.outcome,
          stakeUsd: bet.stakeUsd,
          resolvedAt: resolution.resolvedAt,
        });

        recordLoss(bet.slotId);
      }

      untrackMarket(bet.market.id);
    } catch (err) {
      log.error("RESOLUTION_ERROR", {
        betId: bet.betId,
        marketId: bet.market.id,
        error: (err as Error).message,
        shadow: true,
      });
    }
  }, pollInterval);
}

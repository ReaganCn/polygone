/**
 * trader.ts
 *
 * The main orchestrator — connects the scanner, slots, and order placement.
 *
 * Flow for each qualifying market:
 *   1. Check if a slot is available (getIdleSlot).
 *   2. If no slot available, log and skip.
 *   3. If a slot is available:
 *        Shadow mode → simulateBet + watchShadowBet
 *        Live mode   → placeOrder + watchLiveBet
 *   4. Mark the market as tracked so the scanner won't pick it up again.
 *   5. Assign the bet to the slot.
 *
 * For live bets, resolution is polled in watchLiveBet (same polling mechanism
 * as shadow mode, but also checks order fill status first).
 */

import { CONFIG } from "./config.js";
import { log } from "./logger.js";
import { placeOrder, fetchMarketResolution } from "./polymarket.js";
import { getIdleSlot, assignBet, recordWin, recordLoss } from "./slots.js";
import { trackMarket, untrackMarket } from "./scanner.js";
import { simulateBet, watchShadowBet } from "./shadow.js";
import type { Market, ActiveBet } from "./types.js";

// ─── bet ID generator ─────────────────────────────────────────────────────────

function generateBetId(): string {
  return `bet-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ─── main entry point ─────────────────────────────────────────────────────────

/**
 * Called by the scanner for each qualifying market.
 * Handles slot allocation and delegates to shadow or live path.
 */
export async function handleQualifyingMarket(market: Market): Promise<void> {
  const slot = getIdleSlot();

  if (!slot) {
    log.warn("BET_SKIPPED_NO_SLOT", {
      marketId: market.id,
      question: market.question,
      asset: market.asset,
      winSidePrice: market.winSidePrice,
      reason: "All slots are currently occupied.",
    });
    return;
  }

  // Track market immediately to prevent double-betting while order is in flight
  trackMarket(market.id);

  log.info("BET_QUEUED", {
    slotId: slot.id,
    slotBalance: slot.balance,
    marketId: market.id,
    question: market.question,
    asset: market.asset,
    duration: market.duration,
    winSide: market.winSide,
    winSidePrice: market.winSidePrice,
    timeRemainingSeconds: market.timeRemainingSeconds,
    shadowMode: CONFIG.shadowMode,
  });

  if (CONFIG.shadowMode) {
    await handleShadowBet(market, slot.id, slot.balance);
  } else {
    await handleLiveBet(market, slot.id, slot.balance);
  }
}

// ─── shadow path ──────────────────────────────────────────────────────────────

async function handleShadowBet(
  market: Market,
  slotId: number,
  stakeUsd: number
): Promise<void> {
  const bet = simulateBet(market, slotId, stakeUsd);
  assignBet(slotId, bet);
  watchShadowBet(bet);
}

// ─── live path ────────────────────────────────────────────────────────────────

async function handleLiveBet(
  market: Market,
  slotId: number,
  stakeUsd: number
): Promise<void> {
  const result = await placeOrder(market, stakeUsd);

  if (!result.success) {
    log.error("ORDER_FAILED", {
      slotId,
      marketId: market.id,
      error: result.error,
    });
    // Release the market tracking so we could retry later
    untrackMarket(market.id);
    return;
  }

  const betId = generateBetId();
  const price = result.avgPrice ?? market.winSidePrice;
  const expectedPayoutUsd = Math.floor((stakeUsd / price) * 100) / 100;

  const bet: ActiveBet = {
    betId,
    market,
    slotId,
    stakeUsd,
    expectedPayoutUsd,
    orderId: result.orderId,
    placedAt: new Date().toISOString(),
    shadow: false,
    side: market.winSide,
    priceAtBet: price,
  };

  log.info("BET_PLACED", {
    betId,
    slotId,
    orderId: result.orderId,
    marketId: market.id,
    question: market.question,
    asset: market.asset,
    duration: market.duration,
    side: market.winSide,
    stakeUsd,
    expectedPayoutUsd,
    priceAtBet: price,
    orderType: CONFIG.orderType,
    closesAt: market.closesAt,
  });

  assignBet(slotId, bet);
  watchLiveBet(bet);
}

// ─── live resolution polling ──────────────────────────────────────────────────

/**
 * Poll for resolution of a live bet.
 * Same polling logic as shadow mode — checks Gamma API for market close + outcome.
 */
function watchLiveBet(bet: ActiveBet): void {
  const pollInterval = CONFIG.resolutionPollIntervalMs;

  log.info("RESOLUTION_POLLING", {
    betId: bet.betId,
    marketId: bet.market.id,
    orderId: bet.orderId,
    pollIntervalMs: pollInterval,
    shadow: false,
  });

  const poll = setInterval(async () => {
    try {
      const resolution = await fetchMarketResolution(bet.market.id, bet.side);

      if (resolution.outcome === "PENDING") {
        return; // Keep polling
      }

      clearInterval(poll);

      if (resolution.outcome === "CANCELLED") {
        log.warn("RESOLUTION_LOSS", {
          betId: bet.betId,
          marketId: bet.market.id,
          outcome: "CANCELLED",
          betSide: bet.side,
          note: "Market cancelled — treating as loss.",
          shadow: false,
        });
        recordLoss(bet.slotId);
        untrackMarket(bet.market.id);
        return;
      }

      const won = resolution.outcome === bet.side;

      if (won) {
        const tokensBought = bet.stakeUsd / bet.priceAtBet;
        const payoutUsd = Math.floor(tokensBought * 100) / 100;

        log.info("RESOLUTION_WIN", {
          betId: bet.betId,
          slotId: bet.slotId,
          orderId: bet.orderId,
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
        log.info("RESOLUTION_LOSS", {
          betId: bet.betId,
          slotId: bet.slotId,
          orderId: bet.orderId,
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
      });
    }
  }, pollInterval);
}

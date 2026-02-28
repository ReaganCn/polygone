/**
 * trader.ts
 *
 * Main orchestrator — connects scanner, slots, and order placement.
 *
 * Changes from v1:
 *   - Now exports `handleWsResolution(marketId, winningTokenId, winningOutcome)`
 *     which is called by the scanner when a `market_resolved` WS event fires.
 *     This settles the bet immediately without waiting for a poll cycle.
 *   - Resolution polling in `watchLiveBet` / `watchShadowBet` is kept as a
 *     fallback in case the `market_resolved` WS event is missed (e.g. during
 *     a reconnect). The poll only fires after the market's close time + a buffer.
 *
 * Flow for each qualifying market:
 *   1. Check if a slot is available.
 *   2. Shadow mode → simulateBet; Live mode → placeOrder.
 *   3. Track market in scanner; assign bet to slot.
 *   4. Start a fallback resolution watcher (fires only if WS event doesn't come).
 */

import { CONFIG } from "./config.js";
import { log } from "./logger.js";
import { placeOrder, fetchMarketResolution } from "./polymarket.js";
import { getIdleSlot, assignBet, recordWin, recordLoss } from "./slots.js";
import { trackMarket, untrackMarket } from "./scanner.js";
import { simulateBet } from "./shadow.js";
import type { Market, ActiveBet } from "./types.js";

// ─── active bet registry ──────────────────────────────────────────────────────
// We need a way to look up an ActiveBet by marketId when the WS resolution fires.

const activeBetsByMarketId = new Map<string, ActiveBet>();

// ─── bet ID generator ─────────────────────────────────────────────────────────

function generateBetId(): string {
  return `bet-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ─── main entry point ─────────────────────────────────────────────────────────

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

  // Track immediately to prevent double-betting while order is in flight
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

// ─── WebSocket resolution handler ────────────────────────────────────────────

/**
 * Called by scanner when a `market_resolved` WebSocket event fires.
 * Settles the bet immediately — no polling needed.
 */
export function handleWsResolution(
  marketId: string,
  winningTokenId: string,
  winningOutcome: string
): void {
  const bet = activeBetsByMarketId.get(marketId);
  if (!bet) {
    // No active bet for this market — nothing to settle
    return;
  }

  activeBetsByMarketId.delete(marketId);

  const won = bet.side === winningOutcome;

  if (won) {
    const tokensBought = bet.stakeUsd / bet.priceAtBet;
    const payoutUsd = Math.floor(tokensBought * 100) / 100;

    log.info(bet.shadow ? "SHADOW_RESOLUTION_WIN" : "RESOLUTION_WIN", {
      source: "websocket",
      betId: bet.betId,
      slotId: bet.slotId,
      orderId: bet.orderId,
      marketId,
      question: bet.market.question,
      betSide: bet.side,
      winningOutcome,
      winningTokenId,
      stakeUsd: bet.stakeUsd,
      payoutUsd,
      profitUsd: Math.round((payoutUsd - bet.stakeUsd) * 100) / 100,
      priceAtBet: bet.priceAtBet,
    });

    recordWin(bet.slotId, payoutUsd);
  } else {
    log.info(bet.shadow ? "SHADOW_RESOLUTION_LOSS" : "RESOLUTION_LOSS", {
      source: "websocket",
      betId: bet.betId,
      slotId: bet.slotId,
      orderId: bet.orderId,
      marketId,
      question: bet.market.question,
      betSide: bet.side,
      winningOutcome,
      stakeUsd: bet.stakeUsd,
    });

    recordLoss(bet.slotId);
  }

  untrackMarket(marketId);
}

// ─── shadow path ──────────────────────────────────────────────────────────────

async function handleShadowBet(
  market: Market,
  slotId: number,
  stakeUsd: number
): Promise<void> {
  const bet = simulateBet(market, slotId, stakeUsd);
  activeBetsByMarketId.set(market.id, bet);
  assignBet(slotId, bet);
  startFallbackResolutionWatcher(bet);
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

  activeBetsByMarketId.set(market.id, bet);
  assignBet(slotId, bet);
  startFallbackResolutionWatcher(bet);
}

// ─── fallback resolution watcher ─────────────────────────────────────────────

/**
 * Polls for resolution ONLY as a fallback — fires after market close time + buffer.
 * If the WebSocket `market_resolved` event already settled this bet, the poll
 * is a no-op (activeBetsByMarketId will not contain the marketId).
 */
function startFallbackResolutionWatcher(bet: ActiveBet): void {
  const closeMs = new Date(bet.market.closesAt).getTime();
  const bufferMs = 10_000; // wait 10s after close before first poll
  const now = Date.now();
  const delayUntilFirstPoll = Math.max(0, closeMs - now + bufferMs);

  log.info("RESOLUTION_POLLING", {
    source: "fallback_watcher",
    betId: bet.betId,
    marketId: bet.market.id,
    shadow: bet.shadow,
    pollStartsInMs: delayUntilFirstPoll,
    pollIntervalMs: CONFIG.resolutionPollIntervalMs,
  });

  // Delay the first poll until after close time
  const startTimeout = setTimeout(() => {
    // If already settled by WS event, bail out immediately
    if (!activeBetsByMarketId.has(bet.market.id)) {
      log.info("INFO", {
        message: "Fallback watcher: bet already settled by WebSocket event.",
        betId: bet.betId,
        marketId: bet.market.id,
      });
      return;
    }

    // Start polling
    const poll = setInterval(async () => {
      // Check again — WS event may have arrived between polls
      if (!activeBetsByMarketId.has(bet.market.id)) {
        clearInterval(poll);
        return;
      }

      try {
        const resolution = await fetchMarketResolution(bet.market.id, bet.side);

        if (resolution.outcome === "PENDING") return;

        clearInterval(poll);

        // Use the same handleWsResolution path for consistency
        const outcome = resolution.outcome === "CANCELLED" ? bet.side === "YES" ? "NO" : "YES" : resolution.outcome;

        if (resolution.outcome === "CANCELLED") {
          log.warn("RESOLUTION_LOSS", {
            source: "fallback_poll",
            betId: bet.betId,
            marketId: bet.market.id,
            outcome: "CANCELLED",
            note: "Market cancelled — treating as loss.",
          });
          activeBetsByMarketId.delete(bet.market.id);
          recordLoss(bet.slotId);
          untrackMarket(bet.market.id);
        } else {
          handleWsResolution(bet.market.id, "", resolution.outcome);
        }
      } catch (err) {
        log.error("RESOLUTION_ERROR", {
          source: "fallback_poll",
          betId: bet.betId,
          marketId: bet.market.id,
          error: (err as Error).message,
        });
      }
    }, CONFIG.resolutionPollIntervalMs);
  }, delayUntilFirstPoll);

  // Safety: don't leave the timer dangling if the process shuts down cleanly
  startTimeout.unref();
}
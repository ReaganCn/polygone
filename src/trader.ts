/**
 * trader.ts — Main orchestrator.
 *
 * FIXES APPLIED:
 *
 * [T1] Duplicate bets on the same market — pendingMarketIds Set.
 *   handleQualifyingMarket now checks pendingMarketIds before proceeding.
 *   A market is added to pendingMarketIds as the very first action and removed
 *   on every exit path (order fail, order success, shadow). This prevents two
 *   concurrent scan events for the same market from each grabbing a different
 *   idle slot and both placing orders.
 *
 * [T2] Same-slot race condition — reserveSlot() called before any await.
 *   In both handleLiveBet and handleShadowBet, slots.reserveSlot(slotId) is
 *   called synchronously before the first await. This marks the slot
 *   "reserved" so getIdleSlot() cannot return it to any other concurrent
 *   qualifying event while the order is in-flight. On order failure,
 *   releaseReservedSlot() restores the slot to idle. On success, assignBet()
 *   transitions it from "reserved" to "active".
 *
 * [P4] False CANCELLED loss during oracle settlement window.
 *   startFallbackResolutionWatcher now tracks a cancelledReadings counter
 *   per bet. fetchMarketResolution returning "CANCELLED" increments the
 *   counter but does NOT commit the loss until CANCELLED_THRESHOLD (3)
 *   consecutive readings confirm it. YES/NO commit immediately as before.
 *   This gives the oracle ~15 seconds (3 × 5s poll interval) to settle
 *   prices after market close before the bot treats it as a true cancel.
 */

import { CONFIG } from "./config.js";
import { log } from "./logger.js";
import { placeOrder, fetchMarketResolution, sellPosition } from "./polymarket.js";
import {
  getIdleSlot, reserveSlot, releaseReservedSlot,
  assignBet, recordWin, recordLoss, recordStopLoss,
} from "./slots.js";
import { trackMarket, untrackMarket } from "./scanner.js";
import { simulateBet } from "./shadow.js";
import { redeemAfterWin } from "./redeemer.js";
import { notifyBetPlaced, notifyWin, notifyLoss } from "./telegram.js";
import type { Market, ActiveBet, BetRule } from "./types.js";

// ─── module-level state ───────────────────────────────────────────────────────

const activeBetsByMarketId = new Map<string, ActiveBet>();

/**
 * [T1] Markets currently being processed (slot grabbed, order in-flight, or
 * shadow bet being set up). Prevents duplicate bets when the scanner emits
 * the same qualifying market twice in rapid succession.
 */
const pendingMarketIds = new Set<string>();

/**
 * [P4] Number of consecutive CANCELLED readings required before committing a
 * CANCELLED loss. Each poll is CONFIG.resolutionPollIntervalMs (default 5s),
 * so 3 readings = ~15s grace window for the oracle to finalise prices.
 */
const CANCELLED_THRESHOLD = 3;

// ─── exported helpers ─────────────────────────────────────────────────────────

export function getBetTokenId(marketId: string): string | undefined {
  return activeBetsByMarketId.get(marketId)?.market.tokenIdToBuy;
}

function generateBetId(): string {
  return `bet-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ─── main entry point ─────────────────────────────────────────────────────────

export async function handleQualifyingMarket(market: Market, rule: BetRule): Promise<void> {
  // [T1] Reject if this market is already being processed or has an active bet.
  if (pendingMarketIds.has(market.id) || activeBetsByMarketId.has(market.id)) {
    log.info("BET_SKIPPED_DUPLICATE", {
      marketId: market.id,
      asset: market.asset,
      rule,
      reason: pendingMarketIds.has(market.id) ? "order_in_flight" : "already_active",
    });
    return;
  }

  const slot = getIdleSlot();
  if (!slot) {
    log.warn("BET_SKIPPED_NO_SLOT", {
      marketId: market.id,
      asset: market.asset,
      winSidePrice: market.winSidePrice,
      rule,
    });
    return;
  }

  // [T1] Claim this market before any await so no concurrent event can also
  // claim it.
  pendingMarketIds.add(market.id);

  // [T2] Reserve the slot synchronously before any await so getIdleSlot()
  // cannot return it to another concurrent qualifying event.
  reserveSlot(slot.id);

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
    rule,
    shadowMode: CONFIG.shadowMode,
  });

  try {
    if (CONFIG.shadowMode) {
      await handleShadowBet(market, slot.id, slot.balance, rule);
    } else {
      await handleLiveBet(market, slot.id, slot.balance, rule);
    }
  } finally {
    // [T1] Always remove from pending regardless of outcome. The market is now
    // either in activeBetsByMarketId (success) or fully cleaned up (failure).
    pendingMarketIds.delete(market.id);
  }
}

// ─── stop-loss ────────────────────────────────────────────────────────────────

export async function handleStopLoss(marketId: string): Promise<void> {
  const bet = activeBetsByMarketId.get(marketId);
  if (!bet) return;

  if (bet.stopLossTriggered) return;
  bet.stopLossTriggered = true;

  const sharesOwned = bet.stakeUsd / bet.priceAtBet;

  if (bet.shadow) {
    activeBetsByMarketId.delete(marketId);
    // Simulate selling at trigger price (realistic mid-exit), not limit floor
    const simulatedFillPrice = CONFIG.stopLossTriggerPrice;
    const simulatedRecovered = round2(sharesOwned * simulatedFillPrice);
    log.info("SHADOW_RESOLUTION_LOSS", {
      source: "stop_loss_shadow",
      betId: bet.betId, slotId: bet.slotId,
      marketId, question: bet.market.question,
      betSide: bet.side,
      stakeUsd: bet.stakeUsd,
      simulatedRecoveredUsd: simulatedRecovered,
      netLoss: round2(bet.stakeUsd - simulatedRecovered),
      triggerPrice: CONFIG.stopLossTriggerPrice,
      limitPrice: CONFIG.stopLossLimitPrice,
    });
    recordStopLoss(bet.slotId, simulatedRecovered);
    untrackMarket(marketId);
    return;
  }

  // Live mode
  log.info("ORDER_RESPONSE", {
    action: "stop_loss_triggered",
    betId: bet.betId, slotId: bet.slotId,
    marketId, question: bet.market.question,
    betSide: bet.side,
    stakeUsd: bet.stakeUsd,
    priceAtBet: bet.priceAtBet,
    sharesOwned: round4(sharesOwned),
    triggerPrice: CONFIG.stopLossTriggerPrice,
    limitPrice: CONFIG.stopLossLimitPrice,
    rule: bet.rule,
  });

  const result = await sellPosition(bet);

  if (!result.success) {
    // Sell failed — position still open on-chain.
    // Reset stopLossTriggered after a cooldown so the next price tick below
    // threshold will attempt the sell again. Without this, stopLossTriggered
    // stays true forever and no further sell attempts are ever made.
    // The cooldown prevents hammering the CLOB on a liquidity outage.
    const RETRY_COOLDOWN_MS = 10_000; // 10 seconds between sell attempts
    log.error("ORDER_FAILED", {
      action: "stop_loss_sell_failed_will_retry",
      betId: bet.betId, slotId: bet.slotId, marketId,
      question: bet.market.question,
      betSide: bet.side, rule: bet.rule,
      stakeUsd: bet.stakeUsd,
      retryInMs: RETRY_COOLDOWN_MS,
      sellError: result.error,
    });
    setTimeout(() => {
      // Only reset if the bet is still active — it may have resolved normally
      // or been cleared by the fallback watcher in the meantime.
      const stillActive = activeBetsByMarketId.get(marketId);
      if (stillActive && stillActive.betId === bet.betId) {
        stillActive.stopLossTriggered = false;
        log.info("ORDER_RESPONSE", {
          action: "stop_loss_retry_armed",
          betId: bet.betId, slotId: bet.slotId, marketId,
          note: "stopLossTriggered reset — will retry on next price tick below threshold",
        });
      }
    }, RETRY_COOLDOWN_MS);
    return;
  }

  // Sell succeeded — read recoveredUsd directly from the result.
  // sellPosition() sets this from takingAmount in the CLOB response (USDC
  // received for a SELL order). We never recompute it from filledShares × price
  // because avgPrice is not a field the CLOB returns, so any multiplication
  // would silently fall back to the limit floor (0.05) → $0.07 recovered.
  const filledShares  = result.filledShares ?? sharesOwned;
  const recoveredUsd  = result.recoveredUsd ?? 0;
  const isPartialFill = filledShares < sharesOwned - 0.0001;

  log.info("RESOLUTION_LOSS", {
    source: "stop_loss",
    betId: bet.betId, slotId: bet.slotId, marketId,
    question: bet.market.question,
    betSide: bet.side, rule: bet.rule,
    stakeUsd: bet.stakeUsd,
    sharesOwned: round4(sharesOwned),
    filledShares: round4(filledShares),
    avgFillPrice: filledShares > 0 ? round4(recoveredUsd / filledShares) : 0,
    recoveredUsd,
    netLoss: round2(bet.stakeUsd - recoveredUsd),
    isPartialFill,
    sellSuccess: true,
  });

  if (isPartialFill) {
    // Partial fill: record the recovered portion now, then re-open the slot
    // with the residual stake so the resolution watcher can settle the
    // remaining shares at market close.
    const remainingShares = sharesOwned - filledShares;
    const remainingStake  = round2(remainingShares * bet.priceAtBet);

    log.warn("STOP_LOSS_PARTIAL_FILL", {
      betId: bet.betId, slotId: bet.slotId, marketId,
      sharesOwned: round4(sharesOwned),
      filledShares: round4(filledShares),
      remainingShares: round4(remainingShares),
      remainingStake,
      recoveredUsd,
      note: "Residual position left open — will resolve normally at market close.",
    });

    // Record the partial recovery — this clears the slot to idle
    recordStopLoss(bet.slotId, recoveredUsd);

    // Re-open the same slot with updated stake for the residual position
    bet.stakeUsd = remainingStake;
    bet.stopLossTriggered = false;  // allow normal resolution to proceed
    activeBetsByMarketId.set(marketId, bet);
    assignBet(bet.slotId, bet);
    // Do NOT untrackMarket — scanner keeps watching for resolution

  } else {
    // Full fill — position fully closed
    activeBetsByMarketId.delete(marketId);
    recordStopLoss(bet.slotId, recoveredUsd);
    untrackMarket(marketId);
  }
}

// ─── WebSocket resolution ─────────────────────────────────────────────────────

export function handleWsResolution(
  marketId: string,
  winningTokenId: string,
  winningOutcome: string
): void {
  const bet = activeBetsByMarketId.get(marketId);

  // Guard: no bet means either we never placed one, it was already resolved,
  // or a successful stop-loss already cleared it.
  if (!bet) return;

  activeBetsByMarketId.delete(marketId);

  const normalised = normaliseOutcome(winningOutcome, winningTokenId, bet);
  const won = bet.side === normalised;

  if (won) {
    // payoutUsd is accurate now that priceAtBet is the real fill price [P2]
    const payoutUsd = round2(bet.stakeUsd / bet.priceAtBet);

    log.info(bet.shadow ? "SHADOW_RESOLUTION_WIN" : "RESOLUTION_WIN", {
      source: "websocket",
      betId: bet.betId, slotId: bet.slotId, orderId: bet.orderId,
      marketId, question: bet.market.question,
      betSide: bet.side, winningOutcome, normalisedOutcome: normalised,
      stakeUsd: bet.stakeUsd, payoutUsd,
      profitUsd: round2(payoutUsd - bet.stakeUsd),
      priceAtBet: bet.priceAtBet, rule: bet.rule,
    });

    recordWin(bet.slotId, payoutUsd);
    notifyWin(bet.market.asset, bet.side, bet.stakeUsd, payoutUsd, bet.rule);

    if (!bet.shadow) {
      redeemAfterWin(bet.market.conditionId, bet.market.question).catch(
        (err) => log.error("REDEEM_UNCAUGHT", {
          marketId, error: (err as Error).message,
        })
      );
    }
  } else {
    log.info(bet.shadow ? "SHADOW_RESOLUTION_LOSS" : "RESOLUTION_LOSS", {
      source: "websocket",
      betId: bet.betId, slotId: bet.slotId, orderId: bet.orderId,
      marketId, question: bet.market.question,
      betSide: bet.side, winningOutcome, normalisedOutcome: normalised,
      stakeUsd: bet.stakeUsd, rule: bet.rule,
    });
    recordLoss(bet.slotId);
    notifyLoss(bet.market.asset, bet.side, bet.stakeUsd, bet.rule);
  }

  untrackMarket(marketId);
}

// ─── shadow path ──────────────────────────────────────────────────────────────

async function handleShadowBet(
  market: Market, slotId: number, stakeUsd: number, rule: BetRule
): Promise<void> {
  // [T2] Slot is already reserved. simulateBet is synchronous so there is no
  // additional async gap here, but we call assignBet explicitly to transition
  // from "reserved" to "active" and attach the bet object consistently with
  // the live path.
  try {
    const bet = simulateBet(market, slotId, stakeUsd, rule);
    activeBetsByMarketId.set(market.id, bet);
    assignBet(slotId, bet);
    notifyBetPlaced(market.asset, market.winSide, stakeUsd, rule, market.winSidePrice);
    startFallbackResolutionWatcher(bet);
  } catch (err) {
    // Shadow bet setup failed — release the slot so it can be reused
    releaseReservedSlot(slotId);
    untrackMarket(market.id);
    log.error("SHADOW_BET_FAILED", {
      slotId, marketId: market.id,
      error: (err as Error).message,
    });
  }
}

// ─── live path ────────────────────────────────────────────────────────────────

async function handleLiveBet(
  market: Market, slotId: number, stakeUsd: number, rule: BetRule
): Promise<void> {
  // [T2] Slot is already reserved by handleQualifyingMarket.
  const result = await placeOrder(market, stakeUsd);

  if (!result.success) {
    // Order failed — release the reserved slot so it can accept future bets
    releaseReservedSlot(slotId);
    log.error("ORDER_FAILED", { slotId, marketId: market.id, error: result.error, rule });
    untrackMarket(market.id);
    return;
  }

  const betId = generateBetId();
  // [P2] avgPrice is now the real fill price, not just winSidePrice
  const price = result.avgPrice ?? market.winSidePrice;
  const expectedPayoutUsd = round2(stakeUsd / price);

  const bet: ActiveBet = {
    betId, market, slotId, stakeUsd, expectedPayoutUsd,
    orderId: result.orderId,
    placedAt: new Date().toISOString(),
    shadow: false,
    side: market.winSide,
    priceAtBet: price,
    rule,
  };

  log.info("BET_PLACED", {
    betId, slotId, orderId: result.orderId,
    marketId: market.id, question: market.question,
    asset: market.asset, duration: market.duration,
    side: market.winSide, stakeUsd, expectedPayoutUsd,
    priceAtBet: price, orderType: CONFIG.orderType,
    closesAt: market.closesAt, rule,
  });

  notifyBetPlaced(market.asset, market.winSide, stakeUsd, rule, price);

  activeBetsByMarketId.set(market.id, bet);
  // [T2] assignBet transitions slot from "reserved" → "active" and attaches bet
  assignBet(slotId, bet);
  startFallbackResolutionWatcher(bet);
}

// ─── fallback resolution watcher ─────────────────────────────────────────────

function startFallbackResolutionWatcher(bet: ActiveBet): void {
  const closeMs = new Date(bet.market.closesAt).getTime();
  const delayUntilFirstPoll = Math.max(0, closeMs - Date.now() + 10_000);

  log.info("RESOLUTION_POLLING", {
    betId: bet.betId, marketId: bet.market.id,
    shadow: bet.shadow, pollStartsInMs: delayUntilFirstPoll,
  });

  // [P4] Track consecutive CANCELLED readings per watcher instance.
  // This counter is local to this closure — one counter per bet, not shared.
  let cancelledReadings = 0;

  const startTimeout = setTimeout(() => {
    if (!activeBetsByMarketId.has(bet.market.id)) return;

    const poll = setInterval(async () => {
      if (!activeBetsByMarketId.has(bet.market.id)) { clearInterval(poll); return; }

      try {
        const resolution = await fetchMarketResolution(bet.market.id, bet.side);

        if (resolution.outcome === "PENDING") {
          // Not resolved yet — reset cancelled counter and keep polling
          cancelledReadings = 0;
          return;
        }

        if (resolution.outcome === "YES" || resolution.outcome === "NO") {
          // Definitive result — commit immediately, reset counter
          cancelledReadings = 0;
          clearInterval(poll);
          // Routes through handleWsResolution which re-checks activeBetsByMarketId
          // so a race with the WebSocket path is safe.
          handleWsResolution(bet.market.id, "", resolution.outcome);
          return;
        }

        // [P4] outcome === "CANCELLED"
        // Increment counter. Only commit as a loss once we've seen CANCELLED
        // CANCELLED_THRESHOLD times in a row. This covers the oracle settlement
        // window where closed=true but prices haven't reached 0.99/0.01 yet.
        cancelledReadings++;

        log.info("RESOLUTION_CANCELLED_READING", {
          betId: bet.betId, marketId: bet.market.id,
          cancelledReadings, threshold: CANCELLED_THRESHOLD,
          note: cancelledReadings < CANCELLED_THRESHOLD
            ? "Waiting for confirmation before committing loss"
            : "Threshold reached — committing CANCELLED loss",
        });

        if (cancelledReadings < CANCELLED_THRESHOLD) {
          // Not yet confirmed — keep polling
          return;
        }

        // Confirmed CANCELLED after CANCELLED_THRESHOLD consecutive readings
        clearInterval(poll);
        log.warn("RESOLUTION_LOSS", {
          source: "fallback_poll", betId: bet.betId,
          marketId: bet.market.id, outcome: "CANCELLED",
          cancelledReadings,
        });
        activeBetsByMarketId.delete(bet.market.id);
        recordLoss(bet.slotId);
        untrackMarket(bet.market.id);

      } catch (err) {
        log.error("RESOLUTION_ERROR", {
          betId: bet.betId, marketId: bet.market.id,
          error: (err as Error).message,
        });
      }
    }, CONFIG.resolutionPollIntervalMs);
  }, delayUntilFirstPoll);

  startTimeout.unref();
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function normaliseOutcome(outcome: string, tokenId: string, bet: ActiveBet): "YES" | "NO" {
  const u = outcome.toUpperCase();
  if (u === "UP" || u === "YES") return "YES";
  if (u === "DOWN" || u === "NO") return "NO";
  if (tokenId === bet.market.yesTokenId) return "YES";
  if (tokenId === bet.market.noTokenId) return "NO";
  log.warn("WARN", { message: "Unrecognised outcome — defaulting NO", outcome, tokenId });
  return "NO";
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round4(n: number): number { return Math.round(n * 10000) / 10000; }
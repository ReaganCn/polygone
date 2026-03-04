/**
 * trader.ts — Main orchestrator.
 *
 * CHANGE (stop-loss):
 *   handleStopLoss(marketId) is exported for scanner.ts to call when a live
 *   price tick drops below CONFIG.stopLossTriggerPrice on an active bet.
 *   It places a FAK SELL via polymarket.sellPosition(), then records the
 *   recovered amount via slots.recordStopLoss() so P&L is accurate.
 *
 * CHANGE (redeemer):
 *   After every live RESOLUTION_WIN, redeemAfterWin() is called so the winning
 *   tokens are immediately converted back to spendable USDC.
 */

import { CONFIG } from "./config.js";
import { log } from "./logger.js";
import { placeOrder, fetchMarketResolution, sellPosition } from "./polymarket.js";
import { getIdleSlot, assignBet, recordWin, recordLoss, recordStopLoss } from "./slots.js";
import { trackMarket, untrackMarket } from "./scanner.js";
import { simulateBet } from "./shadow.js";
import { redeemAfterWin } from "./redeemer.js";
import type { Market, ActiveBet, BetRule } from "./types.js";

const activeBetsByMarketId = new Map<string, ActiveBet>();

/**
 * Returns the token ID that was actually bought for a tracked bet.
 * Used by scanner.ts to compare the stop-loss price against the correct token
 * (the one the bet is on) rather than the market's current winSidePrice, which
 * may have flipped sides since the bet was placed.
 */
export function getBetTokenId(marketId: string): string | undefined {
  return activeBetsByMarketId.get(marketId)?.market.tokenIdToBuy;
}

function generateBetId(): string {
  return `bet-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ─── main entry point ─────────────────────────────────────────────────────────

export async function handleQualifyingMarket(market: Market, rule: BetRule): Promise<void> {
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

  if (CONFIG.shadowMode) {
    await handleShadowBet(market, slot.id, slot.balance, rule);
  } else {
    await handleLiveBet(market, slot.id, slot.balance, rule);
  }
}

// ─── stop-loss ────────────────────────────────────────────────────────────────

/**
 * Called by scanner.ts when a live price update shows the win-side price of
 * an active bet has dropped below CONFIG.stopLossTriggerPrice.
 *
 * Flow:
 *   1. Mark the bet as stopLossTriggered immediately to prevent duplicate calls
 *      on the next price tick while the sell is in-flight.
 *   2. Place a FAK SELL for the full share position.
 *   3a. Sell succeeded (fully or partially):
 *       Record the recovered USDC via recordStopLoss() so the net loss is
 *       tracked correctly, then untrack the market and free the slot.
 *   3b. Sell failed entirely (order rejected, network error, zero liquidity):
 *       The position is STILL OPEN on-chain. We keep the bet in
 *       activeBetsByMarketId so the existing fallback resolution watcher and
 *       WebSocket market_resolved handler can still settle it correctly.
 *       stopLossTriggered stays true so no further sell attempts are made.
 *       The final outcome (win or loss at resolution) is recorded normally.
 *
 * Shadow mode: simulates the stop-loss without placing a real order. Assumes
 * full recovery at stopLossLimitPrice for accounting purposes.
 */
export async function handleStopLoss(marketId: string): Promise<void> {
  const bet = activeBetsByMarketId.get(marketId);
  if (!bet) return;

  // Guard: only trigger once per bet even if multiple price ticks fire
  if (bet.stopLossTriggered) return;
  bet.stopLossTriggered = true;

  const sharesOwned = bet.stakeUsd / bet.priceAtBet;

  if (bet.shadow) {
    // Shadow mode: simulate the sell at stopLossLimitPrice — always "succeeds"
    activeBetsByMarketId.delete(marketId);
    const simulatedRecovered = round2(sharesOwned * CONFIG.stopLossLimitPrice);
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

  // Live mode: place the actual sell order
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
    // ── Sell failed completely ────────────────────────────────────────────────
    // The position is still open on-chain. Do NOT delete from activeBetsByMarketId
    // so the fallback resolution watcher and WebSocket market_resolved handler
    // can still settle this bet when the market closes.
    // stopLossTriggered remains true so no further sell attempts are made.
    log.error("ORDER_FAILED", {
      action: "stop_loss_sell_failed_position_held",
      betId: bet.betId, slotId: bet.slotId, marketId,
      question: bet.market.question,
      betSide: bet.side, rule: bet.rule,
      stakeUsd: bet.stakeUsd,
      note: "Position is still open. Will resolve normally at market close.",
      sellError: result.error,
    });
    return;
  }

  // ── Sell succeeded (fully or partially) ──────────────────────────────────
  // Remove the bet now that the position is closed.
  activeBetsByMarketId.delete(marketId);

  const recoveredUsd = result.filledShares !== undefined
    ? round2(result.filledShares * CONFIG.stopLossLimitPrice)
    : round2(sharesOwned * CONFIG.stopLossLimitPrice); // fallback: assume full fill

  log.info("RESOLUTION_LOSS", {
    source: "stop_loss",
    betId: bet.betId, slotId: bet.slotId, marketId,
    question: bet.market.question,
    betSide: bet.side, rule: bet.rule,
    stakeUsd: bet.stakeUsd,
    recoveredUsd,
    netLoss: round2(bet.stakeUsd - recoveredUsd),
    filledShares: result.filledShares,
    sellSuccess: true,
  });

  recordStopLoss(bet.slotId, recoveredUsd);
  untrackMarket(marketId);
}

// ─── WebSocket resolution ─────────────────────────────────────────────────────

export function handleWsResolution(
  marketId: string,
  winningTokenId: string,
  winningOutcome: string
): void {
  const bet = activeBetsByMarketId.get(marketId);
  if (!bet) return;

  // If stop-loss triggered AND succeeded, the bet was already removed from
  // activeBetsByMarketId (so this function wouldn't have been entered).
  // If we reach here with stopLossTriggered=true it means the sell failed
  // completely and the position is still open — fall through and resolve normally.

  activeBetsByMarketId.delete(marketId);

  const normalised = normaliseOutcome(winningOutcome, winningTokenId, bet);
  const won = bet.side === normalised;

  if (won) {
    const payoutUsd = Math.round((bet.stakeUsd / bet.priceAtBet) * 100) / 100;

    log.info(bet.shadow ? "SHADOW_RESOLUTION_WIN" : "RESOLUTION_WIN", {
      source: "websocket",
      betId: bet.betId, slotId: bet.slotId, orderId: bet.orderId,
      marketId, question: bet.market.question,
      betSide: bet.side, winningOutcome, normalisedOutcome: normalised,
      stakeUsd: bet.stakeUsd, payoutUsd,
      profitUsd: Math.round((payoutUsd - bet.stakeUsd) * 100) / 100,
      priceAtBet: bet.priceAtBet, rule: bet.rule,
    });

    recordWin(bet.slotId, payoutUsd);

    // Fire-and-forget redemption — slot is free immediately, redeemer
    // handles the 60s oracle delay and retries in the background.
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
  }

  untrackMarket(marketId);
}

// ─── shadow path ──────────────────────────────────────────────────────────────

async function handleShadowBet(
  market: Market, slotId: number, stakeUsd: number, rule: BetRule
): Promise<void> {
  const bet = simulateBet(market, slotId, stakeUsd, rule);
  activeBetsByMarketId.set(market.id, bet);
  assignBet(slotId, bet);
  startFallbackResolutionWatcher(bet);
}

// ─── live path ────────────────────────────────────────────────────────────────

async function handleLiveBet(
  market: Market, slotId: number, stakeUsd: number, rule: BetRule
): Promise<void> {
  const result = await placeOrder(market, stakeUsd);

  if (!result.success) {
    log.error("ORDER_FAILED", { slotId, marketId: market.id, error: result.error, rule });
    untrackMarket(market.id);
    return;
  }

  const betId = generateBetId();
  const price = result.avgPrice ?? market.winSidePrice;
  const expectedPayoutUsd = Math.round((stakeUsd / price) * 100) / 100;

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

  activeBetsByMarketId.set(market.id, bet);
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

  const startTimeout = setTimeout(() => {
    if (!activeBetsByMarketId.has(bet.market.id)) return;

    const poll = setInterval(async () => {
      if (!activeBetsByMarketId.has(bet.market.id)) { clearInterval(poll); return; }

      try {
        const resolution = await fetchMarketResolution(bet.market.id, bet.side);
        if (resolution.outcome === "PENDING") return;

        clearInterval(poll);

        if (resolution.outcome === "CANCELLED") {
          log.warn("RESOLUTION_LOSS", {
            source: "fallback_poll", betId: bet.betId,
            marketId: bet.market.id, outcome: "CANCELLED",
          });
          activeBetsByMarketId.delete(bet.market.id);
          recordLoss(bet.slotId);
          untrackMarket(bet.market.id);
        } else {
          // Routes through handleWsResolution which checks stopLossTriggered
          handleWsResolution(bet.market.id, "", resolution.outcome);
        }
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
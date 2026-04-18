/**
 * trader.ts — Main orchestrator.
 * Now receives BetRule from scanner and threads it through to slot accounting.
 *
 * CHANGE (redeemer integration):
 *   After every live RESOLUTION_WIN, redeemAfterWin() is called so the winning
 *   tokens are immediately converted back to spendable USDC.
 */

import { CONFIG } from "./config.js";
import { log } from "./logger.js";
import { placeOrder, fetchMarketResolution, closePosition, getOrderStatus, cancelOrder } from "./polymarket.js";
import { getIdleSlot, reserveSlot, releaseSlot, assignBet, recordWin, recordLoss } from "./slots.js";
import { trackMarket, untrackMarket, setActiveBetPriceCallback } from "./scanner.js";
import { getTokenPrice } from "./websocket.js";
import { simulateBet } from "./shadow.js";
import { enqueueRedemption } from "./redemptionQueue.js";
import type { Market, ActiveBet, BetRule, OrderResult } from "./types.js";
import type { TokenPrice } from "./websocket.js";

const activeBetsByMarketId = new Map<string, ActiveBet>();

/** Prevents concurrent early-close attempts for the same market. */
const closingMarketIds = new Set<string>();

/**
 * Counts how many times an early-close has been attempted for each market.
 * Attempts are reset when a bet is resolved. Once the count reaches
 * CONFIG.earlyCloseMaxAttempts, further close attempts are suppressed and
 * the position falls through to natural market resolution.
 */
const closeAttemptsByMarketId = new Map<string, number>();

/**
 * Wire up the early-close price callback from scanner.
 * Must be called once at startup (from index.ts) before any bets are placed.
 */
export function initTrader(): void {
  setActiveBetPriceCallback(checkEarlyCloseForBet);
}

/** Clear tracking of bets that have already been resolved. Called during daily reset. */
export function getActiveBetCount(): number {
  return activeBetsByMarketId.size;
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

  // Reserve the slot synchronously before any await so no concurrent
  // call can grab the same slot while the order is in flight.
  reserveSlot(slot.id);

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

// ─── WebSocket resolution ─────────────────────────────────────────────────────

export function handleWsResolution(
  marketId: string,
  winningTokenId: string,
  winningOutcome: string
): void {
  const bet = activeBetsByMarketId.get(marketId);
  if (!bet) return;

  // Normalise and check win/loss
  const normalised = normaliseOutcome(winningOutcome, winningTokenId, bet);
  const won = bet.side === normalised;

  if (won) {
    const payoutUsd = Math.round((bet.stakeUsd / bet.priceAtBet) * 100) / 100;
    
    log.info(bet.shadow ? "SHADOW_RESOLUTION_WIN" : "RESOLUTION_WIN", {
      betId: bet.betId,
      question: bet.market.question,
      payoutUsd
    });

    recordWin(bet.slotId, payoutUsd);

    // Queue redemption for sequential processing with retry
    if (!bet.shadow) {
      enqueueRedemption(bet.market);
    }
  } else {
    log.info(bet.shadow ? "SHADOW_RESOLUTION_LOSS" : "RESOLUTION_LOSS", {
      betId: bet.betId,
      question: bet.market.question
    });
    recordLoss(bet.slotId);
  }

  activeBetsByMarketId.delete(marketId);
  closeAttemptsByMarketId.delete(marketId);
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
  let result: OrderResult | null = null;

  for (let attempt = 0; attempt <= CONFIG.orderFokRetries; attempt++) {
    if (attempt > 0) {
      await sleep(CONFIG.orderFokRetryDelayMs);
    }
    result = await placeOrder(market, stakeUsd);
    if (result.success) break;
    if (attempt < CONFIG.orderFokRetries) {
      log.warn("ORDER_FOK_RETRY", {
        slotId, marketId: market.id, rule,
        attempt: attempt + 1, maxRetries: CONFIG.orderFokRetries,
        error: result.error,
      });
    }
  }

  if (!result?.success) {
    log.error("ORDER_FAILED", { slotId, marketId: market.id, error: result?.error, rule });
    releaseSlot(slotId);
    untrackMarket(market.id);
    return;
  }

  const betId = generateBetId();
  const price = result.avgPrice ?? market.winSidePrice;
  const expectedPayoutUsd = Math.round((stakeUsd / price) * 100) / 100;
  // Capture best bid at entry as TP/SL baseline (ask is always above bid).
  const bidAtEntry = getTokenPrice(market.tokenIdToBuy)?.bestBid ?? price;

  const bet: ActiveBet = {
    betId, market, slotId, stakeUsd, expectedPayoutUsd,
    orderId: result.orderId,
    placedAt: new Date().toISOString(),
    shadow: false,
    side: market.winSide,
    priceAtBet: price,
    bidPriceAtBet: bidAtEntry,
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
          closeAttemptsByMarketId.delete(bet.market.id);
          recordLoss(bet.slotId);
          untrackMarket(bet.market.id);
        } else {
          // handleWsResolution already calls redeemAfterWin internally
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

// ─── early close (TP / SL) ────────────────────────────────────────────────────

/**
 * Called on every WebSocket price update for a tracked (active-bet) market.
 * Checks whether the current bid has moved enough to trigger an early close.
 * This function is synchronous; the async close is fire-and-forgotten.
 */
function checkEarlyCloseForBet(marketId: string, tokenId: string, price: TokenPrice): void {
  if (!CONFIG.earlyCloseEnabled) return;

  const bet = activeBetsByMarketId.get(marketId);
  if (!bet) return;

  // Prevent concurrent triggers while a close order is already in flight.
  if (closingMarketIds.has(marketId)) return;

  // Resolve the current bid for the token we actually hold.
  let currentBid: number;
  if (tokenId === bet.market.tokenIdToBuy) {
    currentBid = price.bestBid;
  } else {
    currentBid = getTokenPrice(bet.market.tokenIdToBuy)?.bestBid ?? 0;
  }

  if (currentBid <= 0) return;

  // Suppress further close attempts once the configured maximum is reached.
  // This prevents an infinite retry loop when every attempt is rejected
  // (e.g. no liquidity). The position then falls through to natural resolution.
  const attempts = closeAttemptsByMarketId.get(marketId) ?? 0;
  if (attempts >= CONFIG.earlyCloseMaxAttempts) return;

  // Calculate current position P&L as a % of the original stake.
  // priceAtBet is the ask price paid, so this reflects the true return on capital.
  const shares = bet.stakeUsd / bet.priceAtBet;
  const currentValue = shares * currentBid;
  const pnlPct = ((currentValue - bet.stakeUsd) / bet.stakeUsd) * 100;

  if (pnlPct >= CONFIG.earlyCloseTakeProfitPercent) {
    handleEarlyClose(bet, "TP", currentBid).catch((err) =>
      log.error("EARLY_CLOSE_ERROR", { betId: bet.betId, type: "TP", error: (err as Error).message })
    );
  } else if (pnlPct <= -CONFIG.earlyCloseStopLossPercent) {
    handleEarlyClose(bet, "SL", currentBid).catch((err) =>
      log.error("EARLY_CLOSE_ERROR", { betId: bet.betId, type: "SL", error: (err as Error).message })
    );
  }
}

async function handleEarlyClose(bet: ActiveBet, type: "TP" | "SL", exitBid: number): Promise<void> {
  // Synchronous guards — must happen before any await to block concurrent triggers.
  closingMarketIds.add(bet.market.id);
  // Increment attempt counter in the same synchronous frame.
  closeAttemptsByMarketId.set(
    bet.market.id,
    (closeAttemptsByMarketId.get(bet.market.id) ?? 0) + 1
  );

  const sharesOwned = bet.stakeUsd / bet.priceAtBet;
  let proceeds = Math.round(sharesOwned * exitBid * 100) / 100;

  if (!bet.shadow) {
    // ── Live mode ──────────────────────────────────────────────────────────
    if (CONFIG.earlyCloseOrderType === "FOK") {
      // Retry loop: each attempt refreshes the current bid price.
      let result: OrderResult | null = null;
      let lastBid = exitBid;

      for (let attempt = 0; attempt <= CONFIG.earlyCloseFokRetries; attempt++) {
        if (attempt > 0) {
          await sleep(CONFIG.earlyCloseFokRetryDelayMs);
          // Refresh bid between retries — market may have moved.
          lastBid = getTokenPrice(bet.market.tokenIdToBuy)?.bestBid ?? lastBid;
        }

        result = await closePosition(bet, lastBid, "FOK");
        if (result.success) break;

        log.warn("EARLY_CLOSE_FOK_RETRY", {
          betId: bet.betId, attempt: attempt + 1,
          maxRetries: CONFIG.earlyCloseFokRetries,
          error: result.error,
        });
      }

      if (!result?.success) {
        log.warn("EARLY_CLOSE_EXHAUSTED", {
          betId: bet.betId, marketId: bet.market.id, type,
          message: "All FOK retries exhausted — letting market resolve naturally.",
        });
        closingMarketIds.delete(bet.market.id);
        return;
      }

      proceeds = Math.round(sharesOwned * (result.avgPrice ?? lastBid) * 100) / 100;

    } else {
      // LIMIT (GTC) path
      const result = await closePosition(bet, exitBid, "LIMIT");

      if (!result.success || !result.orderId) {
        log.warn("EARLY_CLOSE_FAILED", {
          betId: bet.betId, marketId: bet.market.id, type,
          error: result.error ?? "No orderId returned",
          message: "Limit close order failed — letting market resolve naturally.",
        });
        closingMarketIds.delete(bet.market.id);
        return;
      }

      const fillProceeds = await pollLimitCloseOrder(
        bet, result.orderId, sharesOwned, exitBid
      );

      if (fillProceeds === null) {
        // Market expired before fill; natural resolution will handle it.
        closingMarketIds.delete(bet.market.id);
        return;
      }

      proceeds = fillProceeds;
    }
  }
  // In shadow mode: proceeds already computed from exitBid above — no API call.

  // ── Record outcome ─────────────────────────────────────────────────────────
  const pnlUsd = Math.round((proceeds - bet.stakeUsd) * 100) / 100;

  if (proceeds >= bet.stakeUsd) {
    recordWin(bet.slotId, proceeds);
  } else {
    // Only the actual loss (stake - proceeds) is recorded, not the full stake.
    recordLoss(bet.slotId, bet.stakeUsd - proceeds);
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  activeBetsByMarketId.delete(bet.market.id);
  closeAttemptsByMarketId.delete(bet.market.id);
  // Do NOT call untrackMarket here. Keeping the market in trackedMarketIds
  // prevents the scanner from immediately firing a new bet on the same market
  // (the slot just freed up). The scanner prunes it from knownMarkets ~30s
  // after closesAt, which also cleans it from trackedMarketIds.
  closingMarketIds.delete(bet.market.id);

  const thresholdPct = type === "TP" ? CONFIG.earlyCloseTakeProfitPercent : CONFIG.earlyCloseStopLossPercent;
  const logKey = type === "TP" ? "EARLY_CLOSE_TP" : "EARLY_CLOSE_SL";
  const pnlPct = Math.round(((proceeds - bet.stakeUsd) / bet.stakeUsd) * 10000) / 100;
  log.info(logKey, {
    betId: bet.betId, marketId: bet.market.id,
    question: bet.market.question,
    asset: bet.market.asset, side: bet.side, rule: bet.rule,
    priceAtBet: bet.priceAtBet, exitBid,
    thresholdPct: `${type === "TP" ? "+" : "-"}${thresholdPct}%`,
    stakeUsd: bet.stakeUsd, proceeds, pnlUsd,
    pnlPct: `${pnlPct >= 0 ? "+" : ""}${pnlPct}%`,
    orderType: CONFIG.earlyCloseOrderType, shadow: bet.shadow,
  });
}

/**
 * Poll a resting GTC close order until it fills or the market is about to expire.
 * Returns the fill proceeds in USDC, or null if the order was cancelled due to expiry.
 */
async function pollLimitCloseOrder(
  bet: ActiveBet,
  orderId: string,
  sharesOwned: number,
  limitPrice: number,
): Promise<number | null> {
  const POLL_INTERVAL_MS = 2_000;
  // Cancel and hand off to natural resolution 5 seconds before market closes.
  const cutoffMs = new Date(bet.market.closesAt).getTime() - 5_000;

  while (Date.now() < cutoffMs) {
    await sleep(POLL_INTERVAL_MS);

    try {
      const status = await getOrderStatus(orderId);

      if (status.filled) {
        const avgPrice = status.avgPrice ?? limitPrice;
        return Math.round(sharesOwned * avgPrice * 100) / 100;
      }

      // Partially filled — keep waiting for full fill.
    } catch (err) {
      log.warn("EARLY_CLOSE_POLL_ERROR", {
        betId: bet.betId, orderId, error: (err as Error).message,
      });
    }
  }

  // Deadline reached — cancel the unfilled order so tokens don't get locked.
  try {
    await cancelOrder(orderId);
    log.info("EARLY_CLOSE_LIMIT_CANCELLED", {
      betId: bet.betId, orderId,
      message: "Limit close order cancelled at expiry — natural resolution will handle it.",
    });
  } catch (err) {
    log.warn("EARLY_CLOSE_CANCEL_ERROR", {
      betId: bet.betId, orderId, error: (err as Error).message,
    });
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
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
import { placeOrder, fetchMarketResolution } from "./polymarket.js";
import { getIdleSlot, reserveSlot, releaseSlot, assignBet, recordWin, recordLoss } from "./slots.js";
import { trackMarket, untrackMarket } from "./scanner.js";
import { simulateBet } from "./shadow.js";
import { redeemAfterWin } from "./redeemer.js";
import type { Market, ActiveBet, BetRule } from "./types.js";

const activeBetsByMarketId = new Map<string, ActiveBet>();

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

    // FIX: Pass the full bet.market object instead of just conditionId
    if (!bet.shadow) {
      redeemAfterWin(bet.market).catch(err => 
        log.error("REDEEM_UNCAUGHT", { marketId, error: err.message })
      );
    }
  } else {
    log.info(bet.shadow ? "SHADOW_RESOLUTION_LOSS" : "RESOLUTION_LOSS", {
      betId: bet.betId,
      question: bet.market.question
    });
    recordLoss(bet.slotId);
  }

  activeBetsByMarketId.delete(marketId);
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
    releaseSlot(slotId);
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
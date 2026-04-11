/**
 * shadow.ts — Realistic shadow (simulated) straddle entry using live order books.
 *
 * Simulation rules:
 *   Leg 1 (FOK): walk the live ask book up to limitPrice, accumulate shares.
 *                Reject if total fillable shares < targetShares (FOK semantics).
 *   Leg 2 (FOK): same — reject if book can't fully fill at or below limitPrice.
 *                If FOK rejected, fall back to GTC: mark as pending if best ask
 *                is close (≤ limitPrice + 0.02), otherwise mark as failed.
 *
 * Weighted average fill prices are calculated from the actual book levels walked.
 */

import { log } from "./logger.js";
import { fetchOrderBook, type OrderBookLevel } from "./polymarket.js";
import type { StraddlePosition, Market, BetRule, Leg } from "./types.js";

const POLY_MIN_SHARES = 5;

function generateId(): string {
  return `shadow-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

interface SimFill {
  success: boolean;
  avgPrice: number;
  filledShares: number;
  cost: number;
  rejectionReason?: string;
}

/**
 * Simulate a FOK buy against a live ask book.
 * Walks asks in price order up to limitPrice, accumulates shares.
 * Returns success only if targetShares is fully fillable.
 */
function simulateFokBuy(
  book: OrderBookLevel[],
  limitPrice: number,
  targetShares: number,
): SimFill {
  let remainingShares = targetShares;
  let totalCost = 0;

  for (const level of book) {
    if (level.price > limitPrice) break;
    const take = Math.min(level.size, remainingShares);
    totalCost += take * level.price;
    remainingShares -= take;
    if (remainingShares <= 0) break;
  }

  if (remainingShares > 1e-6) {
    const fillable = targetShares - remainingShares;
    return {
      success: false,
      avgPrice: 0,
      filledShares: 0,
      cost: 0,
      rejectionReason: `insufficient liquidity: need ${targetShares.toFixed(4)} shares, only ${fillable.toFixed(4)} available at/below ${limitPrice}`,
    };
  }

  const filledShares = targetShares;
  const avgPrice = totalCost / filledShares;
  return { success: true, avgPrice, filledShares, cost: totalCost };
}

export async function simulateShadowStraddle(
  market: Market,
  slotId: number,
  stakeUsd: number,
  rule: BetRule,
  leg1: Leg,
  leg2: Leg,
  hedgeDeadline: number,
): Promise<StraddlePosition | null> {
  const id = generateId();
  const now = new Date().toISOString();

  // ── Fetch both order books in parallel ─────────────────────────────────────
  let leg1Book: OrderBookLevel[];
  let leg2Book: OrderBookLevel[];
  try {
    [leg1Book, leg2Book] = await Promise.all([
      fetchOrderBook(leg1.tokenId),
      fetchOrderBook(leg2.tokenId),
    ]);
  } catch (err) {
    // On API error, fall back to instant-fill at limit price
    log.warn("SHADOW_BOOK_FETCH_FAILED", {
      id, marketId: market.id, error: (err as Error).message,
      fallback: "instant fill at limit price",
    });
    leg1Book = [{ price: leg1.limitPrice, size: leg1.targetShares + 100 }];
    leg2Book = [{ price: leg2.limitPrice, size: leg2.targetShares + 100 }];
  }

  // ── Simulate Leg 1 FOK ─────────────────────────────────────────────────────
  const leg1Fill = simulateFokBuy(leg1Book, leg1.limitPrice, leg1.targetShares);

  if (!leg1Fill.success) {
    log.warn("SHADOW_LEG1_REJECTED", {
      id, slotId, marketId: market.id,
      reason: leg1Fill.rejectionReason,
      limitPrice: leg1.limitPrice, targetShares: leg1.targetShares,
    });
    return null; // Leg 1 FOK failed — no position
  }

  const filledLeg1: Leg = {
    ...leg1,
    fillPrice: leg1Fill.avgPrice,
    filledShares: leg1Fill.filledShares,
    cost: leg1Fill.cost,
    status: "filled",
  };

  // ── Simulate Leg 2 FOK ─────────────────────────────────────────────────────
  const leg2Fill = simulateFokBuy(leg2Book, leg2.limitPrice, leg2.targetShares);

  let filledLeg2: Leg;
  let straddleStatus: StraddlePosition["status"];
  let entryMode: "both_fok" | "fok_then_gtc";

  if (leg2Fill.success) {
    filledLeg2 = {
      ...leg2,
      fillPrice: leg2Fill.avgPrice,
      filledShares: leg2Fill.filledShares,
      cost: leg2Fill.cost,
      status: "filled",
    };
    straddleStatus = "fully_hedged";
    entryMode = "both_fok";
  } else {
    // FOK failed — check if GTC at this price is plausible (best ask ≤ limit + 0.02)
    const bestAsk = leg2Book.length > 0 ? leg2Book[0].price : Infinity;
    const gtcPlausible = bestAsk <= leg2.limitPrice + 0.02;

    log.warn("SHADOW_LEG2_REJECTED", {
      id, slotId, marketId: market.id,
      reason: leg2Fill.rejectionReason,
      limitPrice: leg2.limitPrice, targetShares: leg2.targetShares,
      bestAsk, gtcFallback: gtcPlausible,
    });

    filledLeg2 = {
      ...leg2,
      fillPrice: gtcPlausible ? leg2.limitPrice : undefined,
      filledShares: gtcPlausible ? leg2.targetShares : undefined,
      cost: gtcPlausible ? leg2.limitPrice * leg2.targetShares : undefined,
      status: gtcPlausible ? "filled" : "failed",
      orderType: "GTC",
    };
    straddleStatus = gtcPlausible ? "fully_hedged" : "leg1_only";
    entryMode = "fok_then_gtc";
  }

  const straddle: StraddlePosition = {
    id,
    market,
    slotId,
    stakeUsd,
    targetShares: filledLeg1.filledShares!,
    rule,
    leg1: filledLeg1,
    leg2: filledLeg2,
    dcaEntries: [],
    weightedAvgLeg1Price: filledLeg1.fillPrice!,
    totalLeg1Shares: filledLeg1.filledShares!,
    totalLeg1Cost: filledLeg1.cost!,
    status: straddleStatus,
    entryMode,
    hedgeTrigger: null,
    shadow: true,
    createdAt: now,
    hedgeDeadline,
  };

  log.info("SHADOW_STRADDLE_CREATED", {
    id, slotId, marketId: market.id,
    asset: market.asset, duration: market.duration,
    leg1Side: leg1.side, leg1AvgPrice: filledLeg1.fillPrice, leg1LimitPrice: leg1.limitPrice,
    leg2Side: leg2.side, leg2Status: filledLeg2.status,
    leg2AvgPrice: filledLeg2.fillPrice, leg2LimitPrice: leg2.limitPrice,
    stakeUsd, rule, straddleStatus,
  });

  return straddle;
}

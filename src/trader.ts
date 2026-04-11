/**
 * trader.ts — Straddle entry & fill-management orchestrator.
 *
 * v3 strategy:
 *   - Sequential FOK: Leg 1 FOK → check → Leg 2 FOK → GTC fallback
 *   - Burst-then-relax polling: immediate → 1s → 2s → jittered ~5s
 *   - DCA: buy Leg 1 FIRST → then cancel Leg 2 → replace at higher limit
 *   - Stop-loss: force-buy Leg 2 at market when time runs low
 */

import { CONFIG } from "./config.js";
import { log } from "./logger.js";
import {
  placeStraddleLegOrder,
  cancelOpenOrder,
  getOrderFillStatus,
  fetchMarketResolution,
} from "./polymarket.js";
import {
  getIdleSlot,
  reserveSlot,
  releaseSlot,
  assignStraddle,
  recordWin,
  recordLoss,
} from "./slots.js";
import { trackMarket, untrackMarket } from "./scanner.js";
import { createShadowStraddle } from "./shadow.js";
import { enqueueRedemption } from "./redemptionQueue.js";
import type { Market, StraddlePosition, Leg, BetRule } from "./types.js";

const activeStraddlesByMarketId = new Map<string, StraddlePosition>();
const latestPriceByMarketId = new Map<string, { yesAsk: number; noAsk: number }>();
const fillMonitorRefs = new Map<string, ReturnType<typeof setTimeout>>();

export function getActiveStraddleCount(): number {
  return activeStraddlesByMarketId.size;
}

function generateId(): string {
  return `str-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ─── dump detected entry point ────────────────────────────────────────────────

export async function handleDumpDetected(
  market: Market,
  dumpedSide: "YES" | "NO",
  dumpAsk: number,
  oppositeAsk: number,
  rule: BetRule,
): Promise<void> {
  if (activeStraddlesByMarketId.has(market.id)) return;

  const slot = getIdleSlot();
  if (!slot) {
    log.warn("STRADDLE_SKIPPED_NO_SLOT", {
      marketId: market.id, asset: market.asset, rule,
    });
    return;
  }

  reserveSlot(slot.id);
  trackMarket(market.id);

  const stakeUsd = slot.balance;
  const oppositeSide: "YES" | "NO" = dumpedSide === "YES" ? "NO" : "YES";
  const dumpedTokenId = dumpedSide === "YES" ? market.yesTokenId : market.noTokenId;
  const oppositeTokenId = dumpedSide === "YES" ? market.noTokenId : market.yesTokenId;
  const hedgeDeadline = Date.now() + CONFIG.hedgeTimeoutSeconds * 1000;

  log.info("STRADDLE_ENTRY_START", {
    slotId: slot.id, stakeUsd, marketId: market.id,
    asset: market.asset, duration: market.duration,
    dumpedSide, dumpAsk, oppositeAsk, rule,
    shadowMode: CONFIG.shadowMode,
  });

  // Build leg descriptors
  const targetShares = stakeUsd / dumpAsk;
  const leg2LimitPrice = Math.max(0.01, CONFIG.sumTarget - dumpAsk);

  const leg1: Leg = {
    side: dumpedSide,
    tokenId: dumpedTokenId,
    limitPrice: dumpAsk,
    targetShares,
    status: "pending",
    orderType: "FOK",
  };

  const leg2: Leg = {
    side: oppositeSide,
    tokenId: oppositeTokenId,
    limitPrice: leg2LimitPrice,
    targetShares,
    status: "pending",
    orderType: "FOK",
  };

  // ── Shadow mode ─────────────────────────────────────────────────────────────
  if (CONFIG.shadowMode) {
    const straddle = createShadowStraddle(
      market, slot.id, stakeUsd, rule, leg1, leg2, "both_fok", hedgeDeadline,
    );
    activeStraddlesByMarketId.set(market.id, straddle);
    assignStraddle(slot.id, straddle);
    startFallbackResolutionWatcher(straddle);
    return;
  }

  // ── Live mode: Sequential FOK ───────────────────────────────────────────────

  // Leg 1: FOK
  const leg1Result = await placeStraddleLegOrder(
    dumpedTokenId, dumpAsk, targetShares, market.tickSize, market.negRisk, "FOK",
  );

  if (!leg1Result.success) {
    log.error("LEG1_FAILED", {
      slotId: slot.id, marketId: market.id, error: leg1Result.error,
    });
    releaseSlot(slot.id);
    untrackMarket(market.id);
    return;
  }

  const leg1FillPrice = leg1Result.avgPrice ?? dumpAsk;
  const leg1Shares = stakeUsd / leg1FillPrice;
  leg1.orderId = leg1Result.orderId;
  leg1.fillPrice = leg1FillPrice;
  leg1.filledShares = leg1Shares;
  leg1.cost = stakeUsd;
  leg1.status = "filled";

  log.info("LEG1_FILLED", {
    slotId: slot.id, marketId: market.id,
    price: leg1FillPrice, shares: round2(leg1Shares), cost: stakeUsd,
  });

  // Recalculate Leg 2 limit based on actual fill
  const actualLeg2Limit = Math.max(0.01, CONFIG.sumTarget - leg1FillPrice);
  leg2.limitPrice = actualLeg2Limit;
  leg2.targetShares = leg1Shares;

  // Leg 2: try FOK first if sum is favorable
  const sum = leg1FillPrice + oppositeAsk;
  let entryMode: "both_fok" | "fok_then_gtc" = "both_fok";

  if (sum <= CONFIG.sumTarget) {
    const leg2Result = await placeStraddleLegOrder(
      oppositeTokenId, oppositeAsk, leg1Shares, market.tickSize, market.negRisk, "FOK",
    );

    if (leg2Result.success) {
      leg2.orderId = leg2Result.orderId;
      leg2.fillPrice = leg2Result.avgPrice ?? oppositeAsk;
      leg2.filledShares = leg1Shares;
      leg2.cost = leg2.fillPrice * leg1Shares;
      leg2.status = "filled";
      leg2.orderType = "FOK";

      const straddle = buildStraddle(
        market, slot.id, stakeUsd, rule, leg1, leg2, "both_fok", "fully_hedged", hedgeDeadline,
      );
      activeStraddlesByMarketId.set(market.id, straddle);
      assignStraddle(slot.id, straddle);
      startFallbackResolutionWatcher(straddle);

      log.info("STRADDLE_FULLY_HEDGED", {
        id: straddle.id, marketId: market.id,
        leg1Price: leg1FillPrice, leg2Price: leg2.fillPrice,
        totalCost: round2(stakeUsd + leg2.cost!),
      });
      return;
    }

    log.warn("LEG2_FOK_FAILED", {
      marketId: market.id, error: leg2Result.error,
      message: "Falling back to GTC",
    });
  }

  // Leg 2: GTC fallback
  entryMode = "fok_then_gtc";
  const leg2GtcResult = await placeStraddleLegOrder(
    oppositeTokenId, actualLeg2Limit, leg1Shares, market.tickSize, market.negRisk, "GTC",
  );

  if (!leg2GtcResult.success) {
    log.error("LEG2_GTC_FAILED", {
      marketId: market.id, error: leg2GtcResult.error,
      message: "Straddle has unhedged Leg 1 — will monitor for resolution",
    });
    leg2.status = "failed";
  } else {
    leg2.orderId = leg2GtcResult.orderId;
    leg2.status = "pending";
    leg2.orderType = "GTC";
  }

  const straddle = buildStraddle(
    market, slot.id, stakeUsd, rule, leg1, leg2,
    entryMode,
    leg2.status === "pending" ? "leg2_pending" : "leg1_only",
    hedgeDeadline,
  );
  activeStraddlesByMarketId.set(market.id, straddle);
  assignStraddle(slot.id, straddle);
  startFallbackResolutionWatcher(straddle);

  if (leg2.status === "pending") {
    startFillMonitor(straddle);
  }
}

// ─── price update handler ─────────────────────────────────────────────────────

export function handlePriceUpdate(
  marketId: string,
  yesPrice: number,
  noPrice: number,
): void {
  latestPriceByMarketId.set(marketId, { yesAsk: yesPrice, noAsk: noPrice });
}

// ─── WebSocket resolution ─────────────────────────────────────────────────────

export function handleWsResolution(
  marketId: string,
  winningTokenId: string,
  winningOutcome: string,
): void {
  const straddle = activeStraddlesByMarketId.get(marketId);
  if (!straddle) return;

  // Stop fill monitor
  const monitorRef = fillMonitorRefs.get(marketId);
  if (monitorRef) {
    clearTimeout(monitorRef);
    fillMonitorRefs.delete(marketId);
  }

  // Cancel pending Leg 2 if still outstanding
  if (straddle.leg2.status === "pending" && straddle.leg2.orderId) {
    cancelOpenOrder(straddle.leg2.orderId).catch(() => {});
  }

  straddle.status = "resolved";
  straddle.resolvedAt = new Date().toISOString();

  const winningSide = normaliseOutcome(winningOutcome, winningTokenId, straddle);

  // Calculate payout: winning shares × $1
  let payoutUsd = 0;
  let totalCostUsd = straddle.totalLeg1Cost;
  if (straddle.leg2.status === "filled" && straddle.leg2.cost) {
    totalCostUsd += straddle.leg2.cost;
  }

  if (winningSide === straddle.leg1.side) {
    payoutUsd = straddle.totalLeg1Shares;
  } else if (straddle.leg2.status === "filled" && straddle.leg2.filledShares) {
    payoutUsd = straddle.leg2.filledShares;
  }

  const profit = payoutUsd - totalCostUsd;
  const isWin = profit > 0;

  log.info(straddle.shadow ? "SHADOW_RESOLUTION" : "RESOLUTION", {
    id: straddle.id, marketId, winningSide,
    payoutUsd: round2(payoutUsd), totalCostUsd: round2(totalCostUsd),
    profit: round2(profit), isWin,
    leg1: { side: straddle.leg1.side, status: straddle.leg1.status, price: straddle.leg1.fillPrice },
    leg2: { side: straddle.leg2.side, status: straddle.leg2.status, price: straddle.leg2.fillPrice },
  });

  if (isWin) {
    recordWin(straddle.slotId, payoutUsd, totalCostUsd);
    if (!straddle.shadow) {
      enqueueRedemption(straddle.market);
    }
  } else {
    const lostUsd = Math.max(0, totalCostUsd - payoutUsd);
    recordLoss(straddle.slotId, lostUsd);
  }

  activeStraddlesByMarketId.delete(marketId);
  latestPriceByMarketId.delete(marketId);
  untrackMarket(marketId);
}

// ─── fill monitor (burst-then-relax) ──────────────────────────────────────────

function startFillMonitor(straddle: StraddlePosition): void {
  const burstDelays = [0, 1000, 2000];
  let pollIndex = 0;

  function scheduleNext(): void {
    if (!activeStraddlesByMarketId.has(straddle.market.id)) return;
    if (straddle.status === "fully_hedged" || straddle.status === "resolved") return;

    let delay: number;
    if (pollIndex < burstDelays.length) {
      delay = burstDelays[pollIndex];
    } else {
      // Jittered ±20%
      delay = CONFIG.fillPollIntervalMs * (0.8 + Math.random() * 0.4);
    }
    pollIndex++;

    const ref = setTimeout(async () => {
      fillMonitorRefs.delete(straddle.market.id);
      await pollOnce(straddle);
      scheduleNext();
    }, delay);
    ref.unref?.();
    fillMonitorRefs.set(straddle.market.id, ref);
  }

  scheduleNext();
}

async function pollOnce(straddle: StraddlePosition): Promise<void> {
  if (!activeStraddlesByMarketId.has(straddle.market.id)) return;
  if (straddle.status === "fully_hedged" || straddle.status === "resolved") return;

  const market = straddle.market;
  const now = Date.now();
  const closesAt = new Date(market.closesAt).getTime();
  const timeRemaining = Math.max(0, Math.floor((closesAt - now) / 1000));

  // ── Stop-loss check ───────────────────────────────────────────────────────
  if (timeRemaining <= CONFIG.stopLossRemainingSeconds && straddle.leg2.status !== "filled") {
    log.warn("STOP_LOSS_TRIGGERED", {
      id: straddle.id, marketId: market.id, timeRemaining,
    });

    if (straddle.leg2.orderId) {
      await cancelOpenOrder(straddle.leg2.orderId).catch(() => {});
    }

    const forceBuyResult = await placeStraddleLegOrder(
      straddle.leg2.tokenId, 0.99, straddle.leg2.targetShares,
      market.tickSize, market.negRisk, "FOK",
    );

    if (forceBuyResult.success) {
      straddle.leg2.orderId = forceBuyResult.orderId;
      straddle.leg2.fillPrice = forceBuyResult.avgPrice ?? 0.99;
      straddle.leg2.filledShares = straddle.leg2.targetShares;
      straddle.leg2.cost = straddle.leg2.fillPrice * straddle.leg2.targetShares;
      straddle.leg2.status = "filled";
      straddle.status = "fully_hedged";
      straddle.hedgeTrigger = "stop_loss";
      log.info("STOP_LOSS_FILLED", {
        id: straddle.id, price: straddle.leg2.fillPrice,
      });
    } else {
      log.error("STOP_LOSS_FAILED", {
        id: straddle.id, error: forceBuyResult.error,
      });
    }
    return;
  }

  // ── Check Leg 2 fill status ───────────────────────────────────────────────
  if (straddle.leg2.status === "pending" && straddle.leg2.orderId) {
    try {
      const fill = await getOrderFillStatus(straddle.leg2.orderId);
      if (fill.filled) {
        straddle.leg2.fillPrice = straddle.leg2.limitPrice;
        straddle.leg2.filledShares = straddle.leg2.targetShares;
        straddle.leg2.cost = straddle.leg2.fillPrice * straddle.leg2.targetShares;
        straddle.leg2.status = "filled";
        straddle.status = "fully_hedged";
        straddle.hedgeTrigger = "target_met";
        log.info("LEG2_GTC_FILLED", {
          id: straddle.id, marketId: market.id,
          price: straddle.leg2.fillPrice,
        });
        return;
      }
    } catch (err) {
      log.warn("FILL_POLL_ERROR", {
        id: straddle.id, error: (err as Error).message,
      });
    }
  }

  // ── DCA check ─────────────────────────────────────────────────────────────
  if (
    CONFIG.enableDca &&
    straddle.dcaEntries.length < CONFIG.maxDcaCount &&
    straddle.leg2.status === "pending"
  ) {
    const prices = latestPriceByMarketId.get(market.id);
    if (prices) {
      const currentLeg1Ask = straddle.leg1.side === "YES" ? prices.yesAsk : prices.noAsk;
      const threshold = straddle.weightedAvgLeg1Price * (1 - CONFIG.dcaThresholdPercent / 100);

      if (currentLeg1Ask <= threshold && currentLeg1Ask > 0) {
        log.info("DCA_TRIGGERED", {
          id: straddle.id, currentLeg1Ask,
          weightedAvg: straddle.weightedAvgLeg1Price, threshold,
        });

        // Step 1: Buy more Leg 1 FIRST
        const dcaAmount = straddle.stakeUsd;
        const dcaShares = dcaAmount / currentLeg1Ask;

        const dcaResult = await placeStraddleLegOrder(
          straddle.leg1.tokenId, currentLeg1Ask, dcaShares,
          market.tickSize, market.negRisk, "FOK",
        );

        if (dcaResult.success) {
          const dcaFillPrice = dcaResult.avgPrice ?? currentLeg1Ask;
          const dcaCost = dcaAmount;
          const dcaFilledShares = dcaAmount / dcaFillPrice;

          const newTotalCost = straddle.totalLeg1Cost + dcaCost;
          const newTotalShares = straddle.totalLeg1Shares + dcaFilledShares;
          const newWeightedAvg = newTotalCost / newTotalShares;

          straddle.totalLeg1Cost = newTotalCost;
          straddle.totalLeg1Shares = newTotalShares;
          straddle.weightedAvgLeg1Price = newWeightedAvg;

          straddle.dcaEntries.push({
            price: dcaFillPrice,
            shares: dcaFilledShares,
            cost: dcaCost,
            orderId: dcaResult.orderId,
            filledAt: new Date().toISOString(),
          });

          log.info("DCA_FILLED", {
            id: straddle.id, dcaPrice: dcaFillPrice,
            dcaShares: round2(dcaFilledShares), newWeightedAvg: round2(newWeightedAvg),
            totalShares: round2(newTotalShares),
          });

          // Step 2: Cancel old Leg 2
          if (straddle.leg2.orderId) {
            await cancelOpenOrder(straddle.leg2.orderId).catch(() => {});
          }

          // Step 3: Replace Leg 2 at new limit
          const newLeg2Limit = Math.max(0.01, CONFIG.sumTarget - newWeightedAvg);
          const newLeg2Result = await placeStraddleLegOrder(
            straddle.leg2.tokenId, newLeg2Limit, newTotalShares,
            market.tickSize, market.negRisk, "GTC",
          );

          if (newLeg2Result.success) {
            straddle.leg2.orderId = newLeg2Result.orderId;
            straddle.leg2.limitPrice = newLeg2Limit;
            straddle.leg2.targetShares = newTotalShares;
            straddle.leg2.status = "pending";
            log.info("LEG2_REPLACED", {
              id: straddle.id, newLimit: round2(newLeg2Limit),
              newShares: round2(newTotalShares),
            });
          } else {
            log.error("LEG2_REPLACE_FAILED", {
              id: straddle.id, error: newLeg2Result.error,
            });
          }
        } else {
          log.warn("DCA_FOK_FAILED", {
            id: straddle.id, error: dcaResult.error,
          });
        }
      }
    }
  }
}

// ─── fallback resolution watcher ──────────────────────────────────────────────

function startFallbackResolutionWatcher(straddle: StraddlePosition): void {
  const closeMs = new Date(straddle.market.closesAt).getTime();
  const delayUntilFirstPoll = Math.max(0, closeMs - Date.now() + 10_000);

  const startTimeout = setTimeout(() => {
    if (!activeStraddlesByMarketId.has(straddle.market.id)) return;

    const poll = setInterval(async () => {
      if (!activeStraddlesByMarketId.has(straddle.market.id)) {
        clearInterval(poll);
        return;
      }

      try {
        const resolution = await fetchMarketResolution(straddle.market.id, straddle.leg1.side);
        if (resolution.outcome === "PENDING") return;

        clearInterval(poll);

        if (resolution.outcome === "CANCELLED") {
          const lostUsd = straddle.totalLeg1Cost;
          activeStraddlesByMarketId.delete(straddle.market.id);
          recordLoss(straddle.slotId, lostUsd);
          untrackMarket(straddle.market.id);
        } else {
          handleWsResolution(straddle.market.id, "", resolution.outcome);
        }
      } catch (err) {
        log.error("RESOLUTION_ERROR", {
          id: straddle.id, error: (err as Error).message,
        });
      }
    }, CONFIG.resolutionPollIntervalMs);
  }, delayUntilFirstPoll);

  startTimeout.unref?.();
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function buildStraddle(
  market: Market,
  slotId: number,
  stakeUsd: number,
  rule: BetRule,
  leg1: Leg,
  leg2: Leg,
  entryMode: "both_fok" | "fok_then_gtc",
  status: "fully_hedged" | "leg2_pending" | "leg1_only",
  hedgeDeadline: number,
): StraddlePosition {
  return {
    id: generateId(),
    market,
    slotId,
    stakeUsd,
    targetShares: leg1.filledShares ?? leg1.targetShares,
    rule,
    leg1,
    leg2,
    dcaEntries: [],
    weightedAvgLeg1Price: leg1.fillPrice ?? leg1.limitPrice,
    totalLeg1Shares: leg1.filledShares ?? leg1.targetShares,
    totalLeg1Cost: leg1.cost ?? stakeUsd,
    status,
    entryMode,
    hedgeTrigger: status === "fully_hedged" ? "target_met" : null,
    shadow: false,
    createdAt: new Date().toISOString(),
    hedgeDeadline,
  };
}

function normaliseOutcome(outcome: string, tokenId: string, straddle: StraddlePosition): "YES" | "NO" {
  const u = outcome.toUpperCase();
  if (u === "UP" || u === "YES") return "YES";
  if (u === "DOWN" || u === "NO") return "NO";
  if (tokenId === straddle.market.yesTokenId) return "YES";
  if (tokenId === straddle.market.noTokenId) return "NO";
  log.warn("WARN", { message: "Unrecognised outcome — defaulting NO", outcome, tokenId });
  return "NO";
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

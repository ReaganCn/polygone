/**
 * shadow.ts — Creates shadow (simulated) straddle positions.
 * Both legs are instantly marked "filled" at their limit prices.
 */

import { log } from "./logger.js";
import type { StraddlePosition, Market, BetRule, Leg } from "./types.js";

function generateId(): string {
  return `shadow-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createShadowStraddle(
  market: Market,
  slotId: number,
  stakeUsd: number,
  rule: BetRule,
  leg1: Leg,
  leg2: Leg,
  entryMode: "both_fok" | "fok_then_gtc",
  hedgeDeadline: number,
): StraddlePosition {
  const id = generateId();
  const now = new Date().toISOString();

  const filledLeg1: Leg = {
    ...leg1,
    fillPrice: leg1.limitPrice,
    filledShares: leg1.targetShares,
    cost: leg1.limitPrice * leg1.targetShares,
    status: "filled",
  };

  const filledLeg2: Leg = {
    ...leg2,
    fillPrice: leg2.limitPrice,
    filledShares: leg2.targetShares,
    cost: leg2.limitPrice * leg2.targetShares,
    status: "filled",
  };

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
    status: "fully_hedged",
    entryMode,
    hedgeTrigger: null,
    shadow: true,
    createdAt: now,
    hedgeDeadline,
  };

  log.info("SHADOW_STRADDLE_CREATED", {
    id, slotId, marketId: market.id,
    asset: market.asset, duration: market.duration,
    leg1Side: leg1.side, leg1Price: leg1.limitPrice,
    leg2Side: leg2.side, leg2Price: leg2.limitPrice,
    stakeUsd, rule,
  });

  return straddle;
}

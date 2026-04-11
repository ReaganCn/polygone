/**
 * types.ts — Shared domain types.
 *
 * STRADDLE OVERHAUL:
 *   - BetRule narrowed to "5m" | "15m" (fallback removed)
 *   - ActiveBet removed; replaced by StraddlePosition + Leg + DcaEntry
 *   - Market carries yesPrice/noPrice instead of winSide/winSidePrice/tokenIdToBuy
 */

export type BetRule = "5m" | "15m";

export type LegOrderType = "GTC" | "GTD" | "FOK" | "FAK";

export type LegStatus = "pending" | "filled" | "cancelled" | "failed";

export interface Leg {
  side: "YES" | "NO";
  tokenId: string;
  limitPrice: number;
  targetShares: number;
  orderId?: string;
  fillPrice?: number;
  filledShares?: number;
  cost?: number;
  status: LegStatus;
  orderType: LegOrderType;
}

export interface DcaEntry {
  price: number;
  shares: number;
  cost: number;
  orderId?: string;
  filledAt: string;
}

export type StraddleStatus =
  | "entering"
  | "leg1_only"
  | "leg2_pending"
  | "fully_hedged"
  | "resolved";

export type HedgeTrigger = "target_met" | "stop_loss" | null;

export interface StraddlePosition {
  id: string;
  market: Market;
  slotId: number;
  stakeUsd: number;
  targetShares: number;
  rule: BetRule;
  leg1: Leg;
  leg2: Leg;
  dcaEntries: DcaEntry[];
  weightedAvgLeg1Price: number;
  totalLeg1Shares: number;
  totalLeg1Cost: number;
  status: StraddleStatus;
  entryMode: "both_fok" | "fok_then_gtc";
  hedgeTrigger: HedgeTrigger;
  shadow: boolean;
  createdAt: string;
  hedgeDeadline: number;
  resolvedAt?: string;
}

export interface Market {
  id: string;
  conditionId: string;
  question: string;
  asset: string;
  duration: string;
  closesAt: string;
  timeRemainingSeconds: number;
  yesPrice: number;
  noPrice: number;
  yesTokenId: string;
  noTokenId: string;
  negRisk: boolean;
  tickSize: string;
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  avgPrice?: number;
  filled?: boolean;
  rawResponse?: unknown;
  error?: string;
}

export type ResolutionOutcome = "YES" | "NO" | "PENDING" | "CANCELLED";

export interface MarketResolution {
  marketId: string;
  outcome: ResolutionOutcome;
  resolvedAt?: string;
}

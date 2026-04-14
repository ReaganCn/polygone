/**
 * types.ts — Shared domain types.
 */

export type BetRule = "5m" | "15m" | "fallback";

export interface Market {
  id: string;
  conditionId: string; 
  question: string;
  asset: string;
  /** Canonical duration key: "5m" | "15m" */
  duration: string;
  closesAt: string;
  timeRemainingSeconds: number;
  winSide: "YES" | "NO";
  winSidePrice: number;
  yesTokenId: string;
  noTokenId: string;
  tokenIdToBuy: string;
  negRisk: boolean;
  tickSize: string;
}

export interface ActiveBet {
  betId: string;
  market: Market;
  slotId: number;
  stakeUsd: number;
  expectedPayoutUsd: number;
  orderId?: string;
  placedAt: string;
  shadow: boolean;
  side: "YES" | "NO";
  /** Ask price paid at entry — used for payout calculation. */
  priceAtBet: number;
  /** Best bid recorded at entry — used as TP/SL baseline. */
  bidPriceAtBet: number;
  /** Which qualifying rule triggered this bet */
  rule: BetRule;
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
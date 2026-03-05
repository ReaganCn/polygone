/**
 * types.ts — Shared domain types.
 */

export type BetRule = "5m" | "15m" | "fallback";

export interface Market {
  id: string;
  conditionId: string;
  question: string;
  asset: string;
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
  priceAtBet: number;
  rule: BetRule;
  stopLossTriggered?: boolean;
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  avgPrice?: number;
  filled?: boolean;
  /** Shares actually filled — used for partial-fill detection in stop-loss. */
  filledShares?: number;
  /**
   * USDC actually recovered from a stop-loss sell.
   * Read directly from the CLOB response takingAmount field for a SELL order.
   * Only set by sellPosition() — not set by placeOrder().
   * handleStopLoss() reads this directly; no filledShares × price recomputation.
   */
  recoveredUsd?: number;
  error?: string;
  rawResponse?: unknown;
}

export interface MarketResolution {
  marketId: string;
  outcome: "YES" | "NO" | "CANCELLED" | "PENDING";
  resolvedAt?: string;
}
/**
 * types.ts — Shared domain types.
 */

export type BetRule = "5m" | "15m" | "fallback";

export interface Market {
  id: string;
  conditionId: string;   // CTF condition ID — required by redeemer.ts to call redeemPositions()
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
  priceAtBet: number;
  /** Which qualifying rule triggered this bet */
  rule: BetRule;
  /**
   * Set to true once a stop-loss sell has been initiated for this bet.
   * Prevents the scanner from firing the stop-loss a second time on the
   * next price tick while the first sell order is still in-flight.
   */
  stopLossTriggered?: boolean;
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  avgPrice?: number;
  filled?: boolean;
  /** Shares actually filled (used by stop-loss to compute recovered USDC) */
  filledShares?: number;
  error?: string;
  rawResponse?: unknown;
}

export interface MarketResolution {
  marketId: string;
  outcome: "YES" | "NO" | "CANCELLED" | "PENDING";
  resolvedAt?: string;
}
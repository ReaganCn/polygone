/**
 * scanner.ts
 *
 * Periodically fetches open crypto up/down markets from Polymarket and
 * applies the two-rule filter to find betting opportunities:
 *
 *   Primary rule:   priceRangeMin ≤ winSidePrice ≤ priceRangeMax
 *   Fallback rule:  timeRemainingSeconds ≤ fallbackTimeRemainingS
 *                   AND winSidePrice ≤ fallbackMaxPrice
 *
 * Qualifying markets that are not already being tracked are emitted
 * via a callback to trader.ts.
 *
 * The scanner also maintains a "seen" set to avoid submitting the same
 * market twice. Markets are removed from this set once they have resolved
 * or expired.
 */

import { CONFIG } from "./config.js";
import { log } from "./logger.js";
import { fetchCryptoMarkets } from "./polymarket.js";
import type { Market } from "./types.js";

// ─── types ───────────────────────────────────────────────────────────────────

type MarketCallback = (market: Market) => void;

// ─── module state ─────────────────────────────────────────────────────────────

/** Market IDs that are already being tracked (active bet or recently seen) */
const trackedMarketIds = new Set<string>();

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let isRunning = false;
let isPaused = false;

// ─── public API ───────────────────────────────────────────────────────────────

/**
 * Start the scanner loop.
 * @param onMarketFound - called for each qualifying market
 */
export function startScanner(onMarketFound: MarketCallback): void {
  if (isRunning) return;
  isRunning = true;
  isPaused = false;

  log.info("INFO", { message: "Scanner started.", intervalMs: CONFIG.scanIntervalMs });

  // Run immediately, then on interval
  void runScanTick(onMarketFound);

  intervalHandle = setInterval(() => {
    if (!isPaused) {
      void runScanTick(onMarketFound);
    }
  }, CONFIG.scanIntervalMs);
}

export function pauseScanner(): void {
  isPaused = true;
  log.info("BOT_PAUSED", { message: "Scanner paused — no new bets will be placed." });
}

export function resumeScanner(): void {
  isPaused = false;
  log.info("BOT_RESUMED", { message: "Scanner resumed." });
}

export function stopScanner(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  isRunning = false;
}

export function isPausedState(): boolean {
  return isPaused;
}

/**
 * Mark a market as being tracked (active bet placed).
 * The scanner will skip it on future ticks.
 */
export function trackMarket(marketId: string): void {
  trackedMarketIds.add(marketId);
}

/**
 * Untrack a market once its bet has resolved.
 * This allows the same market ID to be bet on again if it somehow reopens,
 * but mainly serves to keep the set from growing indefinitely.
 */
export function untrackMarket(marketId: string): void {
  trackedMarketIds.delete(marketId);
}

// ─── internals ────────────────────────────────────────────────────────────────

async function runScanTick(onMarketFound: MarketCallback): Promise<void> {
  log.info("SCAN_TICK", {
    trackedCount: trackedMarketIds.size,
    shadowMode: CONFIG.shadowMode,
  });

  let markets: Market[];
  try {
    markets = await fetchCryptoMarkets();
  } catch (err) {
    log.error("SCAN_ERROR", { error: (err as Error).message });
    return;
  }

  for (const market of markets) {
    // Skip markets already being tracked
    if (trackedMarketIds.has(market.id)) continue;

    const qualifies = evaluateMarket(market);

    if (qualifies) {
      log.info("MARKET_FOUND", {
        marketId: market.id,
        question: market.question,
        asset: market.asset,
        duration: market.duration,
        winSide: market.winSide,
        winSidePrice: market.winSidePrice,
        timeRemainingSeconds: market.timeRemainingSeconds,
        closesAt: market.closesAt,
        tokenIdToBuy: market.tokenIdToBuy,
        rule: getRuleLabel(market),
      });
      onMarketFound(market);
    } else {
      log.info("MARKET_SKIPPED", {
        marketId: market.id,
        question: market.question,
        asset: market.asset,
        winSide: market.winSide,
        winSidePrice: market.winSidePrice,
        timeRemainingSeconds: market.timeRemainingSeconds,
        reason: getSkipReason(market),
      });
    }
  }
}

/**
 * Returns true if this market qualifies for a bet under either rule.
 */
function evaluateMarket(market: Market): boolean {
  const { winSidePrice, timeRemainingSeconds } = market;

  // Primary rule
  const primaryQualifies =
    winSidePrice >= CONFIG.priceRangeMin && winSidePrice <= CONFIG.priceRangeMax;

  // Fallback rule
  const fallbackQualifies =
    timeRemainingSeconds <= CONFIG.fallbackTimeRemainingS &&
    winSidePrice <= CONFIG.fallbackMaxPrice;

  return primaryQualifies || fallbackQualifies;
}

function getRuleLabel(market: Market): string {
  const { winSidePrice, timeRemainingSeconds } = market;
  const primary =
    winSidePrice >= CONFIG.priceRangeMin && winSidePrice <= CONFIG.priceRangeMax;
  return primary ? "primary" : "fallback";
}

function getSkipReason(market: Market): string {
  const { winSidePrice, timeRemainingSeconds } = market;
  if (winSidePrice < CONFIG.priceRangeMin) {
    return `price ${winSidePrice} below min ${CONFIG.priceRangeMin}`;
  }
  if (winSidePrice > CONFIG.priceRangeMax) {
    return `price ${winSidePrice} above max ${CONFIG.priceRangeMax}`;
  }
  if (
    timeRemainingSeconds > CONFIG.fallbackTimeRemainingS &&
    (winSidePrice < CONFIG.priceRangeMin || winSidePrice > CONFIG.priceRangeMax)
  ) {
    return `outside price range and time (${timeRemainingSeconds}s) > fallback threshold (${CONFIG.fallbackTimeRemainingS}s)`;
  }
  return "does not meet primary or fallback criteria";
}

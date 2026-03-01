/**
 * scanner.ts — WebSocket-driven market scanner.
 *
 * Qualifying rules (all configurable, all hot-updatable):
 *
 *   5m rule:  market.duration === "5m"
 *             && CONFIG.enable5m
 *             && timeRemaining <= CONFIG.maxTimeRemaining5m
 *             && price in [priceRangeMin5m, priceRangeMax5m]
 *
 *   15m rule: market.duration === "15m"
 *             && CONFIG.enable15m
 *             && timeRemaining <= CONFIG.maxTimeRemaining15m
 *             && price in [priceRangeMin15m, priceRangeMax15m]
 *
 *   fallback: CONFIG.enableFallback
 *             && timeRemaining <= CONFIG.fallbackTimeRemainingS
 *             && price <= CONFIG.fallbackMaxPrice
 *             (applies to any duration — catches near-expiry markets)
 *
 * Rules are checked in order: 5m → 15m → fallback.
 * A market only fires one callback per evaluation (first matching rule wins).
 */

import { CONFIG } from "./config.js";
import { log } from "./logger.js";
import { fetchCryptoMarkets } from "./polymarket.js";
import {
  connectWebSocket,
  subscribeTokenIds,
  unsubscribeTokenIds,
  disconnectWebSocket,
  getTokenPrice,
  type WsCallbacks,
  type TokenPrice,
  type ResolvedMarketEvent,
  type NewMarketEvent,
} from "./websocket.js";
import type { Market, BetRule } from "./types.js";

type MarketCallback = (market: Market, rule: BetRule) => void;
type ResolutionCallback = (marketId: string, winningTokenId: string, winningOutcome: string) => void;

const knownMarkets = new Map<string, Market>();
const tokenToMarket = new Map<string, string>();
const trackedMarketIds = new Set<string>();

let onMarketFoundCb: MarketCallback | null = null;
let onMarketResolvedCb: ResolutionCallback | null = null;
let heartbeatHandle: ReturnType<typeof setInterval> | null = null;
let wsConnected = false;
let isPaused = false;
let isRunning = false;

// ─── public API ───────────────────────────────────────────────────────────────

export async function startScanner(
  onMarketFound: MarketCallback,
  onMarketResolved: ResolutionCallback
): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  isPaused = false;
  onMarketFoundCb = onMarketFound;
  onMarketResolvedCb = onMarketResolved;

  await fetchWithRetry();

  heartbeatHandle = setInterval(async () => {
    if (!isPaused) await refreshKnownMarkets();
  }, CONFIG.scanIntervalMs);

  log.info("INFO", {
    message: "Scanner started.",
    knownMarketCount: knownMarkets.size,
    heartbeatIntervalMs: CONFIG.scanIntervalMs,
    rules: {
      "5m":      { enabled: CONFIG.enable5m,       maxTimeRemaining: CONFIG.maxTimeRemaining5m,  priceRange: [CONFIG.priceRangeMin5m,  CONFIG.priceRangeMax5m]  },
      "15m":     { enabled: CONFIG.enable15m,      maxTimeRemaining: CONFIG.maxTimeRemaining15m, priceRange: [CONFIG.priceRangeMin15m, CONFIG.priceRangeMax15m] },
      "fallback":{ enabled: CONFIG.enableFallback, timeRemaining5m: CONFIG.fallbackTimeRemaining5m, timeRemaining15m: CONFIG.fallbackTimeRemaining15m, minPrice: CONFIG.fallbackMinPrice, maxPrice: CONFIG.fallbackMaxPrice },
    },
  });
}

export function pauseScanner(): void {
  isPaused = true;
  log.info("BOT_PAUSED", { message: "Scanner paused." });
}

export function resumeScanner(): void {
  isPaused = false;
  log.info("BOT_RESUMED", { message: "Scanner resumed." });
}

export function stopScanner(): void {
  if (heartbeatHandle) { clearInterval(heartbeatHandle); heartbeatHandle = null; }
  disconnectWebSocket();
  isRunning = false;
}

export function isPausedState(): boolean { return isPaused; }
export function trackMarket(id: string): void { trackedMarketIds.add(id); }
export function untrackMarket(id: string): void { trackedMarketIds.delete(id); }

// ─── fetch / refresh ──────────────────────────────────────────────────────────

async function fetchWithRetry(): Promise<void> {
  let attempts = 0;
  while (true) {
    attempts++;
    await refreshKnownMarkets();
    if (knownMarkets.size > 0) {
      log.info("INFO", { message: `Found ${knownMarkets.size} market(s) on attempt ${attempts}.` });
      break;
    }
    log.warn("WARN", {
      message: `No markets found (attempt ${attempts}). Retrying in ${CONFIG.scanIntervalMs}ms...`,
    });
    await sleep(CONFIG.scanIntervalMs);
  }
}

async function refreshKnownMarkets(): Promise<void> {
  let markets: Market[];
  try {
    markets = await fetchCryptoMarkets();
  } catch (err) {
    log.error("SCAN_ERROR", { message: "Market fetch failed", error: (err as Error).message });
    return;
  }

  const now = Date.now();
  let newCount = 0;
  const newTokenIds: string[] = [];

  for (const market of markets) {
    if (!knownMarkets.has(market.id)) {
      knownMarkets.set(market.id, market);
      tokenToMarket.set(market.yesTokenId, market.id);
      tokenToMarket.set(market.noTokenId, market.id);
      newTokenIds.push(market.yesTokenId, market.noTokenId);
      newCount++;
    } else {
      knownMarkets.set(market.id, market);
    }
  }

  // Prune expired
  for (const [id, market] of knownMarkets) {
    if (new Date(market.closesAt).getTime() < now - 30_000) {
      knownMarkets.delete(id);
      tokenToMarket.delete(market.yesTokenId);
      tokenToMarket.delete(market.noTokenId);
      unsubscribeTokenIds([market.yesTokenId, market.noTokenId]);
      trackedMarketIds.delete(id);
    }
  }

  if (newTokenIds.length > 0) {
    if (!wsConnected) {
      connectWebSocket(newTokenIds, { onPriceUpdate: handlePriceUpdate, onMarketResolved: handleWsMarketResolved, onNewMarket: handleWsNewMarket });
      wsConnected = true;
    } else {
      subscribeTokenIds(newTokenIds);
    }
  }

  log.info("SCAN_TICK", { source: "heartbeat", totalKnown: knownMarkets.size, newlyAdded: newCount });

  for (const market of knownMarkets.values()) {
    evaluateAndFire(market, market.winSidePrice, "heartbeat");
  }
}

// ─── WebSocket callbacks ──────────────────────────────────────────────────────

function handlePriceUpdate(tokenId: string, price: TokenPrice): void {
  const marketId = tokenToMarket.get(tokenId);
  if (!marketId) return;
  const market = knownMarkets.get(marketId);
  if (!market) return;

  const otherTokenId = tokenId === market.yesTokenId ? market.noTokenId : market.yesTokenId;
  const otherPrice = getTokenPrice(otherTokenId);
  const otherAsk = otherPrice?.bestAsk ?? 0;
  const thisAsk = price.bestAsk;

  let winSide: "YES" | "NO";
  let winSidePrice: number;
  let tokenIdToBuy: string;

  if (thisAsk >= otherAsk) {
    winSide = tokenId === market.yesTokenId ? "YES" : "NO";
    winSidePrice = thisAsk;
    tokenIdToBuy = tokenId;
  } else {
    winSide = tokenId === market.yesTokenId ? "NO" : "YES";
    winSidePrice = otherAsk;
    tokenIdToBuy = otherTokenId;
  }

  const updatedMarket: Market = {
    ...market,
    winSide,
    winSidePrice: round4(winSidePrice),
    tokenIdToBuy,
    tickSize: price.tickSize,
    timeRemainingSeconds: Math.max(0, Math.floor((new Date(market.closesAt).getTime() - Date.now()) / 1000)),
  };

  knownMarkets.set(marketId, updatedMarket);
  evaluateAndFire(updatedMarket, winSidePrice, "websocket");
}

function handleWsMarketResolved(event: ResolvedMarketEvent): void {
  if (!onMarketResolvedCb) return;
  log.info("INFO", { message: "WS market_resolved", marketId: event.marketId, winningOutcome: event.winningOutcome });
  onMarketResolvedCb(event.marketId, event.winningTokenId, event.winningOutcome);
  const market = knownMarkets.get(event.marketId);
  if (market) {
    knownMarkets.delete(event.marketId);
    tokenToMarket.delete(market.yesTokenId);
    tokenToMarket.delete(market.noTokenId);
    unsubscribeTokenIds([market.yesTokenId, market.noTokenId]);
  }
  trackedMarketIds.delete(event.marketId);
}

async function handleWsNewMarket(event: NewMarketEvent): Promise<void> {
  log.info("INFO", { message: "WS new_market — refreshing", marketId: event.marketId });
  if (event.assetIds.length >= 2) {
    subscribeTokenIds(event.assetIds);
    for (const id of event.assetIds) tokenToMarket.set(id, event.marketId);
  }
  await refreshKnownMarkets();
}

// ─── qualifying logic ─────────────────────────────────────────────────────────

/**
 * Evaluate a market against all enabled rules.
 * Returns the first matching rule, or null if none qualify.
 *
 * Rule priority: 5m → 15m → fallback
 */
function getMatchingRule(market: Market, price: number): BetRule | null {
  const t = market.timeRemainingSeconds;
  if (t <= 0) return null;

  // 5m rule
  if (market.duration === "5m" && CONFIG.enable5m) {
    if (
      t <= CONFIG.maxTimeRemaining5m &&
      price >= CONFIG.priceRangeMin5m &&
      price <= CONFIG.priceRangeMax5m
    ) return "5m";
  }

  // 15m rule
  if (market.duration === "15m" && CONFIG.enable15m) {
    if (
      t <= CONFIG.maxTimeRemaining15m &&
      price >= CONFIG.priceRangeMin15m &&
      price <= CONFIG.priceRangeMax15m
    ) return "15m";
  }

  // fallback rule — per-duration time threshold
  if (CONFIG.enableFallback) {
    const fallbackThreshold = market.duration === "15m"
      ? CONFIG.fallbackTimeRemaining15m
      : CONFIG.fallbackTimeRemaining5m;
    if (t <= fallbackThreshold && price >= CONFIG.fallbackMinPrice && price <= CONFIG.fallbackMaxPrice) {
      return "fallback";
    }
  }

  return null;
}

function evaluateAndFire(market: Market, price: number, source: string): void {
  if (isPaused) return;
  if (trackedMarketIds.has(market.id)) return;

  const rule = getMatchingRule(market, price);
  if (!rule) return;

  log.info("MARKET_FOUND", {
    source,
    marketId: market.id,
    question: market.question,
    asset: market.asset,
    duration: market.duration,
    winSide: market.winSide,
    winSidePrice: market.winSidePrice,
    timeRemainingSeconds: market.timeRemainingSeconds,
    rule,
  });

  onMarketFoundCb?.(market, rule);
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function round4(n: number): number { return Math.round(n * 10000) / 10000; }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
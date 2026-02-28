/**
 * scanner.ts
 *
 * WebSocket-driven market scanner.
 *
 * Flow:
 *   1. Fetch markets via deterministic slug approach (polymarket.ts).
 *   2. Once we have token IDs, open the WebSocket and subscribe.
 *   3. If no markets found on first fetch, retry every SCAN_INTERVAL_MS until
 *      at least one is found, then open the WebSocket.
 *   4. Heartbeat HTTP fetch every ~60s re-checks for new intervals.
 *   5. Price updates from WS trigger re-evaluation of qualifying rules.
 *   6. market_resolved WS events settle bets immediately.
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
import type { Market } from "./types.js";

// ─── types ───────────────────────────────────────────────────────────────────

type MarketCallback = (market: Market) => void;
type ResolutionCallback = (marketId: string, winningTokenId: string, winningOutcome: string) => void;

// ─── module state ─────────────────────────────────────────────────────────────

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

  // Initial fetch — retry until we find at least one market
  await fetchWithRetry();

  // Heartbeat: re-fetch every scanIntervalMs to catch new intervals
  // 5-min markets appear every 5 minutes, so we need to check often
  heartbeatHandle = setInterval(async () => {
    if (!isPaused) await refreshKnownMarkets();
  }, CONFIG.scanIntervalMs);

  log.info("INFO", {
    message: "Scanner started (WebSocket + slug-based detection).",
    knownMarketCount: knownMarkets.size,
    heartbeatIntervalMs: CONFIG.scanIntervalMs,
  });
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
  if (heartbeatHandle) {
    clearInterval(heartbeatHandle);
    heartbeatHandle = null;
  }
  disconnectWebSocket();
  isRunning = false;
}

export function isPausedState(): boolean {
  return isPaused;
}

export function trackMarket(marketId: string): void {
  trackedMarketIds.add(marketId);
}

export function untrackMarket(marketId: string): void {
  trackedMarketIds.delete(marketId);
}

// ─── initial fetch with retry ─────────────────────────────────────────────────

/**
 * Keep retrying fetchCryptoMarkets every SCAN_INTERVAL_MS until we find markets.
 * This handles the case where the bot starts just as an interval begins and
 * the new market isn't indexed yet.
 */
async function fetchWithRetry(): Promise<void> {
  let attempts = 0;

  while (true) {
    attempts++;
    await refreshKnownMarkets();

    if (knownMarkets.size > 0) {
      log.info("INFO", {
        message: `Found ${knownMarkets.size} market(s) on attempt ${attempts}.`,
      });
      break;
    }

    log.warn("WARN", {
      message: `No markets found yet (attempt ${attempts}). Retrying in ${CONFIG.scanIntervalMs}ms...`,
      note: "Markets appear at the start of each 5/15-minute interval.",
    });

    await sleep(CONFIG.scanIntervalMs);
  }
}

// ─── market refresh ───────────────────────────────────────────────────────────

async function refreshKnownMarkets(): Promise<void> {
  let markets: Market[];
  try {
    markets = await fetchCryptoMarkets();
  } catch (err) {
    log.error("SCAN_ERROR", {
      message: "Market fetch failed",
      error: (err as Error).message,
    });
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
      // Refresh metadata and latest prices from HTTP snapshot
      knownMarkets.set(market.id, market);
    }
  }

  // Prune expired markets (closed > 30s ago)
  for (const [id, market] of knownMarkets) {
    const endMs = new Date(market.closesAt).getTime();
    if (endMs < now - 30_000) {
      knownMarkets.delete(id);
      tokenToMarket.delete(market.yesTokenId);
      tokenToMarket.delete(market.noTokenId);
      unsubscribeTokenIds([market.yesTokenId, market.noTokenId]);
      trackedMarketIds.delete(id);
    }
  }

  // Connect WebSocket on first successful fetch with tokens, or subscribe new tokens
  if (newTokenIds.length > 0) {
    if (!wsConnected) {
      const wsCallbacks: WsCallbacks = {
        onPriceUpdate: handlePriceUpdate,
        onMarketResolved: handleWsMarketResolved,
        onNewMarket: handleWsNewMarket,
      };
      connectWebSocket(newTokenIds, wsCallbacks);
      wsConnected = true;
    } else {
      subscribeTokenIds(newTokenIds);
    }
  }

  log.info("SCAN_TICK", {
    source: "heartbeat",
    totalKnown: knownMarkets.size,
    newlyAdded: newCount,
  });

  // Re-evaluate all known markets with their latest HTTP prices
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

  // Determine which side this token represents and recalculate win side
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
    timeRemainingSeconds: Math.max(
      0,
      Math.floor((new Date(market.closesAt).getTime() - Date.now()) / 1000)
    ),
  };

  knownMarkets.set(marketId, updatedMarket);
  evaluateAndFire(updatedMarket, winSidePrice, "websocket");
}

function handleWsMarketResolved(event: ResolvedMarketEvent): void {
  if (!onMarketResolvedCb) return;

  log.info("INFO", {
    message: "WebSocket market_resolved — forwarding to trader.",
    marketId: event.marketId,
    winningOutcome: event.winningOutcome,
    winningTokenId: event.winningTokenId,
  });

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
  log.info("INFO", {
    message: "WebSocket new_market event — triggering refresh.",
    marketId: event.marketId,
    question: event.question,
  });

  if (event.assetIds.length >= 2) {
    subscribeTokenIds(event.assetIds);
    for (const id of event.assetIds) {
      tokenToMarket.set(id, event.marketId);
    }
  }

  await refreshKnownMarkets();
}

// ─── qualifying logic ─────────────────────────────────────────────────────────

function evaluateAndFire(market: Market, winSidePrice: number, source: string): void {
  if (isPaused) return;
  if (trackedMarketIds.has(market.id)) return;
  if (market.timeRemainingSeconds <= 0) return;

  const primary = winSidePrice >= CONFIG.priceRangeMin && winSidePrice <= CONFIG.priceRangeMax;
  const fallback =
    market.timeRemainingSeconds <= CONFIG.fallbackTimeRemainingS &&
    winSidePrice <= CONFIG.fallbackMaxPrice;

  if (primary || fallback) {
    log.info("MARKET_FOUND", {
      source,
      marketId: market.id,
      question: market.question,
      asset: market.asset,
      duration: market.duration,
      winSide: market.winSide,
      winSidePrice: market.winSidePrice,
      timeRemainingSeconds: market.timeRemainingSeconds,
      closesAt: market.closesAt,
      rule: primary ? "primary" : "fallback",
    });

    onMarketFoundCb?.(market);
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
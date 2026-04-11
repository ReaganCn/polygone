/**
 * scanner.ts — WebSocket-driven market scanner with dump detection.
 *
 * Replaces the old qualifying-rule approach with:
 *   1. Rolling price history per token (priceHistory map)
 *   2. checkForDump() — detects sudden price drops
 *   3. Dual dispatch:
 *      - Tracked markets → onPriceUpdate callback (for fill monitor DCA/stop-loss)
 *      - Untracked markets → dump detection → onDumpDetected callback
 *   4. Four callbacks: onDumpDetected, onPriceUpdate, onMarketResolved, initialPaused
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
  type TokenPrice,
  type ResolvedMarketEvent,
  type NewMarketEvent,
} from "./websocket.js";
import type { Market, BetRule } from "./types.js";

// ─── callback types ───────────────────────────────────────────────────────────

type DumpCallback = (
  market: Market,
  dumpedSide: "YES" | "NO",
  dumpAsk: number,
  oppositeAsk: number,
  rule: BetRule,
) => void;

type PriceUpdateCallback = (
  marketId: string,
  yesPrice: number,
  noPrice: number,
) => void;

type ResolutionCallback = (
  marketId: string,
  winningTokenId: string,
  winningOutcome: string,
) => void;

// ─── state ────────────────────────────────────────────────────────────────────

interface PriceSnapshot {
  timestamp: number;
  ask: number;
}

const knownMarkets = new Map<string, Market>();
const tokenToMarket = new Map<string, string>();
const trackedMarketIds = new Set<string>();
const priceHistory = new Map<string, PriceSnapshot[]>();

let onDumpDetectedCb: DumpCallback | null = null;
let onPriceUpdateCb: PriceUpdateCallback | null = null;
let onMarketResolvedCb: ResolutionCallback | null = null;
let heartbeatHandle: ReturnType<typeof setInterval> | null = null;
let wsConnected = false;
let isPaused = false;
let isRunning = false;

// ─── public API ───────────────────────────────────────────────────────────────

export async function startScanner(
  onDumpDetected: DumpCallback,
  onPriceUpdate: PriceUpdateCallback,
  onMarketResolved: ResolutionCallback,
  initialPaused = false,
): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  isPaused = initialPaused;
  onDumpDetectedCb = onDumpDetected;
  onPriceUpdateCb = onPriceUpdate;
  onMarketResolvedCb = onMarketResolved;

  await fetchWithRetry();

  heartbeatHandle = setInterval(async () => {
    if (!isPaused) await refreshKnownMarkets();
  }, CONFIG.scanIntervalMs);

  log.info("INFO", {
    message: "Scanner started (dump-detect mode).",
    knownMarketCount: knownMarkets.size,
    heartbeatIntervalMs: CONFIG.scanIntervalMs,
    dump: {
      lookbackSeconds: CONFIG.dumpLookbackSeconds,
      thresholdPercent: CONFIG.dumpThresholdPercent,
      entryMinPrice: CONFIG.dumpEntryMinPrice,
      entryMaxPrice: CONFIG.dumpEntryMaxPrice,
    },
    rules: {
      "5m":  { enabled: CONFIG.enable5m,  maxTimeRemaining: CONFIG.maxTimeRemaining5m },
      "15m": { enabled: CONFIG.enable15m, maxTimeRemaining: CONFIG.maxTimeRemaining15m },
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

export function getKnownMarketPrice(marketId: string): { yesPrice: number; noPrice: number } | null {
  const market = knownMarkets.get(marketId);
  if (!market) return null;
  return { yesPrice: market.yesPrice, noPrice: market.noPrice };
}

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
  const newTokenIds: string[] = [];

  for (const market of markets) {
    if (!knownMarkets.has(market.id)) {
      knownMarkets.set(market.id, market);
      tokenToMarket.set(market.yesTokenId, market.id);
      tokenToMarket.set(market.noTokenId, market.id);
      newTokenIds.push(market.yesTokenId, market.noTokenId);
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
      priceHistory.delete(market.yesTokenId);
      priceHistory.delete(market.noTokenId);
    }
  }

  if (newTokenIds.length > 0) {
    if (!wsConnected) {
      connectWebSocket(newTokenIds, {
        onPriceUpdate: handleWsPriceUpdate,
        onMarketResolved: handleWsMarketResolved,
        onNewMarket: handleWsNewMarket,
      });
      wsConnected = true;
    } else {
      subscribeTokenIds(newTokenIds);
    }
  }

  log.info("SCAN_TICK", { source: "heartbeat", totalKnown: knownMarkets.size });
}

// ─── WebSocket callbacks ──────────────────────────────────────────────────────

function handleWsPriceUpdate(tokenId: string, price: TokenPrice): void {
  const marketId = tokenToMarket.get(tokenId);
  if (!marketId) return;
  const market = knownMarkets.get(marketId);
  if (!market) return;

  const now = Date.now();
  const currentAsk = price.bestAsk;

  // Record price history
  recordPrice(tokenId, now, currentAsk);

  // Update market prices
  const otherTokenId = tokenId === market.yesTokenId ? market.noTokenId : market.yesTokenId;
  const otherPrice = getTokenPrice(otherTokenId);
  const otherAsk = otherPrice?.bestAsk ?? (tokenId === market.yesTokenId ? market.noPrice : market.yesPrice);

  const yesPrice = tokenId === market.yesTokenId ? currentAsk : otherAsk;
  const noPrice = tokenId === market.noTokenId ? currentAsk : otherAsk;

  const updatedMarket: Market = {
    ...market,
    yesPrice: round4(yesPrice),
    noPrice: round4(noPrice),
    tickSize: price.tickSize,
    timeRemainingSeconds: Math.max(0, Math.floor((new Date(market.closesAt).getTime() - now) / 1000)),
  };

  knownMarkets.set(marketId, updatedMarket);

  // ── Dispatch ──────────────────────────────────────────────────────────────
  if (trackedMarketIds.has(marketId)) {
    // Tracked: forward price to trader for DCA / stop-loss monitoring
    onPriceUpdateCb?.(marketId, yesPrice, noPrice);
  } else if (!isPaused) {
    // Untracked: check for dump on this token
    checkForDumpAndFire(updatedMarket, tokenId, currentAsk);
  }
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
    priceHistory.delete(market.yesTokenId);
    priceHistory.delete(market.noTokenId);
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

// ─── dump detection ───────────────────────────────────────────────────────────

function recordPrice(tokenId: string, now: number, ask: number): void {
  let history = priceHistory.get(tokenId);
  if (!history) {
    history = [];
    priceHistory.set(tokenId, history);
  }
  history.push({ timestamp: now, ask });

  // Trim old entries (keep 2× lookback window for safety)
  const cutoff = now - CONFIG.dumpLookbackSeconds * 2000;
  while (history.length > 0 && history[0].timestamp < cutoff) {
    history.shift();
  }
}

function checkForDump(tokenId: string, currentAsk: number): boolean {
  const history = priceHistory.get(tokenId);
  if (!history || history.length < 2) return false;

  const now = Date.now();
  const cutoff = now - CONFIG.dumpLookbackSeconds * 1000;

  // Find the price closest to (but before) the lookback cutoff
  let oldPrice: number | null = null;
  for (const snap of history) {
    if (snap.timestamp <= cutoff) {
      oldPrice = snap.ask;
    } else {
      break;
    }
  }

  if (oldPrice === null || oldPrice <= 0) return false;

  const dropPercent = ((oldPrice - currentAsk) / oldPrice) * 100;
  return dropPercent >= CONFIG.dumpThresholdPercent;
}

function checkForDumpAndFire(market: Market, tokenId: string, currentAsk: number): void {
  // Entry guards
  if (currentAsk < CONFIG.dumpEntryMinPrice) return;
  if (currentAsk > CONFIG.dumpEntryMaxPrice) return;
  if (market.timeRemainingSeconds <= 0) return;

  // Determine BetRule from market duration
  const rule = getMatchingRule(market);
  if (!rule) return;

  // Check dump
  if (!checkForDump(tokenId, currentAsk)) return;

  const dumpedSide: "YES" | "NO" = tokenId === market.yesTokenId ? "YES" : "NO";
  const oppositeTokenId = dumpedSide === "YES" ? market.noTokenId : market.yesTokenId;
  const otherPrice = getTokenPrice(oppositeTokenId);
  const oppositeAsk = otherPrice?.bestAsk ?? (dumpedSide === "YES" ? market.noPrice : market.yesPrice);

  // No straddle edge if the prices sum to >= 1.0
  const priceSum = currentAsk + oppositeAsk;
  if (priceSum >= 1.0) return;

  // Track immediately to prevent duplicate fires
  trackedMarketIds.add(market.id);

  log.info("DUMP_DETECTED", {
    marketId: market.id, asset: market.asset, duration: market.duration,
    dumpedSide, dumpAsk: currentAsk, oppositeAsk,
    timeRemainingSeconds: market.timeRemainingSeconds, rule,
  });

  onDumpDetectedCb?.(market, dumpedSide, currentAsk, oppositeAsk, rule);
}

function getMatchingRule(market: Market): BetRule | null {
  const t = market.timeRemainingSeconds;
  if (t <= 0) return null;

  if (market.duration === "5m" && CONFIG.enable5m && t <= CONFIG.maxTimeRemaining5m) return "5m";
  if (market.duration === "15m" && CONFIG.enable15m && t <= CONFIG.maxTimeRemaining15m) return "15m";

  return null;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function round4(n: number): number { return Math.round(n * 10000) / 10000; }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

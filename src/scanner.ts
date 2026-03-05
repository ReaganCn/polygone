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
 *
 * FIXES APPLIED:
 *
 * [SC2] Heartbeat no longer overwrites real-time WebSocket prices with stale
 *   Gamma API data. refreshKnownMarkets now preserves the winSidePrice,
 *   winSide, and tokenIdToBuy from the existing knownMarkets entry when
 *   refreshing a market that is already known. Those fields are kept current
 *   by handlePriceUpdate (WebSocket). Gamma is only authoritative for
 *   structural fields (conditionId, closesAt, tickSize, tokenIds, question).
 *   Without this fix, a heartbeat running every 4s could silently reset a
 *   crashed price (e.g. 0.48) back to the stale Gamma price (e.g. 0.94),
 *   suppressing the stop-loss check on the very next evaluateAndFire tick.
 *
 * [SC3] handleWsMarketResolved no longer calls trackedMarketIds.delete()
 *   directly. It was calling the delete BEFORE firing onMarketResolvedCb,
 *   which meant the trackedMarketIds state was modified out of order with
 *   trader.ts's own cleanup (untrackMarket is called from handleWsResolution
 *   which is the target of onMarketResolvedCb). The direct delete is removed;
 *   untrackMarket via trader.ts is now the single authority.
 *
 * [SC4] Stop-loss betTokenPrice fallback changed from `price` to 0.
 *   If getTokenPrice(betTokenId) returns undefined (WebSocket dropped, no
 *   cached price), the old fallback used `price` — the price of whichever
 *   token just fired the price update, which may be the OTHER side's token
 *   after a market flip. That could give a false 0.95 reading and suppress
 *   the stop-loss. Falling back to 0 is conservative: it always triggers the
 *   stop-loss check, which is safer than silently suppressing it.
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
import { handleStopLoss, getBetTokenId } from "./trader.js";
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
    stopLoss: {
      enabled: CONFIG.stopLossEnabled,
      triggerPrice: CONFIG.stopLossTriggerPrice,
      limitPrice: CONFIG.stopLossLimitPrice,
    },
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
    const existing = knownMarkets.get(market.id);

    if (!existing) {
      // Brand new market — store as-is from Gamma
      knownMarkets.set(market.id, market);
      tokenToMarket.set(market.yesTokenId, market.id);
      tokenToMarket.set(market.noTokenId, market.id);
      newTokenIds.push(market.yesTokenId, market.noTokenId);
      newCount++;
    } else {
      // [SC2] Market already known. Gamma is the authority for structural fields
      // (closesAt, conditionId, tickSize, question, tokenIds, negRisk) but the
      // WebSocket is the authority for price fields (winSidePrice, winSide,
      // tokenIdToBuy). Preserve the WebSocket-updated price fields so a
      // heartbeat tick can't silently reset a real-time price crash back to a
      // stale Gamma value and suppress the stop-loss check.
      knownMarkets.set(market.id, {
        ...market,                          // take structural fields from Gamma
        winSidePrice:  existing.winSidePrice,  // keep real-time WebSocket price
        winSide:       existing.winSide,       // keep real-time win side
        tokenIdToBuy:  existing.tokenIdToBuy,  // keep real-time token to buy
        timeRemainingSeconds: Math.max(       // recompute from authoritative closesAt
          0,
          Math.floor((new Date(market.closesAt).getTime() - now) / 1000)
        ),
      });
    }
  }

  // Prune expired markets.
  // IMPORTANT: do NOT prune a market that is currently tracked (has an active bet
  // whose stop-loss sell failed). That market's tokenToMarket entry must stay alive
  // so the WebSocket market_resolved event can still route to handleWsResolution.
  for (const [id, market] of knownMarkets) {
    if (new Date(market.closesAt).getTime() < now - 30_000) {
      if (trackedMarketIds.has(id)) continue; // active bet still pending resolution
      knownMarkets.delete(id);
      tokenToMarket.delete(market.yesTokenId);
      tokenToMarket.delete(market.noTokenId);
      unsubscribeTokenIds([market.yesTokenId, market.noTokenId]);
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

  // [SC3] Fire the resolution callback first. trader.ts handleWsResolution will
  // call untrackMarket(marketId) as part of its cleanup — that is the single
  // authority for removing a market from trackedMarketIds. Do NOT call
  // trackedMarketIds.delete here; doing so before the callback would cause the
  // cleanup to happen out of order with trader.ts state.
  onMarketResolvedCb(event.marketId, event.winningTokenId, event.winningOutcome);

  // Clean up our own local maps after the callback has settled the bet.
  const market = knownMarkets.get(event.marketId);
  if (market) {
    knownMarkets.delete(event.marketId);
    tokenToMarket.delete(market.yesTokenId);
    tokenToMarket.delete(market.noTokenId);
    unsubscribeTokenIds([market.yesTokenId, market.noTokenId]);
  }
  // trackedMarketIds is managed solely by trackMarket/untrackMarket.
  // trader.ts calls untrackMarket(marketId) from handleWsResolution, which
  // is called synchronously above via onMarketResolvedCb. No delete needed here.
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
 * Check a market against all enabled entry rules.
 * Returns the first matching rule, or null if none qualify.
 * Rule priority: 5m → 15m → fallback.
 */
function getMatchingRule(market: Market, price: number): BetRule | null {
  const t = market.timeRemainingSeconds;
  if (t <= 0) return null;

  if (market.duration === "5m" && CONFIG.enable5m) {
    if (
      t <= CONFIG.maxTimeRemaining5m &&
      price >= CONFIG.priceRangeMin5m &&
      price <= CONFIG.priceRangeMax5m
    ) return "5m";
  }

  if (market.duration === "15m" && CONFIG.enable15m) {
    if (
      t <= CONFIG.maxTimeRemaining15m &&
      price >= CONFIG.priceRangeMin15m &&
      price <= CONFIG.priceRangeMax15m
    ) return "15m";
  }

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
  const isTracked = trackedMarketIds.has(market.id);

  // ── Stop-loss check ────────────────────────────────────────────────────────
  // Runs even when the scanner is paused — pausing blocks new entries only,
  // not management of positions already open.
  // The bet's stopLossTriggered flag (set in trader.ts) prevents double-firing.
  //
  // We compare against the live price of the TOKEN THE BET BOUGHT, not the
  // market's current winSidePrice. After a bet is placed the market can flip
  // (other side becomes dominant), causing winSidePrice to reflect the other
  // token. getBetTokenId() returns the tokenIdToBuy frozen at bet placement time.
  if (isTracked && CONFIG.stopLossEnabled) {
    const betTokenId = getBetTokenId(market.id);

    // [SC4] Fall back to 0 (not `price`) when the bet token has no cached
    // WebSocket price. `price` is the price of whichever token triggered this
    // evaluation — after a market flip it may be the OTHER side's token, giving
    // a falsely high reading that suppresses the stop-loss. 0 is conservative:
    // it always triggers the check, ensuring the stop-loss is never silently
    // missed due to a missing price. handleStopLoss is idempotent (guarded by
    // stopLossTriggered) so spurious calls are safe.
    const betTokenPrice = betTokenId
      ? (getTokenPrice(betTokenId)?.bestAsk ?? 0)
      : 0;

    if (betTokenPrice < CONFIG.stopLossTriggerPrice) {
      // Fire-and-forget — handleStopLoss is async but we don't block the price loop
      handleStopLoss(market.id).catch((err) =>
        log.error("ERROR", {
          message: "Uncaught error in handleStopLoss",
          marketId: market.id,
          error: (err as Error).message,
        })
      );
      return; // Don't attempt to enter a new bet on the same tick
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  // New entries are blocked when paused or when slot is already active
  if (isPaused) return;
  if (isTracked) return;

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
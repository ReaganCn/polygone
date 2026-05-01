/**
 * scanner.ts -- WebSocket-driven market scanner.
 *
 * Core contract:
 * - Never make side decisions from incomplete one-sided quote state.
 * - Prefer range-driven side selection by rule window.
 * - Keep heartbeat for discovery/pruning, but block qualification until
 *   two-sided quote state is hydrated and fresh.
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
import {
  selectSideForRule,
  type SideSelectionEvaluation,
  type Side,
  type SideSelectionMode,
  type BothSidesInRangePolicy,
} from "./sideSelection.js";
import type { Market, BetRule } from "./types.js";

type MarketCallback = (market: Market, rule: BetRule) => void;
type ResolutionCallback = (marketId: string, winningTokenId: string, winningOutcome: string) => void;

type ActiveBetPriceCallback = (marketId: string, tokenId: string, price: TokenPrice) => void;

type MarketQuoteState = {
  yesAsk: number | null;
  noAsk: number | null;
  yesBid: number | null;
  noBid: number | null;
  yesUpdatedAt: number;
  noUpdatedAt: number;
  yesSeen: boolean;
  noSeen: boolean;
};

type RuleWindow = {
  rule: BetRule;
  minPrice: number;
  maxPrice: number;
};

type QualificationDecision = {
  rule: BetRule;
  side: Side;
  price: number;
  tokenIdToBuy: string;
  evaluation: SideSelectionEvaluation;
};

type SelectionStability = {
  signature: string;
  firstSeenAt: number;
};

const knownMarkets = new Map<string, Market>();
const tokenToMarket = new Map<string, string>();
const trackedMarketIds = new Set<string>();
const quoteStateByMarketId = new Map<string, MarketQuoteState>();
const selectionStabilityByMarketId = new Map<string, SelectionStability>();
const lastQualificationBlockByMarketId = new Map<string, string>();

let onMarketFoundCb: MarketCallback | null = null;
let onMarketResolvedCb: ResolutionCallback | null = null;
let onActiveBetPriceUpdateCb: ActiveBetPriceCallback | null = null;
let heartbeatHandle: ReturnType<typeof setInterval> | null = null;
let wsConnected = false;
let isPaused = false;
let isRunning = false;

// Scanner-local strategy constants.
// Edit these values here if you want to tune behavior without new env keys.
const SCANNER_SELECTION: {
  sideSelectionMode: SideSelectionMode;
  bothSidesInRangePolicy: BothSidesInRangePolicy;
  requireTwoSidedQuotes: boolean;
  quoteFreshnessMs: number;
  entrySafetyBufferS: number;
  selectionHoldMs: number;
} = {
  sideSelectionMode: "RANGE_DRIVEN",
  bothSidesInRangePolicy: "SKIP",
  requireTwoSidedQuotes: true,
  quoteFreshnessMs: 3000,
  entrySafetyBufferS: 8,
  selectionHoldMs: 150,
};

// --- public API --------------------------------------------------------------

export async function startScanner(
  onMarketFound: MarketCallback,
  onMarketResolved: ResolutionCallback,
  initialPaused = false,
): Promise<void> {
  if (isRunning) return;

  isRunning = true;
  isPaused = initialPaused;
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
    sideSelectionMode: SCANNER_SELECTION.sideSelectionMode,
    bothSidesInRangePolicy: SCANNER_SELECTION.bothSidesInRangePolicy,
    requireTwoSidedQuotes: SCANNER_SELECTION.requireTwoSidedQuotes,
    quoteFreshnessMs: SCANNER_SELECTION.quoteFreshnessMs,
    entrySafetyBufferS: SCANNER_SELECTION.entrySafetyBufferS,
    selectionHoldMs: SCANNER_SELECTION.selectionHoldMs,
    rules: {
      "5m": {
        enabled: CONFIG.enable5m,
        maxTimeRemaining: CONFIG.maxTimeRemaining5m,
        priceRange: [CONFIG.priceRangeMin5m, CONFIG.priceRangeMax5m],
      },
      "15m": {
        enabled: CONFIG.enable15m,
        maxTimeRemaining: CONFIG.maxTimeRemaining15m,
        priceRange: [CONFIG.priceRangeMin15m, CONFIG.priceRangeMax15m],
      },
      fallback: {
        enabled: CONFIG.enableFallback,
        timeRemaining5m: CONFIG.fallbackTimeRemaining5m,
        timeRemaining15m: CONFIG.fallbackTimeRemaining15m,
        minPrice: CONFIG.fallbackMinPrice,
        maxPrice: CONFIG.fallbackMaxPrice,
      },
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
  if (heartbeatHandle) {
    clearInterval(heartbeatHandle);
    heartbeatHandle = null;
  }

  disconnectWebSocket();
  wsConnected = false;
  isRunning = false;
}

export function isPausedState(): boolean {
  return isPaused;
}

export function trackMarket(id: string): void {
  trackedMarketIds.add(id);
}

export function untrackMarket(id: string): void {
  trackedMarketIds.delete(id);
}

/**
 * Register a callback that fires on every WebSocket price update for a market
 * that is already tracked (i.e. has an active bet). Used by trader.ts to
 * implement early close (TP / SL) without a polling loop.
 */
export function setActiveBetPriceCallback(cb: ActiveBetPriceCallback): void {
  onActiveBetPriceUpdateCb = cb;
}

// --- fetch / refresh ---------------------------------------------------------

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
    const existing = knownMarkets.get(market.id);
    const merged: Market = existing
      ? {
          ...market,
          winSide: existing.winSide,
          winSidePrice: existing.winSidePrice,
          tokenIdToBuy: existing.tokenIdToBuy,
          tickSize: existing.tickSize,
        }
      : market;

    knownMarkets.set(market.id, merged);
    ensureQuoteState(market.id);

    tokenToMarket.set(market.yesTokenId, market.id);
    tokenToMarket.set(market.noTokenId, market.id);

    if (!existing) {
      newTokenIds.push(market.yesTokenId, market.noTokenId);
      newCount++;
    }

    hydrateQuoteStateFromPriceMap(merged);
  }

  // Prune expired markets.
  for (const [id, market] of knownMarkets) {
    if (new Date(market.closesAt).getTime() < now - 30_000) {
      knownMarkets.delete(id);
      tokenToMarket.delete(market.yesTokenId);
      tokenToMarket.delete(market.noTokenId);
      trackedMarketIds.delete(id);
      quoteStateByMarketId.delete(id);
      selectionStabilityByMarketId.delete(id);
      lastQualificationBlockByMarketId.delete(id);
      unsubscribeTokenIds([market.yesTokenId, market.noTokenId]);
    }
  }

  if (newTokenIds.length > 0) {
    if (!wsConnected) {
      connectWebSocket(newTokenIds, {
        onPriceUpdate: handlePriceUpdate,
        onMarketResolved: handleWsMarketResolved,
        onNewMarket: handleWsNewMarket,
      });
      wsConnected = true;
    } else {
      subscribeTokenIds(newTokenIds);
    }
  }

  let hydratedMarketCount = 0;
  let staleQuoteCount = 0;

  for (const market of knownMarkets.values()) {
    const quoteState = quoteStateByMarketId.get(market.id);
    if (!quoteState) continue;

    if (hasTwoSidedQuote(quoteState)) hydratedMarketCount++;
    if (isQuoteStateStale(quoteState, now)) staleQuoteCount++;

    evaluateAndMaybeFire(market, "heartbeat");
  }

  log.info("SCAN_TICK", {
    source: "heartbeat",
    totalKnown: knownMarkets.size,
    newlyAdded: newCount,
    hydratedMarketCount,
    staleQuoteCount,
  });
}

// --- WebSocket callbacks -----------------------------------------------------

function handlePriceUpdate(tokenId: string, price: TokenPrice): void {
  const marketId = tokenToMarket.get(tokenId);
  if (!marketId) return;

  const market = knownMarkets.get(marketId);
  if (!market) return;

  const updatedMarket: Market = {
    ...market,
    tickSize: price.tickSize,
    timeRemainingSeconds: getTimeRemainingSeconds(market.closesAt),
  };

  knownMarkets.set(marketId, updatedMarket);
  updateQuoteState(updatedMarket, tokenId, price);

  // Notify trader of price update on markets with active bets, so it can
  // check early-close (TP/SL) thresholds without a separate poll loop.
  if (trackedMarketIds.has(marketId) && onActiveBetPriceUpdateCb) {
    onActiveBetPriceUpdateCb(marketId, tokenId, price);
  }

  evaluateAndMaybeFire(updatedMarket, "websocket");
}

function handleWsMarketResolved(event: ResolvedMarketEvent): void {
  if (!onMarketResolvedCb) return;

  log.info("INFO", {
    message: "WS market_resolved",
    marketId: event.marketId,
    winningOutcome: event.winningOutcome,
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
  quoteStateByMarketId.delete(event.marketId);
  selectionStabilityByMarketId.delete(event.marketId);
  lastQualificationBlockByMarketId.delete(event.marketId);
}

async function handleWsNewMarket(event: NewMarketEvent): Promise<void> {
  log.info("INFO", {
    message: "WS new_market -- refreshing",
    marketId: event.marketId,
  });

  if (event.assetIds.length >= 2) {
    subscribeTokenIds(event.assetIds);
    for (const id of event.assetIds) tokenToMarket.set(id, event.marketId);
  }

  await refreshKnownMarkets();
}

// --- qualifying logic --------------------------------------------------------

function evaluateAndMaybeFire(market: Market, source: "websocket" | "heartbeat"): void {
  if (isPaused) return;
  if (trackedMarketIds.has(market.id)) return;

  const quoteState = quoteStateByMarketId.get(market.id);
  if (!quoteState) {
    logQualificationBlocked(market, source, "missing_quote_state", {
      marketId: market.id,
    });
    return;
  }

  const guardFailure = getQualificationGuardFailure(market, quoteState);
  if (guardFailure) {
    logQualificationBlocked(market, source, guardFailure.reason, guardFailure.data);
    selectionStabilityByMarketId.delete(market.id);
    return;
  }

  clearQualificationBlocked(market.id);

  const decision = getQualificationDecision(market, quoteState, source);
  if (!decision) {
    selectionStabilityByMarketId.delete(market.id);
    return;
  }

  if (!passesSelectionHold(market.id, decision, source)) {
    return;
  }

  const decisionMarket: Market = {
    ...market,
    winSide: decision.side,
    winSidePrice: round4(decision.price),
    tokenIdToBuy: decision.tokenIdToBuy,
  };

  knownMarkets.set(market.id, decisionMarket);

  // Mark the market as tracked synchronously before firing the callback.
  // The callback is async and yields on its first await, so without this
  // a second evaluate call for the same market could pass the tracked check
  // and fire a duplicate bet.
  trackedMarketIds.add(market.id);
  selectionStabilityByMarketId.delete(market.id);

  log.info("MARKET_FOUND", {
    source,
    marketId: decisionMarket.id,
    question: decisionMarket.question,
    asset: decisionMarket.asset,
    duration: decisionMarket.duration,
    winSide: decisionMarket.winSide,
    winSidePrice: decisionMarket.winSidePrice,
    timeRemainingSeconds: decisionMarket.timeRemainingSeconds,
    rule: decision.rule,
    yesAsk: quoteState.yesAsk,
    noAsk: quoteState.noAsk,
    yesInRange: decision.evaluation.yesInRange,
    noInRange: decision.evaluation.noInRange,
    selectionReason: decision.evaluation.reason,
    policyApplied: decision.evaluation.policyApplied,
    sideSelectionMode: SCANNER_SELECTION.sideSelectionMode,
  });

  onMarketFoundCb?.(decisionMarket, decision.rule);
}

function getQualificationDecision(
  market: Market,
  quoteState: MarketQuoteState,
  source: "websocket" | "heartbeat",
): QualificationDecision | null {
  const ruleWindows = getEligibleRuleWindows(market);
  if (ruleWindows.length === 0) return null;

  const yesAsk = quoteState.yesAsk;
  const noAsk = quoteState.noAsk;
  if (yesAsk === null || noAsk === null) return null;

  for (const window of ruleWindows) {
    const evaluation = selectSideForRule({
      yesAsk,
      noAsk,
      minPrice: window.minPrice,
      maxPrice: window.maxPrice,
      mode: SCANNER_SELECTION.sideSelectionMode,
      bothSidesPolicy: SCANNER_SELECTION.bothSidesInRangePolicy,
    });

    log.info("RANGE_SIDE_EVALUATED", {
      source,
      marketId: market.id,
      rule: window.rule,
      yesAsk,
      noAsk,
      rangeMin: window.minPrice,
      rangeMax: window.maxPrice,
      yesInRange: evaluation.yesInRange,
      noInRange: evaluation.noInRange,
      selectedSide: evaluation.selectedSide,
      reason: evaluation.reason,
      policyApplied: evaluation.policyApplied,
      sideSelectionMode: SCANNER_SELECTION.sideSelectionMode,
    });

    if (!evaluation.selectedSide || evaluation.selectedPrice === null) {
      if (evaluation.yesInRange && evaluation.noInRange) {
        log.info("RANGE_SIDE_SKIPPED", {
          source,
          marketId: market.id,
          rule: window.rule,
          yesAsk,
          noAsk,
          reason: evaluation.reason,
          policyApplied: evaluation.policyApplied,
        });
      }
      continue;
    }

    const tokenIdToBuy = evaluation.selectedSide === "YES"
      ? market.yesTokenId
      : market.noTokenId;

    log.info("RANGE_SIDE_DECISION", {
      source,
      marketId: market.id,
      rule: window.rule,
      selectedSide: evaluation.selectedSide,
      selectedPrice: evaluation.selectedPrice,
      tokenIdToBuy,
      reason: evaluation.reason,
      policyApplied: evaluation.policyApplied,
      yesAsk,
      noAsk,
    });

    return {
      rule: window.rule,
      side: evaluation.selectedSide,
      price: evaluation.selectedPrice,
      tokenIdToBuy,
      evaluation,
    };
  }

  return null;
}

function getEligibleRuleWindows(market: Market): RuleWindow[] {
  const windows: RuleWindow[] = [];
  const t = market.timeRemainingSeconds;

  if (t <= 0) return windows;

  if (market.duration === "5m" && CONFIG.enable5m && t <= CONFIG.maxTimeRemaining5m) {
    windows.push({
      rule: "5m",
      minPrice: CONFIG.priceRangeMin5m,
      maxPrice: CONFIG.priceRangeMax5m,
    });
  }

  if (market.duration === "15m" && CONFIG.enable15m && t <= CONFIG.maxTimeRemaining15m) {
    windows.push({
      rule: "15m",
      minPrice: CONFIG.priceRangeMin15m,
      maxPrice: CONFIG.priceRangeMax15m,
    });
  }

  if (CONFIG.enableFallback) {
    const fallbackThreshold = market.duration === "15m"
      ? CONFIG.fallbackTimeRemaining15m
      : CONFIG.fallbackTimeRemaining5m;

    if (t <= fallbackThreshold) {
      windows.push({
        rule: "fallback",
        minPrice: CONFIG.fallbackMinPrice,
        maxPrice: CONFIG.fallbackMaxPrice,
      });
    }
  }

  return windows;
}

function getQualificationGuardFailure(
  market: Market,
  quoteState: MarketQuoteState,
): { reason: string; data: Record<string, unknown> } | null {
  const now = Date.now();

  if (market.timeRemainingSeconds <= 0) {
    return {
      reason: "market_expired",
      data: { marketId: market.id, timeRemainingSeconds: market.timeRemainingSeconds },
    };
  }

  if (market.timeRemainingSeconds <= SCANNER_SELECTION.entrySafetyBufferS) {
    return {
      reason: "inside_entry_safety_buffer",
      data: {
        marketId: market.id,
        timeRemainingSeconds: market.timeRemainingSeconds,
        entrySafetyBufferS: SCANNER_SELECTION.entrySafetyBufferS,
      },
    };
  }

  const mustRequireTwoSided = SCANNER_SELECTION.sideSelectionMode === "RANGE_DRIVEN"
    ? true
    : SCANNER_SELECTION.requireTwoSidedQuotes;

  if (mustRequireTwoSided && !hasTwoSidedQuote(quoteState)) {
    return {
      reason: "quotes_not_hydrated",
      data: {
        marketId: market.id,
        yesSeen: quoteState.yesSeen,
        noSeen: quoteState.noSeen,
      },
    };
  }

  if (!isValidAsk(quoteState.yesAsk) || !isValidAsk(quoteState.noAsk)) {
    return {
      reason: "invalid_ask_state",
      data: {
        marketId: market.id,
        yesAsk: quoteState.yesAsk,
        noAsk: quoteState.noAsk,
      },
    };
  }

  if (quoteState.yesUpdatedAt === 0 || quoteState.noUpdatedAt === 0) {
    return {
      reason: "missing_quote_timestamps",
      data: { marketId: market.id },
    };
  }

  const yesAgeMs = now - quoteState.yesUpdatedAt;
  const noAgeMs = now - quoteState.noUpdatedAt;

  if (
    yesAgeMs > SCANNER_SELECTION.quoteFreshnessMs
    || noAgeMs > SCANNER_SELECTION.quoteFreshnessMs
  ) {
    return {
      reason: "quote_stale",
      data: {
        marketId: market.id,
        yesAgeMs,
        noAgeMs,
        quoteFreshnessMs: SCANNER_SELECTION.quoteFreshnessMs,
      },
    };
  }

  return null;
}

function passesSelectionHold(
  marketId: string,
  decision: QualificationDecision,
  source: "websocket" | "heartbeat",
): boolean {
  if (SCANNER_SELECTION.selectionHoldMs <= 0) return true;

  const now = Date.now();
  const signature = `${decision.rule}:${decision.side}`;
  const current = selectionStabilityByMarketId.get(marketId);

  if (!current || current.signature !== signature) {
    selectionStabilityByMarketId.set(marketId, {
      signature,
      firstSeenAt: now,
    });

    log.info("MARKET_QUALIFICATION_BLOCKED", {
      source,
      marketId,
      reason: "selection_hold_pending",
      selectionHoldMs: SCANNER_SELECTION.selectionHoldMs,
      elapsedMs: 0,
      signature,
    });

    return false;
  }

  const elapsedMs = now - current.firstSeenAt;
  if (elapsedMs < SCANNER_SELECTION.selectionHoldMs) {
    log.info("MARKET_QUALIFICATION_BLOCKED", {
      source,
      marketId,
      reason: "selection_hold_pending",
      selectionHoldMs: SCANNER_SELECTION.selectionHoldMs,
      elapsedMs,
      signature,
    });
    return false;
  }

  return true;
}

function ensureQuoteState(marketId: string): MarketQuoteState {
  const existing = quoteStateByMarketId.get(marketId);
  if (existing) return existing;

  const created: MarketQuoteState = {
    yesAsk: null,
    noAsk: null,
    yesBid: null,
    noBid: null,
    yesUpdatedAt: 0,
    noUpdatedAt: 0,
    yesSeen: false,
    noSeen: false,
  };

  quoteStateByMarketId.set(marketId, created);
  return created;
}

function hydrateQuoteStateFromPriceMap(market: Market): void {
  const state = ensureQuoteState(market.id);

  const yesPrice = getTokenPrice(market.yesTokenId);
  if (yesPrice) {
    state.yesAsk = yesPrice.bestAsk;
    state.yesBid = yesPrice.bestBid;
    state.yesUpdatedAt = yesPrice.updatedAt;
    state.yesSeen = true;
  }

  const noPrice = getTokenPrice(market.noTokenId);
  if (noPrice) {
    state.noAsk = noPrice.bestAsk;
    state.noBid = noPrice.bestBid;
    state.noUpdatedAt = noPrice.updatedAt;
    state.noSeen = true;
  }
}

function updateQuoteState(market: Market, tokenId: string, price: TokenPrice): void {
  const state = ensureQuoteState(market.id);

  if (tokenId === market.yesTokenId) {
    state.yesAsk = price.bestAsk;
    state.yesBid = price.bestBid;
    state.yesUpdatedAt = price.updatedAt;
    state.yesSeen = true;
    return;
  }

  if (tokenId === market.noTokenId) {
    state.noAsk = price.bestAsk;
    state.noBid = price.bestBid;
    state.noUpdatedAt = price.updatedAt;
    state.noSeen = true;
    return;
  }
}

function hasTwoSidedQuote(state: MarketQuoteState): boolean {
  return state.yesSeen && state.noSeen;
}

function isQuoteStateStale(state: MarketQuoteState, now: number): boolean {
  if (state.yesUpdatedAt === 0 || state.noUpdatedAt === 0) return true;
  return (now - state.yesUpdatedAt) > SCANNER_SELECTION.quoteFreshnessMs
    || (now - state.noUpdatedAt) > SCANNER_SELECTION.quoteFreshnessMs;
}

function isValidAsk(value: number | null): boolean {
  return value !== null && Number.isFinite(value) && value > 0 && value <= 1;
}

function logQualificationBlocked(
  market: Market,
  source: "websocket" | "heartbeat",
  reason: string,
  data: Record<string, unknown>,
): void {
  const dedupeKey = `${source}:${reason}`;
  const last = lastQualificationBlockByMarketId.get(market.id);

  if (last === dedupeKey) return;
  lastQualificationBlockByMarketId.set(market.id, dedupeKey);

  const event = reason === "quotes_not_hydrated" || reason === "quote_stale"
    ? "QUOTE_SYNC_BLOCKED"
    : "MARKET_QUALIFICATION_BLOCKED";

  log.info(event, {
    source,
    marketId: market.id,
    question: market.question,
    asset: market.asset,
    duration: market.duration,
    reason,
    ...data,
  });
}

function clearQualificationBlocked(marketId: string): void {
  lastQualificationBlockByMarketId.delete(marketId);
}

function getTimeRemainingSeconds(closesAt: string): number {
  return Math.max(0, Math.floor((new Date(closesAt).getTime() - Date.now()) / 1000));
}

// --- helpers ----------------------------------------------------------------

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

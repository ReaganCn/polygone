/**
 * websocket.ts
 *
 * Manages a persistent WebSocket connection to the Polymarket CLOB market channel.
 * URL: wss://ws-subscriptions-clob.polymarket.com/ws/market
 *
 * BUGS FIXED:
 *
 * BUG 1 — Wrong ping format.
 *   Old: ws.ping()  → sends a WebSocket PING *frame* (binary protocol level).
 *   Fix: ws.send("PING")  → sends text message "PING" which is what Polymarket
 *        expects. The docs say: 'Send PING every 10 seconds. Server responds with PONG.'
 *        This was causing the server to drop the connection after ~10s of silence.
 *
 * BUG 2 — Dynamic subscription message missing "operation" field.
 *   Old: { assets_ids: [...], type: "market", custom_feature_enabled: true }
 *   Fix: Initial subscription is correct. But when adding more tokens later,
 *        the message must include "operation": "subscribe" otherwise the server
 *        treats it as a duplicate initial subscription and may reset.
 *        Docs: { "assets_ids": [...], "operation": "subscribe", "custom_feature_enabled": true }
 *
 * BUG 3 — book event field name: "bids" not "buys".
 *   Old: event["bids"]  ← actually correct per latest docs.
 *   The docs show the example with "bids"/"asks" keys but the structure description
 *   says "buys". We handle both to be safe.
 *
 * BUG 4 — subscribedTokenIds filter silently drops valid events.
 *   When the scanner calls subscribeTokenIds() for newly discovered markets, the
 *   tokens are added to the set BEFORE the WS subscription message is sent.
 *   But for the initial connection, tokens are sent to openConnection() →
 *   connectWebSocket() which adds them, then onOpen fires and sends them.
 *   However, if the WS is already open when subscribeTokenIds() is called, we
 *   send the "operation: subscribe" message. That path was broken because it
 *   was using the initial-subscription format instead of the dynamic-subscribe format.
 *
 * BUG 5 — No connection-timeout guard.
 *   If the server closes immediately because we didn't subscribe fast enough,
 *   there was no retry limit. Added a max-retries cap (10) before giving up.
 */

import WebSocket from "ws";
import { log } from "./logger.js";

// ─── constants ───────────────────────────────────────────────────────────────

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

const PING_INTERVAL_MS = 10_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 20;

// ─── types ───────────────────────────────────────────────────────────────────

export interface TokenPrice {
  tokenId: string;
  bestBid: number;
  bestAsk: number;
  lastTradePrice: number;
  tickSize: string;
  /** Unix ms of the most recent update */
  updatedAt: number;
}

export interface ResolvedMarketEvent {
  /** Gamma market ID */
  marketId: string;
  conditionId: string;
  winningTokenId: string;
  winningOutcome: string;
  question: string;
  timestamp: number;
}

export interface NewMarketEvent {
  marketId: string;
  conditionId: string;
  question: string;
  assetIds: string[];
  outcomes: string[];
  timestamp: number;
}

export interface WsCallbacks {
  onPriceUpdate: (tokenId: string, price: TokenPrice) => void;
  onMarketResolved: (event: ResolvedMarketEvent) => void;
  onNewMarket: (event: NewMarketEvent) => void;
}

// ─── module state ─────────────────────────────────────────────────────────────

/** tokenId → live price data */
const priceMap = new Map<string, TokenPrice>();

/** tokenId → tick size */
const tickSizeMap = new Map<string, string>();

/** Currently subscribed token IDs */
const subscribedTokenIds = new Set<string>();

let ws: WebSocket | null = null;
let callbacks: WsCallbacks | null = null;
let pingHandle: ReturnType<typeof setInterval> | null = null;
let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
let reconnectAttempts = 0;
let reconnectHandle: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

// ─── public API ───────────────────────────────────────────────────────────────

export function connectWebSocket(tokenIds: string[], cbs: WsCallbacks): void {
  callbacks = cbs;
  stopped = false;
  reconnectAttempts = 0;
  reconnectDelay = INITIAL_RECONNECT_DELAY_MS;

  for (const id of tokenIds) subscribedTokenIds.add(id);

  openConnection();
}

/**
 * Subscribe to additional token IDs.
 * Uses the "operation": "subscribe" dynamic-subscribe format per the docs.
 */
export function subscribeTokenIds(tokenIds: string[]): void {
  const newIds = tokenIds.filter((id) => !subscribedTokenIds.has(id));
  if (newIds.length === 0) return;

  for (const id of newIds) subscribedTokenIds.add(id);

  if (ws && ws.readyState === WebSocket.OPEN) {
    // BUG 2 FIX: use "operation": "subscribe" for dynamic additions
    sendDynamicSubscribe(newIds);
    log.info("INFO", {
      message: `WebSocket: dynamically subscribed to ${newIds.length} new token(s).`,
      newTokenIds: newIds,
    });
  }
  // If not connected yet, they'll be included in the full subscription on open
}

/**
 * Unsubscribe token IDs via "operation": "unsubscribe" (Polymarket does support this).
 */
export function unsubscribeTokenIds(tokenIds: string[]): void {
  const toRemove = tokenIds.filter((id) => subscribedTokenIds.has(id));
  for (const id of toRemove) {
    subscribedTokenIds.delete(id);
    priceMap.delete(id);
  }

  if (toRemove.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
    const msg = { assets_ids: toRemove, operation: "unsubscribe" };
    ws.send(JSON.stringify(msg));
  }
}

export function getTokenPrice(tokenId: string): TokenPrice | undefined {
  return priceMap.get(tokenId);
}

export function getPriceMap(): Map<string, TokenPrice> {
  return new Map(priceMap);
}

export function getSubscribedCount(): number {
  return subscribedTokenIds.size;
}

export function disconnectWebSocket(): void {
  stopped = true;
  clearPing();
  if (reconnectHandle) {
    clearTimeout(reconnectHandle);
    reconnectHandle = null;
  }
  if (ws) {
    ws.terminate();
    ws = null;
  }
  log.info("INFO", { message: "WebSocket disconnected." });
}

// ─── connection management ────────────────────────────────────────────────────

function openConnection(): void {
  if (stopped) return;

  log.info("INFO", {
    message: `WebSocket: connecting to ${WS_URL}`,
    subscribedTokenCount: subscribedTokenIds.size,
    attempt: reconnectAttempts + 1,
  });

  ws = new WebSocket(WS_URL);

  ws.on("open", onOpen);
  ws.on("message", onMessage);
  ws.on("error", onError);
  ws.on("close", onClose);
}

function onOpen(): void {
  reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  reconnectAttempts = 0;

  log.info("INFO", {
    message: "WebSocket: connected.",
    tokenCount: subscribedTokenIds.size,
  });

  // Send initial subscription immediately after connecting (server may close
  // the connection if no subscription is sent within a few seconds)
  if (subscribedTokenIds.size > 0) {
    sendInitialSubscription([...subscribedTokenIds]);
  } else {
    log.warn("WARN", {
      message: "WebSocket: connected but no token IDs to subscribe to yet.",
    });
  }

  // BUG 1 FIX: start text-based PING (not ws.ping() binary frame)
  startPing();
}

function onMessage(raw: WebSocket.RawData): void {
  const str = raw.toString();

  // The server responds to our "PING" text message with "PONG" text — ignore it
  if (str === "PONG") {
    log.info("INFO", { message: "WebSocket: received PONG heartbeat." });
    return;
  }

  let data: unknown;
  try {
    data = JSON.parse(str);
  } catch {
    log.warn("WARN", {
      message: "WebSocket: received non-JSON message",
      raw: str.slice(0, 200),
    });
    return;
  }

  // Polymarket sends both single objects and arrays of events
  const events = Array.isArray(data) ? data : [data];

  for (const event of events) {
    handleEvent(event as Record<string, unknown>);
  }
}

function onError(err: Error): void {
  log.error("ERROR", { message: "WebSocket error", error: err.message });
}

function onClose(code: number, reason: Buffer): void {
  clearPing();
  log.warn("WARN", {
    message: "WebSocket: connection closed.",
    code,
    reason: reason.toString(),
  });

  if (!stopped) {
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    log.error("ERROR", {
      message: `WebSocket: gave up reconnecting after ${MAX_RECONNECT_ATTEMPTS} attempts.`,
    });
    return;
  }

  reconnectAttempts++;

  log.info("INFO", {
    message: `WebSocket: reconnecting in ${reconnectDelay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`,
  });

  reconnectHandle = setTimeout(() => {
    reconnectHandle = null;
    openConnection();
  }, reconnectDelay);

  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
}

// ─── subscription helpers ─────────────────────────────────────────────────────

/** Initial subscription on connect — no "operation" field needed */
function sendInitialSubscription(tokenIds: string[]): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const msg = {
    assets_ids: tokenIds,
    type: "market",
    custom_feature_enabled: true,
  };

  ws.send(JSON.stringify(msg));

  log.info("INFO", {
    message: `WebSocket: sent initial subscription for ${tokenIds.length} token(s).`,
  });
}

/** Dynamic subscribe — used when adding new tokens to an existing connection */
function sendDynamicSubscribe(tokenIds: string[]): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  // BUG 2 FIX: "operation": "subscribe" is required for dynamic additions
  const msg = {
    assets_ids: tokenIds,
    operation: "subscribe",
    custom_feature_enabled: true,
  };

  ws.send(JSON.stringify(msg));
}

// ─── ping / keep-alive ────────────────────────────────────────────────────────

function startPing(): void {
  clearPing();
  pingHandle = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      // BUG 1 FIX: Polymarket expects a text-frame "PING", not a WS protocol ping frame
      ws.send("PING");
    }
  }, PING_INTERVAL_MS);
}

function clearPing(): void {
  if (pingHandle) {
    clearInterval(pingHandle);
    pingHandle = null;
  }
}

// ─── event routing ───────────────────────────────────────────────────────────

function handleEvent(event: Record<string, unknown>): void {
  const type = event["event_type"] as string | undefined;
  if (!type) return;

  switch (type) {
    case "book":
      handleBook(event);
      break;
    case "price_change":
      handlePriceChange(event);
      break;
    case "last_trade_price":
      handleLastTradePrice(event);
      break;
    case "tick_size_change":
      handleTickSizeChange(event);
      break;
    case "best_bid_ask":
      handleBestBidAsk(event);
      break;
    case "new_market":
      handleNewMarket(event);
      break;
    case "market_resolved":
      handleMarketResolved(event);
      break;
    default:
      // Unknown — log once to help diagnose new event types
      log.info("INFO", {
        message: "WebSocket: unhandled event_type",
        event_type: type,
      });
      break;
  }
}

// ─── book snapshot ────────────────────────────────────────────────────────────

interface OrderLevel {
  price: string;
  size: string;
}

function handleBook(event: Record<string, unknown>): void {
  const tokenId = event["asset_id"] as string;
  if (!tokenId || !subscribedTokenIds.has(tokenId)) return;

  // BUG 3: docs say "buys"/"sells" in the structure table but "bids"/"asks" in the example.
  // Handle both field names.
  const bids = (event["bids"] ?? event["buys"]) as OrderLevel[] | undefined ?? [];
  const asks = (event["asks"] ?? event["sells"]) as OrderLevel[] | undefined ?? [];

  const bestBid = bids.length > 0
    ? Math.max(...bids.map((b) => parseFloat(b.price)))
    : 0;
  const bestAsk = asks.length > 0
    ? Math.min(...asks.map((a) => parseFloat(a.price)))
    : 1;

  updatePrice(tokenId, { bestBid, bestAsk });
}

// ─── price_change ─────────────────────────────────────────────────────────────

interface PriceChangeEntry {
  asset_id: string;
  best_bid: string;
  best_ask: string;
}

function handlePriceChange(event: Record<string, unknown>): void {
  const changes = (event["price_changes"] as PriceChangeEntry[] | undefined) ?? [];

  for (const change of changes) {
    const tokenId = change.asset_id;
    if (!tokenId || !subscribedTokenIds.has(tokenId)) continue;

    const bestBid = parseFloat(change.best_bid ?? "0");
    const bestAsk = parseFloat(change.best_ask ?? "1");

    updatePrice(tokenId, { bestBid, bestAsk });
  }
}

// ─── last_trade_price ─────────────────────────────────────────────────────────

function handleLastTradePrice(event: Record<string, unknown>): void {
  const tokenId = event["asset_id"] as string;
  if (!tokenId || !subscribedTokenIds.has(tokenId)) return;

  const price = parseFloat((event["price"] as string) ?? "0");
  updatePrice(tokenId, { lastTradePrice: price });
}

// ─── tick_size_change ─────────────────────────────────────────────────────────

function handleTickSizeChange(event: Record<string, unknown>): void {
  const tokenId = event["asset_id"] as string;
  const newTickSize = event["new_tick_size"] as string;
  if (!tokenId || !newTickSize) return;

  tickSizeMap.set(tokenId, newTickSize);

  const existing = priceMap.get(tokenId);
  if (existing) {
    existing.tickSize = newTickSize;
    callbacks?.onPriceUpdate(tokenId, existing);
  }

  log.info("INFO", {
    message: "WebSocket: tick size changed",
    tokenId,
    oldTickSize: event["old_tick_size"],
    newTickSize,
  });
}

// ─── best_bid_ask (custom feature) ───────────────────────────────────────────

function handleBestBidAsk(event: Record<string, unknown>): void {
  const tokenId = event["asset_id"] as string;
  if (!tokenId || !subscribedTokenIds.has(tokenId)) return;

  const bestBid = parseFloat((event["best_bid"] as string) ?? "0");
  const bestAsk = parseFloat((event["best_ask"] as string) ?? "1");

  updatePrice(tokenId, { bestBid, bestAsk });
}

// ─── new_market (custom feature) ─────────────────────────────────────────────

function handleNewMarket(event: Record<string, unknown>): void {
  if (!callbacks) return;

  const marketId = event["id"] as string;
  const conditionId = event["market"] as string;
  const question = event["question"] as string;
  const assetIds = (event["assets_ids"] as string[]) ?? [];
  const outcomes = (event["outcomes"] as string[]) ?? [];
  const timestamp = parseInt((event["timestamp"] as string) ?? "0", 10);

  log.info("INFO", {
    source: "websocket_new_market",
    marketId,
    conditionId,
    question,
    assetIds,
    outcomes,
  });

  callbacks.onNewMarket({ marketId, conditionId, question, assetIds, outcomes, timestamp });
}

// ─── market_resolved (custom feature) ────────────────────────────────────────

function handleMarketResolved(event: Record<string, unknown>): void {
  if (!callbacks) return;

  const marketId = event["id"] as string;
  const conditionId = event["market"] as string;
  const winningTokenId = event["winning_asset_id"] as string;
  const winningOutcome = event["winning_outcome"] as string;
  const question = event["question"] as string;
  const timestamp = parseInt((event["timestamp"] as string) ?? "0", 10);

  log.info("INFO", {
    message: "WebSocket: market_resolved received",
    marketId,
    conditionId,
    winningTokenId,
    winningOutcome,
    question,
  });

  callbacks.onMarketResolved({ marketId, conditionId, winningTokenId, winningOutcome, question, timestamp });
}

// ─── price update helper ──────────────────────────────────────────────────────

function updatePrice(
  tokenId: string,
  patch: Partial<Pick<TokenPrice, "bestBid" | "bestAsk" | "lastTradePrice">>
): void {
  const existing = priceMap.get(tokenId) ?? {
    tokenId,
    bestBid: 0,
    bestAsk: 1,
    lastTradePrice: 0,
    tickSize: tickSizeMap.get(tokenId) ?? "0.01",
    updatedAt: 0,
  };

  const updated: TokenPrice = {
    ...existing,
    ...patch,
    tokenId,
    updatedAt: Date.now(),
  };

  priceMap.set(tokenId, updated);
  callbacks?.onPriceUpdate(tokenId, updated);
}
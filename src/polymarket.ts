/**
 * polymarket.ts
 *
 * Polymarket API client.
 *
 * Market discovery uses the deterministic slug approach:
 *   {asset}-updown-{duration}-{intervalStartUnixSeconds}
 *   e.g. btc-updown-5m-1772295900
 *
 * Confirmed from real API response:
 * - /events?slug=... returns the event with nested markets array
 * - Nested markets in /events do NOT always include clobTokenIds
 * - When clobTokenIds is missing, fetch /markets?id=... for the full detail
 * - closed:true markets must be skipped (outcomePrices show 0/1, no orderbook)
 */

import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import { CONFIG } from "./config.js";
import { log } from "./logger.js";
import type { Market, OrderResult, MarketResolution } from "./types.js";

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_HOST = "https://clob.polymarket.com";
const POLYGON_CHAIN_ID = 137;

const ASSET_SLUG_MAP: Record<string, string> = {
  BTC: "btc", ETH: "eth", SOL: "sol",
  MATIC: "matic", DOGE: "doge", XRP: "xrp",
};

const DURATION_SLUG_MAP: Record<string, string> = {
  "5m": "5m", "15m": "15m",
  "5-minute": "5m", "15-minute": "15m",
};

const DURATION_SECONDS_MAP: Record<string, number> = {
  "5m": 300, "15m": 900,
  "5-minute": 300, "15-minute": 900,
};

// ─── module state ─────────────────────────────────────────────────────────────

let clobClient: ClobClient | null = null;

// ─── init ─────────────────────────────────────────────────────────────────────

export async function initialiseClobClient(): Promise<void> {
  const signer = new Wallet(CONFIG.privateKey);

  let creds: ApiKeyCreds | undefined;
  if (CONFIG.polyApiKey && CONFIG.polySecret && CONFIG.polyPassphrase) {
    creds = {
      key: CONFIG.polyApiKey,
      secret: CONFIG.polySecret,
      passphrase: CONFIG.polyPassphrase,
    };
  }

  const l1Client = new ClobClient(
    CLOB_HOST, POLYGON_CHAIN_ID, signer, undefined,
    CONFIG.signatureType, CONFIG.polymarketFunderAddress
  );

  if (!creds) {
    log.info("INFO", { message: "No API credentials — deriving from private key..." });
    try {
      creds = await l1Client.createOrDeriveApiKey();
      log.info("INFO", {
        message: "Credentials derived. Copy to .env to skip derivation next time.",
        POLY_API_KEY: creds.key,
        POLY_SECRET: creds.secret,
        POLY_PASSPHRASE: creds.passphrase,
      });
    } catch (err) {
      throw new Error(`Failed to derive API credentials: ${(err as Error).message}`);
    }
  }

  clobClient = new ClobClient(
    CLOB_HOST, POLYGON_CHAIN_ID, signer, creds,
    CONFIG.signatureType, CONFIG.polymarketFunderAddress
  );

  try {
    await clobClient.getOk();
    log.info("INFO", { message: "CLOB client initialised." });
  } catch (err) {
    throw new Error(`CLOB connectivity check failed: ${(err as Error).message}`);
  }
}

function getClobClient(): ClobClient {
  if (!clobClient) throw new Error("CLOB client not initialised.");
  return clobClient;
}

// ─── slug / interval helpers ──────────────────────────────────────────────────

function generateSlug(asset: string, duration: string, ts: number): string {
  const a = ASSET_SLUG_MAP[asset.toUpperCase()] ?? asset.toLowerCase();
  const d = DURATION_SLUG_MAP[duration] ?? duration;
  return `${a}-updown-${d}-${ts}`;
}

/**
 * Return Unix timestamps (seconds) for: previous, current, and next 2 intervals.
 * We check prev too because some markets are created slightly before the interval.
 */
function getIntervalTimestamps(durationSecs: number): number[] {
  const now = Math.floor(Date.now() / 1000);
  const current = Math.floor(now / durationSecs) * durationSecs;
  return [
    current - durationSecs, // previous (in case we're right at a boundary)
    current,
    current + durationSecs,
    current + durationSecs * 2,
  ];
}

// ─── Gamma API types ──────────────────────────────────────────────────────────

interface GammaMarketDetail {
  id: string;
  question?: string;
  conditionId?: string;
  clobTokenIds?: string;
  outcomePrices?: string;
  outcomes?: string;
  acceptingOrders?: boolean;
  enableOrderBook?: boolean;
  orderPriceMinTickSize?: number;
  endDate?: string;
  endDateIso?: string;
  active?: boolean;
  closed?: boolean;
  restricted?: boolean;
}

interface GammaEvent {
  id?: string;
  slug?: string;
  title?: string;
  active?: boolean;
  closed?: boolean;
  negRisk?: boolean;
  markets?: GammaMarketDetail[];
}

// ─── market fetching ──────────────────────────────────────────────────────────

export async function fetchCryptoMarkets(): Promise<Market[]> {
  const results: Market[] = [];
  const seen = new Set<string>();
  const now = Date.now();

  // Generate all slugs we want to check
  const slugsToFetch: Array<{ slug: string; asset: string; duration: string }> = [];
  for (const asset of CONFIG.targetAssets) {
    for (const duration of CONFIG.marketDurations) {
      const durationSecs = DURATION_SECONDS_MAP[duration];
      if (!durationSecs) {
        log.warn("WARN", { message: `Unknown duration config: "${duration}". Use 5m or 15m.` });
        continue;
      }
      for (const ts of getIntervalTimestamps(durationSecs)) {
        slugsToFetch.push({ slug: generateSlug(asset, duration, ts), asset, duration });
      }
    }
  }

  log.info("INFO", {
    message: `Fetching ${slugsToFetch.length} event slugs...`,
    slugs: slugsToFetch.map((s) => s.slug),
  });

  // Fetch all in parallel
  await Promise.all(
    slugsToFetch.map(async ({ slug, asset, duration }) => {
      let event: GammaEvent | null;
      try {
        event = await fetchEventBySlug(slug);
      } catch (err) {
        log.warn("WARN", { message: `Slug fetch error: ${slug}`, error: (err as Error).message });
        return;
      }

      if (!event) return; // 404 — interval not created yet, that's fine

      if (event.closed) {
        log.info("INFO", { message: `Event closed, skipping: ${slug}` });
        return;
      }

      if (!event.markets || event.markets.length === 0) {
        log.warn("WARN", { message: `Event has no markets: ${slug}` });
        return;
      }

      for (const m of event.markets) {
        if (!m.id || seen.has(m.id)) continue;
        if (m.closed) continue;
        if (m.active === false) continue;

        // Time check
        const endDateStr = m.endDate;
        if (!endDateStr) continue;
        const endMs = new Date(endDateStr).getTime();
        if (isNaN(endMs) || endMs <= now) continue;
        const timeRemainingSeconds = Math.floor((endMs - now) / 1000);

        // The /events endpoint nested market sometimes omits clobTokenIds.
        // Fetch full market detail from /markets?id=... if needed.
        let detail = m;
        if (!m.clobTokenIds) {
          log.info("INFO", { message: `No clobTokenIds in nested market, fetching detail for id=${m.id}` });
          try {
            const fetched = await fetchMarketById(m.id);
            if (fetched) detail = { ...m, ...fetched };
          } catch (err) {
            log.warn("WARN", { message: `Could not fetch market detail for ${m.id}`, error: (err as Error).message });
            continue;
          }
        }

        if (!detail.enableOrderBook) {
          log.info("INFO", { message: `enableOrderBook=false for market ${m.id}, skipping` });
          continue;
        }
        if (!detail.clobTokenIds) {
          log.warn("WARN", { message: `Still no clobTokenIds for market ${m.id} after detail fetch` });
          continue;
        }

        let tokenIds: string[];
        try {
          tokenIds = JSON.parse(detail.clobTokenIds) as string[];
        } catch { continue; }
        if (!tokenIds || tokenIds.length < 2) continue;

        let prices: number[];
        try {
          prices = (JSON.parse(detail.outcomePrices ?? "[]") as (string | number)[]).map(Number);
        } catch { continue; }
        if (!prices || prices.length < 2) continue;

        const price0 = prices[0]; // Up token
        const price1 = prices[1]; // Down token

        const winSide: "YES" | "NO" = price0 >= price1 ? "YES" : "NO";
        const winSidePrice = price0 >= price1 ? price0 : price1;
        const tokenIdToBuy = price0 >= price1 ? tokenIds[0] : tokenIds[1];

        const tickSize = detail.orderPriceMinTickSize != null
          ? detail.orderPriceMinTickSize.toString()
          : "0.01";

        const question = detail.question ?? event.title ?? slug;

        seen.add(m.id);
        results.push({
          id: m.id,
          question,
          asset,
          duration,
          closesAt: endDateStr,
          timeRemainingSeconds,
          winSide,
          winSidePrice: round4(winSidePrice),
          yesTokenId: tokenIds[0],
          noTokenId: tokenIds[1],
          tokenIdToBuy,
          negRisk: event.negRisk ?? false,
          tickSize,
        });
      }
    })
  );

  log.info("SCAN_TICK", {
    source: "gamma_slug_fetch",
    slugsFetched: slugsToFetch.length,
    qualifying: results.length,
  });

  return results;
}

// ─── Gamma fetch helpers ──────────────────────────────────────────────────────

async function fetchEventBySlug(slug: string): Promise<GammaEvent | null> {
  const url = `${GAMMA_API}/events?slug=${encodeURIComponent(slug)}`;
  const response = await fetch(url);
  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`Gamma /events error: HTTP ${response.status} for slug "${slug}"`);
  }
  const data = await response.json() as GammaEvent[];
  if (!Array.isArray(data) || data.length === 0) return null;
  return data[0] ?? null;
}

async function fetchMarketById(marketId: string): Promise<GammaMarketDetail | null> {
  const url = `${GAMMA_API}/markets?id=${encodeURIComponent(marketId)}`;
  const response = await fetch(url);
  if (!response.ok) return null;
  const data = await response.json() as GammaMarketDetail[];
  if (!Array.isArray(data) || data.length === 0) return null;
  return data.find((m) => m.id === marketId) ?? data[0] ?? null;
}

// ─── resolution polling ───────────────────────────────────────────────────────

export async function fetchMarketResolution(
  marketId: string,
  _expectedWinSide: "YES" | "NO"
): Promise<MarketResolution> {
  try {
    const market = await fetchMarketById(marketId);
    if (!market || !market.closed) return { marketId, outcome: "PENDING" };

    let prices: number[] = [];
    try {
      prices = (JSON.parse(market.outcomePrices ?? "[]") as (string | number)[]).map(Number);
    } catch {
      return { marketId, outcome: "PENDING" };
    }
    if (prices.length < 2) return { marketId, outcome: "PENDING" };

    // prices[0]=Up, prices[1]=Down. Winner is at 1.0
    let outcome: "YES" | "NO" | "CANCELLED";
    if (prices[0] >= 0.99) outcome = "YES";
    else if (prices[1] >= 0.99) outcome = "NO";
    else outcome = "CANCELLED";

    return { marketId, outcome, resolvedAt: new Date().toISOString() };
  } catch (err) {
    log.error("RESOLUTION_ERROR", { marketId, error: (err as Error).message });
    return { marketId, outcome: "PENDING" };
  }
}

// ─── order placement ──────────────────────────────────────────────────────────

export async function placeOrder(market: Market, stakeUsd: number): Promise<OrderResult> {
  const client = getClobClient();

  const orderTypeMap: Record<string, OrderType> = {
    GTC: OrderType.GTC, GTD: OrderType.GTD,
    FOK: OrderType.FOK, FAK: OrderType.FAK,
  };
  const orderType = orderTypeMap[CONFIG.orderType] ?? OrderType.GTC;
  const price = market.winSidePrice;
  const sizeShares = round4(stakeUsd / price);

  try {
    let resp: unknown;
    if (orderType === OrderType.FOK || orderType === OrderType.FAK) {
      const order = await client.createMarketOrder({
        tokenID: market.tokenIdToBuy, amount: stakeUsd, side: Side.BUY,
      });
      resp = await client.postOrder(order, orderType);
    } else {
      resp = await client.createAndPostOrder(
        { tokenID: market.tokenIdToBuy, price, size: sizeShares, side: Side.BUY },
        { tickSize: market.tickSize as "0.1" | "0.01" | "0.001" | "0.0001", negRisk: market.negRisk },
        orderType
      );
    }
    const r = resp as Record<string, unknown>;
    const orderId = (r.orderId ?? r.id ?? r.orderID ?? "") as string;

    log.info("ORDER_RESPONSE", {
      marketId: market.id, tokenId: market.tokenIdToBuy, side: market.winSide,
      stakeUsd, sizeShares, price, orderType: CONFIG.orderType, orderId, rawResponse: resp,
    });

    return { success: true, orderId: orderId || undefined, avgPrice: price,
      filled: orderType === OrderType.FOK || orderType === OrderType.FAK, rawResponse: resp };
  } catch (err) {
    const error = (err as Error).message;
    log.error("ORDER_FAILED", { marketId: market.id, stakeUsd, error });
    return { success: false, error };
  }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
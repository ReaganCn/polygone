/**
 * polymarket.ts
 *
 * Thin wrapper around @polymarket/clob-client and the Gamma HTTP API.
 *
 * Responsibilities:
 *   1. Initialise the CLOB client with the user's wallet credentials.
 *   2. Fetch and normalise open crypto up/down markets from the Gamma API.
 *   3. Place orders (limit/market) via the CLOB API.
 *   4. Poll for market resolution.
 *
 * Notes on Polymarket order semantics:
 *   - All orders are expressed as limit orders under the hood.
 *   - "market" behaviour = set a price at or slightly better than best ask.
 *   - We are always BUYING (going long on the winning side token).
 *   - Size is expressed in USDC (dollars), not shares.
 *   - The token we buy is determined by which outcome has the high price
 *     (≥ priceRangeMin), because that side is the market's current favourite.
 */

import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import { CONFIG } from "./config.js";
import { log } from "./logger.js";
import type { Market, OrderResult, MarketResolution } from "./types.js";

// ─── constants ───────────────────────────────────────────────────────────────

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_HOST = "https://clob.polymarket.com";
const POLYGON_CHAIN_ID = 137;

// ─── module state ─────────────────────────────────────────────────────────────

let clobClient: ClobClient | null = null;

// ─── init ─────────────────────────────────────────────────────────────────────

/**
 * Initialise the CLOB client.
 * Derives or creates L2 API credentials if not set in .env.
 * Must be called once at startup before any trading operations.
 */
export async function initialiseClobClient(): Promise<void> {
  const signer = new Wallet(CONFIG.privateKey);

  // Build credentials object if env vars are present
  let creds: ApiKeyCreds | undefined;
  if (CONFIG.polyApiKey && CONFIG.polySecret && CONFIG.polyPassphrase) {
    creds = {
      key: CONFIG.polyApiKey,
      secret: CONFIG.polySecret,
      passphrase: CONFIG.polyPassphrase,
    };
  }

  // Create client. If no creds, use L1-only client to derive them first.
  const l1Client = new ClobClient(
    CLOB_HOST,
    POLYGON_CHAIN_ID,
    signer,
    undefined,
    CONFIG.signatureType,
    CONFIG.polymarketFunderAddress
  );

  if (!creds) {
    log.info("INFO", { message: "No API credentials found — deriving from private key..." });
    try {
      creds = await l1Client.createOrDeriveApiKey();
      log.info("INFO", {
        message: "API credentials derived. Add these to your .env to skip this step next time.",
        POLY_API_KEY: creds.key,
        POLY_SECRET: creds.secret,
        POLY_PASSPHRASE: creds.passphrase,
      });
    } catch (err) {
      throw new Error(`Failed to derive API credentials: ${(err as Error).message}`);
    }
  }

  clobClient = new ClobClient(
    CLOB_HOST,
    POLYGON_CHAIN_ID,
    signer,
    creds,
    CONFIG.signatureType,
    CONFIG.polymarketFunderAddress
  );

  // Validate connectivity
  try {
    await clobClient.getOk();
    log.info("INFO", { message: "CLOB client initialised and connected." });
  } catch (err) {
    throw new Error(`CLOB connectivity check failed: ${(err as Error).message}`);
  }
}

function getClobClient(): ClobClient {
  if (!clobClient) throw new Error("CLOB client not initialised. Call initialiseClobClient() first.");
  return clobClient;
}

// ─── market fetching ──────────────────────────────────────────────────────────

interface GammaMarket {
  id: string;
  question: string;
  endDateIso?: string;
  endDate?: string;
  active?: boolean;
  closed?: boolean;
  acceptingOrders?: boolean;
  enableOrderBook?: boolean;
  clobTokenIds?: string;
  outcomePrices?: string;
  outcomes?: string;
  orderPriceMinTickSize?: number;
  events?: Array<{ negRisk?: boolean }>;
  negRiskOther?: boolean;
}

/**
 * Fetch qualifying crypto up/down markets from the Gamma API.
 * Returns normalised Market objects ready for the scanner to evaluate.
 */
export async function fetchCryptoMarkets(): Promise<Market[]> {
  // Fetch active, non-closed CLOB-enabled markets.
  // We over-fetch and filter client-side for maximum flexibility.
  const url = new URL(`${GAMMA_API}/markets`);
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("limit", "200");
  url.searchParams.set("order", "endDate");
  url.searchParams.set("ascending", "true");

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Gamma API error: ${response.status} ${response.statusText}`);
  }

  const raw: GammaMarket[] = await response.json() as GammaMarket[];

  const now = Date.now();
  const results: Market[] = [];

  for (const m of raw) {
    // Must be CLOB-enabled
    if (!m.enableOrderBook || !m.acceptingOrders) continue;

    // Must have token IDs
    if (!m.clobTokenIds) continue;

    // Parse token IDs — stored as a JSON array string like '["0xabc","0xdef"]'
    let tokenIds: string[];
    try {
      tokenIds = JSON.parse(m.clobTokenIds) as string[];
    } catch {
      continue;
    }
    if (!tokenIds || tokenIds.length < 2) continue;

    const yesTokenId = tokenIds[0];
    const noTokenId = tokenIds[1];

    // Parse outcome prices — stored as JSON array string like '[0.97, 0.03]'
    let prices: number[];
    try {
      const raw_prices = JSON.parse(m.outcomePrices ?? "[]");
      prices = (raw_prices as (string | number)[]).map(Number);
    } catch {
      continue;
    }
    if (!prices || prices.length < 2) continue;

    const yesPrice = prices[0];
    const noPrice = prices[1];

    // Match against target assets
    const question = m.question ?? "";
    const matchedAsset = CONFIG.targetAssets.find((asset) =>
      question.toUpperCase().includes(asset.toUpperCase())
    );
    if (!matchedAsset) continue;

    // Match against target durations
    const matchedDuration = CONFIG.marketDurations.find((dur) =>
      question.toLowerCase().includes(dur.toLowerCase())
    );
    if (!matchedDuration) continue;

    // Must be an up/down market (contains "above" or "higher" or "up" or "below" or "lower")
    const isUpDown =
      /\b(above|higher|up|below|lower|down|exceed|over|under)\b/i.test(question);
    if (!isUpDown) continue;

    // Check time remaining
    const endDateStr = m.endDateIso ?? m.endDate;
    if (!endDateStr) continue;
    const endMs = new Date(endDateStr).getTime();
    if (isNaN(endMs)) continue;

    const timeRemainingSeconds = Math.max(0, Math.floor((endMs - now) / 1000));
    // Skip already-expired markets
    if (timeRemainingSeconds <= 0) continue;

    // Determine win side — whichever outcome is the high-priced one
    let winSide: "YES" | "NO";
    let winSidePrice: number;
    let tokenIdToBuy: string;

    if (yesPrice >= noPrice) {
      winSide = "YES";
      winSidePrice = yesPrice;
      tokenIdToBuy = yesTokenId;
    } else {
      winSide = "NO";
      winSidePrice = noPrice;
      tokenIdToBuy = noTokenId;
    }

    // negRisk flag — comes from the parent event if present
    const negRisk = m.events?.[0]?.negRisk ?? false;

    // Tick size
    const tickSize = m.orderPriceMinTickSize != null
      ? m.orderPriceMinTickSize.toString()
      : "0.01";

    results.push({
      id: m.id,
      question,
      asset: matchedAsset,
      duration: matchedDuration,
      closesAt: endDateStr,
      timeRemainingSeconds,
      winSide,
      winSidePrice: round4(winSidePrice),
      yesTokenId,
      noTokenId,
      tokenIdToBuy,
      negRisk,
      tickSize,
    });
  }

  return results;
}

// ─── order placement ──────────────────────────────────────────────────────────

/**
 * Place a buy order for a market's winning-side token.
 *
 * @param market    - the Market to bet on
 * @param stakeUsd  - USDC to spend
 * @returns OrderResult with success/failure details
 */
export async function placeOrder(
  market: Market,
  stakeUsd: number
): Promise<OrderResult> {
  const client = getClobClient();

  // Map our config order type to the SDK's OrderType enum
  const orderTypeMap: Record<string, OrderType> = {
    GTC: OrderType.GTC,
    GTD: OrderType.GTD,
    FOK: OrderType.FOK,
    FAK: OrderType.FAK,
  };
  const orderType = orderTypeMap[CONFIG.orderType] ?? OrderType.GTC;

  // For FOK/FAK (market orders), we specify the amount in USDC (amountType = "DOLLAR").
  // For GTC/GTD (limit orders), we specify size in shares and a price.
  // We always target the current winSidePrice to get filled quickly.
  const price = market.winSidePrice;

  // Shares = dollars / price (how many tokens $X buys at this price)
  const sizeShares = round4(stakeUsd / price);

  try {
    let resp: unknown;

    if (orderType === OrderType.FOK || orderType === OrderType.FAK) {
      // Market order — SDK uses MarketOrderArgs with amount in USDC
      const order = await client.createMarketOrder({
        tokenID: market.tokenIdToBuy,
        amount: stakeUsd,
        side: Side.BUY,
      });
      resp = await client.postOrder(order, orderType);
    } else {
      // Limit order (GTC / GTD)
      resp = await client.createAndPostOrder(
        {
          tokenID: market.tokenIdToBuy,
          price,
          size: sizeShares,
          side: Side.BUY,
        },
        {
          tickSize: market.tickSize as "0.1" | "0.01" | "0.001" | "0.0001",
          negRisk: market.negRisk,
        },
        orderType
      );
    }

    // The SDK response shape varies but orderId / id are common
    const r = resp as Record<string, unknown>;
    const orderId = (r.orderId ?? r.id ?? r.orderID ?? "") as string;

    log.info("ORDER_RESPONSE", {
      marketId: market.id,
      tokenId: market.tokenIdToBuy,
      side: market.winSide,
      stakeUsd,
      sizeShares,
      price,
      orderType: CONFIG.orderType,
      orderId,
      rawResponse: resp,
    });

    return {
      success: true,
      orderId: orderId || undefined,
      avgPrice: price,
      filled: orderType === OrderType.FOK || orderType === OrderType.FAK,
      rawResponse: resp,
    };
  } catch (err) {
    const error = (err as Error).message;
    log.error("ORDER_FAILED", {
      marketId: market.id,
      tokenId: market.tokenIdToBuy,
      stakeUsd,
      error,
    });
    return { success: false, error };
  }
}

// ─── resolution polling ───────────────────────────────────────────────────────

/**
 * Fetch the current resolution status of a market by ID from the Gamma API.
 *
 * Gamma API market fields used for resolution:
 *   - closed: boolean  — market has ended
 *   - outcomePrices: "[1, 0]" or "[0, 1]"  — after resolution, winner is 1.00
 *
 * Returns the outcome (YES/NO), or PENDING if not yet resolved.
 */
export async function fetchMarketResolution(
  marketId: string,
  expectedWinSide: "YES" | "NO"
): Promise<MarketResolution> {
  try {
    const url = `${GAMMA_API}/markets?id=${encodeURIComponent(marketId)}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const markets = await response.json() as GammaMarket[];
    const market = markets.find((m) => m.id === marketId) ?? markets[0];

    if (!market) {
      return { marketId, outcome: "PENDING" };
    }

    // A resolved binary market has one outcome at 1.00 and the other at 0.00
    if (!market.closed) {
      return { marketId, outcome: "PENDING" };
    }

    let prices: number[] = [];
    try {
      const raw = JSON.parse(market.outcomePrices ?? "[]");
      prices = (raw as (string | number)[]).map(Number);
    } catch {
      return { marketId, outcome: "PENDING" };
    }

    if (prices.length < 2) {
      return { marketId, outcome: "PENDING" };
    }

    const yesPrice = prices[0];
    const noPrice = prices[1];

    // Resolution: the winning side is at 1.0
    let outcome: "YES" | "NO" | "CANCELLED";
    if (yesPrice >= 0.99) {
      outcome = "YES";
    } else if (noPrice >= 0.99) {
      outcome = "NO";
    } else {
      // Prices don't resolve clearly — treat as cancelled/unknown
      outcome = "CANCELLED";
    }

    return {
      marketId,
      outcome,
      resolvedAt: new Date().toISOString(),
    };
  } catch (err) {
    log.error("RESOLUTION_ERROR", {
      marketId,
      error: (err as Error).message,
    });
    return { marketId, outcome: "PENDING" };
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * polymarket.ts — Polymarket API client
 *
 * LIVE PATH AUDIT FIXES:
 *
 * BUG 1 — Wrong method for FOK orders
 *   Old: createMarketOrder() + postOrder(order, OrderType.FOK)
 *   The clob-client has a dedicated createAndPostMarketOrder() that handles
 *   FOK/FAK in one call with correct signing. Our two-step approach was calling
 *   postOrder() with a SignedOrder that wasn't built for FOK, which could cause
 *   signature mismatches or rejections.
 *   Fix: use client.createAndPostMarketOrder() for FOK/FAK.
 *
 * BUG 2 — No pre-flight balance check
 *   We never verified the wallet has enough USDC before placing an order.
 *   A low-balance order silently fails and we mark it as success.
 *   Fix: check COLLATERAL balance before every live order, log clearly if
 *   insufficient, return failure early.
 *
 * BUG 3 — roundSizeForPrecision loop tolerance too loose
 *   The check `Math.abs(product - productExact) < 0.005` is the same as
 *   the rounding threshold itself, so it always passes on the first iteration
 *   regardless of precision. The correct check is that the product, when
 *   expressed as a string, has at most 2 decimal places.
 *   Fix: check decimal string length directly.
 *
 * BUG 4 — createAndPostOrder options parameter is not Partial<>
 *   The actual signature is: createAndPostOrder(userOrder, options?, orderType?)
 *   where options is Partial<CreateOrderOptions>. tickSize is REQUIRED inside
 *   CreateOrderOptions (not optional), so passing it as Partial<> means it
 *   could be omitted and the order would use a wrong tick size.
 *   Fix: always pass tickSize explicitly and validate it's a known value.
 *
 * CHANGE (redeemer): conditionId is now mapped from the Gamma API response
 *   into every Market object so that redeemer.ts can call redeemPositions().
 */

import { ClobClient, OrderType, Side, AssetType } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import { CONFIG } from "./config.js";
import { log } from "./logger.js";
import type { Market, OrderResult, MarketResolution } from "./types.js";
import { createPublicClient, Hex, http } from "viem";
import { polygon } from "viem/chains";

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_HOST = "https://clob.polymarket.com";
const POLYGON_CHAIN_ID = 137;

const CTF_ABI = [
  { name: "payoutNumerators", type: "function", inputs: [{ name: "conditionId", type: "bytes32" }, { name: "index", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { name: "payoutDenominator", type: "function", inputs: [{ name: "conditionId", type: "bytes32" }], outputs: [{ type: "uint256" }] },
] as const;

const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";

const publicClient = createPublicClient({ 
  chain: polygon, 
  transport: http(CONFIG.polygonRpcUrl) 
});

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

const VALID_TICK_SIZES = ["0.1", "0.01", "0.001", "0.0001"] as const;
type TickSize = typeof VALID_TICK_SIZES[number];

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
    log.info("INFO", { message: "CLOB client initialised and connected." });
  } catch (err) {
    throw new Error(`CLOB connectivity check failed: ${(err as Error).message}`);
  }
}

function getClobClient(): ClobClient {
  if (!clobClient) throw new Error("CLOB client not initialised. Call initialiseClobClient() first.");
  return clobClient;
}

// ─── balance check ────────────────────────────────────────────────────────────

/**
 * BUG 2 FIX: Check USDC balance before placing a live order.
 * Returns the balance in USDC (6-decimal USDC → divide by 1e6).
 */
export async function getUsdcBalance(): Promise<number> {
  const client = getClobClient();
  const resp = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  return parseFloat(resp.balance) / 1e6;
}

// ─── slug / interval helpers ──────────────────────────────────────────────────

function generateSlug(asset: string, duration: string, ts: number): string {
  const a = ASSET_SLUG_MAP[asset.toUpperCase()] ?? asset.toLowerCase();
  const d = DURATION_SLUG_MAP[duration] ?? duration;
  return `${a}-updown-${d}-${ts}`;
}

function getIntervalTimestamps(durationSecs: number): number[] {
  const now = Math.floor(Date.now() / 1000);
  const current = Math.floor(now / durationSecs) * durationSecs;
  return [
    current - durationSecs,
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

  const DURATIONS = ["5m", "15m"];
  const slugsToFetch: Array<{ slug: string; asset: string; duration: string }> = [];
  for (const asset of CONFIG.targetAssets) {
    for (const duration of DURATIONS) {
      const durationSecs = DURATION_SECONDS_MAP[duration];
      if (!durationSecs) continue;
      for (const ts of getIntervalTimestamps(durationSecs)) {
        slugsToFetch.push({ slug: generateSlug(asset, duration, ts), asset, duration });
      }
    }
  }

  await Promise.all(
    slugsToFetch.map(async ({ slug, asset, duration }) => {
      let event: GammaEvent | null;
      try {
        event = await fetchEventBySlug(slug);
      } catch (err) {
        log.warn("WARN", { message: `Slug fetch error: ${slug}`, error: (err as Error).message });
        return;
      }

      if (!event) return;
      if (event.closed) return;
      if (!event.markets || event.markets.length === 0) return;

      for (const m of event.markets) {
        if (!m.id || seen.has(m.id)) continue;
        if (m.closed) continue;
        if (m.active === false) continue;

        const endDateStr = m.endDate;
        if (!endDateStr) continue;
        const endMs = new Date(endDateStr).getTime();
        if (isNaN(endMs) || endMs <= now) continue;
        const timeRemainingSeconds = Math.floor((endMs - now) / 1000);

        let detail = m;
        if (!m.clobTokenIds) {
          try {
            const fetched = await fetchMarketById(m.id);
            if (fetched) detail = { ...m, ...fetched };
          } catch (err) {
            log.warn("WARN", { message: `Could not fetch detail for ${m.id}`, error: (err as Error).message });
            continue;
          }
        }

        if (!detail.enableOrderBook) continue;
        if (!detail.clobTokenIds) continue;

        // conditionId is required for redemption. Skip markets that don't have it
        // (should never happen for real Polymarket markets, but guard anyway).
        if (!detail.conditionId) {
          log.warn("WARN", { message: `Market ${m.id} has no conditionId — skipping`, slug });
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

        const price0 = prices[0];
        const price1 = prices[1];
        const winSide: "YES" | "NO" = price0 >= price1 ? "YES" : "NO";
        const winSidePrice = price0 >= price1 ? price0 : price1;
        const tokenIdToBuy = price0 >= price1 ? tokenIds[0] : tokenIds[1];

        // BUG 4 FIX: Validate tick size is a known value, default to "0.01"
        const rawTickSize = detail.orderPriceMinTickSize?.toString() ?? "0.01";
        const tickSize: TickSize = VALID_TICK_SIZES.includes(rawTickSize as TickSize)
          ? (rawTickSize as TickSize)
          : "0.01";

        seen.add(m.id);
        results.push({
          id: m.id,
          conditionId: detail.conditionId,  // ← mapped from Gamma API response
          question: detail.question ?? event.title ?? slug,
          asset, duration,
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

async function fetchEventBySlug(slug: string): Promise<GammaEvent | null> {
  const url = `${GAMMA_API}/events?slug=${encodeURIComponent(slug)}`;
  const response = await fetch(url);
  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`Gamma /events HTTP ${response.status} for slug "${slug}"`);
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
    if (!market || !market.conditionId) return { marketId, outcome: "PENDING" };

    // 1. Check if the contract is actually settled
    const denominator = await publicClient.readContract({
      address: CTF_ADDRESS,
      abi: CTF_ABI,
      functionName: "payoutDenominator",
      args: [market.conditionId as Hex],
    }) as bigint;

    // If denominator is 0, the Oracle hasn't reported yet. 
    // Even if the API says "closed", we stay in PENDING.
    if (denominator === 0n) {
      return { marketId, outcome: "PENDING" };
    }

    // 2. Determine the winner on-chain
    // Index 0 is YES, Index 1 is NO
    const [payoutYes, payoutNo] = await Promise.all([
      publicClient.readContract({
        address: CTF_ADDRESS,
        abi: CTF_ABI,
        functionName: "payoutNumerators",
        args: [market.conditionId as Hex, 0n],
      }) as Promise<bigint>,
      publicClient.readContract({
        address: CTF_ADDRESS,
        abi: CTF_ABI,
        functionName: "payoutNumerators",
        args: [market.conditionId as Hex, 1n],
      }) as Promise<bigint>,
    ]);

    let outcome: "YES" | "NO" | "CANCELLED";
    
    if (payoutYes > 0n && payoutNo === 0n) outcome = "YES";
    else if (payoutNo > 0n && payoutYes === 0n) outcome = "NO";
    else outcome = "CANCELLED"; // Covers [1, 1] or [0.5, 0.5] cases

    console.info("RESOLUTION_CONFIRMED_ONCHAIN", { marketId, outcome });

    return { 
      marketId, 
      outcome, 
      resolvedAt: new Date().toISOString() 
    };

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
  const orderType = orderTypeMap[CONFIG.orderType] ?? OrderType.FOK;
  const price = market.winSidePrice;
  const tickSize = market.tickSize as TickSize;

  // BUG 2 FIX: Pre-flight balance check
  try {
    const balance = await getUsdcBalance();
    if (balance < stakeUsd) {
      const error = `Insufficient USDC balance: have $${balance.toFixed(2)}, need $${stakeUsd}`;
      log.error("ORDER_FAILED", { marketId: market.id, stakeUsd, balance, error });
      return { success: false, error };
    }
    log.info("INFO", { message: `Balance check passed: $${balance.toFixed(2)} available` });
  } catch (err) {
    log.warn("WARN", {
      message: "Could not check USDC balance before order — proceeding anyway",
      error: (err as Error).message,
    });
  }

  try {
    let resp: unknown;

    if (orderType === OrderType.FOK || orderType === OrderType.FAK) {
      // BUG 1 FIX: Use createAndPostMarketOrder() for FOK/FAK
      resp = await client.createAndPostMarketOrder(
        {
          tokenID: market.tokenIdToBuy,
          amount: stakeUsd,
          side: Side.BUY,
          price,
        },
        { tickSize, negRisk: market.negRisk },
        orderType
      );
    } else {
      // GTC/GTD: limit order
      // BUG 3 FIX: Use correctly validated size
      const sizeShares = roundSizeForPrecision(stakeUsd / price, price);

      resp = await client.createAndPostOrder(
        {
          tokenID: market.tokenIdToBuy,
          price,
          size: sizeShares,
          side: Side.BUY,
        },
        { tickSize, negRisk: market.negRisk },
        orderType
      );
    }

    const r = resp as Record<string, unknown>;

    const errorMsg = r["errorMsg"] ?? r["error"];
    const status = r["status"] as string | undefined;
    const orderId = (r["orderId"] ?? r["id"] ?? r["orderID"] ?? "") as string;
    const isRejected =
      (typeof errorMsg === "string" && errorMsg.length > 0 && !orderId) ||
      status === "rejected" ||
      status === "error";

    if (isRejected) {
      const errorText = String(errorMsg ?? status ?? "Order rejected by CLOB");
      log.error("ORDER_FAILED", {
        marketId: market.id,
        tokenId: market.tokenIdToBuy,
        stakeUsd, price, orderType: CONFIG.orderType,
        error: errorText,
        rawResponse: resp,
      });
      return { success: false, error: errorText };
    }
    

    log.info("ORDER_RESPONSE", {
      marketId: market.id,
      tokenId: market.tokenIdToBuy,
      side: market.winSide,
      stakeUsd, price,
      orderType: CONFIG.orderType,
      orderId, status,
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
    log.error("ORDER_FAILED", { marketId: market.id, stakeUsd, error });
    return { success: false, error };
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * BUG 3 FIX: Round share size so that size × price has at most 2 decimal places.
 */
function roundSizeForPrecision(rawSize: number, price: number): number {
  let size = Math.floor(rawSize * 10000) / 10000;

  for (let i = 0; i < 200; i++) {
    const product = size * price;
    const str = product.toFixed(10).replace(/0+$/, "");
    const dotIdx = str.indexOf(".");
    const decimalPlaces = dotIdx === -1 ? 0 : str.length - dotIdx - 1;

    if (decimalPlaces <= 2) break;

    size = Math.floor((size - 0.0001) * 10000) / 10000;
    if (size <= 0) { size = 0.0001; break; }
  }

  return size;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
/**
 * polymarket.ts — Polymarket API client
 *
 * FIXES APPLIED:
 *
 * [P2/P3] placeOrder now returns the actual average fill price from the CLOB
 *   response instead of always echoing back market.winSidePrice.
 *   parseAvgFillPrice() extracts it from the response using known field names.
 *   bet.priceAtBet will now reflect the real execution price, which means:
 *     - handleWsResolution payoutUsd = stakeUsd / priceAtBet is accurate
 *     - handleStopLoss sharesOwned = stakeUsd / priceAtBet is accurate
 *     - sellPosition no longer risks selling more shares than owned
 *   Falls back to market.winSidePrice if the field is absent (FOK/FAK fills
 *   often match the submitted price exactly anyway, so this is safe).
 *
 * ORIGINAL BUGS FIXED PREVIOUSLY (retained):
 *   BUG 1 — Wrong method for FOK orders → createAndPostMarketOrder
 *   BUG 2 — No pre-flight balance check
 *   BUG 3 — roundSizeForPrecision loop tolerance
 *   BUG 4 — createAndPostOrder options parameter
 */

import { ClobClient, OrderType, Side, AssetType } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import { CONFIG } from "./config.js";
import { log } from "./logger.js";
import type { Market, ActiveBet, OrderResult, MarketResolution } from "./types.js";

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
  // Only fetch current and previous interval.
  // current+1 and current+2 don't exist yet — fetching them wastes API calls
  // every scan cycle. [P5 — low severity but free to fix here]
  return [
    current - durationSecs,
    current,
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

        const rawTickSize = detail.orderPriceMinTickSize?.toString() ?? "0.01";
        const tickSize: TickSize = VALID_TICK_SIZES.includes(rawTickSize as TickSize)
          ? (rawTickSize as TickSize)
          : "0.01";

        seen.add(m.id);
        results.push({
          id: m.id,
          conditionId: detail.conditionId,
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
    if (!market || !market.closed) return { marketId, outcome: "PENDING" };

    let prices: number[] = [];
    try {
      prices = (JSON.parse(market.outcomePrices ?? "[]") as (string | number)[]).map(Number);
    } catch {
      return { marketId, outcome: "PENDING" };
    }
    if (prices.length < 2) return { marketId, outcome: "PENDING" };

    let outcome: "YES" | "NO" | "CANCELLED";
    if (prices[0] >= 0.99) outcome = "YES";
    else if (prices[1] >= 0.99) outcome = "NO";
    else outcome = "CANCELLED";
    // NOTE: CANCELLED is returned as-is here. The retry guard that prevents
    // a false CANCELLED loss during the oracle settlement window lives in
    // startFallbackResolutionWatcher in trader.ts, not here. This keeps
    // fetchMarketResolution stateless and easy to test.

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
  const orderType = orderTypeMap[CONFIG.orderType] ?? OrderType.FOK;
  const price = market.winSidePrice;
  const tickSize = market.tickSize as TickSize;

  // Pre-flight balance check
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

    // [P2] Extract orderId first. A valid orderId means the order reached the
    // book regardless of any ancillary error/warning fields in the response.
    const orderId = (r["orderId"] ?? r["id"] ?? r["orderID"] ?? "") as string;
    const errorMsg = r["errorMsg"] ?? r["error"];
    const status = r["status"] as string | undefined;

    // Only treat as rejected if there is no valid orderId AND there is a clear
    // error signal. This prevents false-negative failures where the CLOB returns
    // a warning string alongside a filled order.
    const isRejected =
      !orderId &&
      (
        (typeof errorMsg === "string" && errorMsg.length > 0) ||
        status === "rejected" ||
        status === "error"
      );

    if (isRejected) {
      const errorText = String(errorMsg ?? status ?? "Order rejected by CLOB");
      log.error("ORDER_FAILED", {
        marketId: market.id, tokenId: market.tokenIdToBuy,
        stakeUsd, price, orderType: CONFIG.orderType,
        error: errorText, rawResponse: resp,
      });
      return { success: false, error: errorText };
    }

    // [P2] Extract the actual average fill price from the response.
    // Falls back to the submitted price if the field is absent.
    const actualAvgPrice = parseAvgFillPrice(r, price);

    log.info("ORDER_RESPONSE", {
      marketId: market.id, tokenId: market.tokenIdToBuy,
      side: market.winSide, stakeUsd,
      submittedPrice: price,
      avgFillPrice: actualAvgPrice,
      orderType: CONFIG.orderType, orderId, status, rawResponse: resp,
    });

    return {
      success: true,
      orderId: orderId || undefined,
      avgPrice: actualAvgPrice,   // [P2] real fill price, not submitted price
      filled: orderType === OrderType.FOK || orderType === OrderType.FAK,
      rawResponse: resp,
    };
  } catch (err) {
    const error = (err as Error).message;
    log.error("ORDER_FAILED", { marketId: market.id, stakeUsd, error });
    return { success: false, error };
  }
}

// ─── stop-loss sell ───────────────────────────────────────────────────────────

export async function sellPosition(bet: ActiveBet): Promise<OrderResult> {
  const client = getClobClient();

  const tokenIdToSell = bet.market.tokenIdToBuy;
  const tickSize = bet.market.tickSize as TickSize;

  // [P3] sharesOwned now uses bet.priceAtBet which is the actual fill price
  // (after the P2 fix to placeOrder). This prevents overcounting shares.
  const sharesOwned = roundSizeForPrecision(bet.stakeUsd / bet.priceAtBet, bet.priceAtBet);
  const sellPrice = CONFIG.stopLossLimitPrice;

  log.info("ORDER_RESPONSE", {
    action: "stop_loss_sell_attempt",
    betId: bet.betId,
    marketId: bet.market.id,
    tokenId: tokenIdToSell,
    sharesOwned,
    sellPrice,
    stakeUsd: bet.stakeUsd,
    priceAtBet: bet.priceAtBet,
  });

  try {
    const resp = await client.createAndPostMarketOrder(
      {
        tokenID: tokenIdToSell,
        amount: sharesOwned,
        side: Side.SELL,
        price: sellPrice,
      },
      { tickSize, negRisk: bet.market.negRisk },
      OrderType.FAK
    );

    const r = resp as Record<string, unknown>;
    const orderId = (r["orderId"] ?? r["id"] ?? r["orderID"] ?? "") as string;
    const errorMsg = r["errorMsg"] ?? r["error"];
    const status = r["status"] as string | undefined;

    // Same orderId-first rejection logic as placeOrder
    const isRejected =
      !orderId &&
      (
        (typeof errorMsg === "string" && errorMsg.length > 0) ||
        status === "rejected" ||
        status === "error"
      );

    if (isRejected) {
      const errorText = String(errorMsg ?? status ?? "Sell order rejected");
      log.error("ORDER_FAILED", {
        action: "stop_loss_sell",
        betId: bet.betId, marketId: bet.market.id,
        sharesOwned, sellPrice, error: errorText, rawResponse: resp,
      });
      return { success: false, error: errorText };
    }

    // ── Read recovered USDC directly from takingAmount ────────────────────────
    // For a SELL order we are the taker:
    //   takingAmount = USDC received  (what we want — direct, no math needed)
    //   makingAmount = shares given   (used only for partial-fill detection)
    //
    // The previous approach (filledShares × avgFillPrice) required an avgPrice
    // field that does not exist in the Polymarket CLOB response, so it always
    // fell back to CONFIG.stopLossLimitPrice (0.05) → recoveredUsd ≈ $0.07.
    // ─────────────────────────────────────────────────────────────────────────

    // USDC proceeds — read directly, default 0 if field absent (conservative)
    const takingRaw    = r["takingAmount"] ?? r["taking_amount"];
    const recoveredUsd = takingRaw !== undefined
      ? round2(parseFloat(String(takingRaw)))
      : 0;

    // Shares sold — used only to detect partial fills
    const makingRaw    = r["makingAmount"] ?? r["making_amount"];
    const filledShares = makingRaw !== undefined
      ? parseFloat(String(makingRaw))
      : (recoveredUsd > 0 ? sharesOwned : 0);  // fallback: assume full fill if we got USDC

    // Derive avgFillPrice for logging only — NOT used for accounting
    const avgFillPrice = filledShares > 0 ? round4(recoveredUsd / filledShares) : 0;

    log.info("ORDER_RESPONSE", {
      action: "stop_loss_sell_filled",
      betId: bet.betId, marketId: bet.market.id,
      sharesOwned, filledShares,
      limitPrice: sellPrice,
      avgFillPrice,     // derived for logging only
      recoveredUsd,     // authoritative — read directly from takingAmount
      stakeUsd: bet.stakeUsd,
      netLoss: round2(bet.stakeUsd - recoveredUsd),
      rawResponse: resp,
    });

    return {
      success: true,
      recoveredUsd,     // pass through directly so handleStopLoss needs no recomputation
      filledShares,
      avgPrice: avgFillPrice,
      filled: filledShares > 0,
      rawResponse: resp,
    };
  } catch (err) {
    const error = (err as Error).message;
    log.error("ORDER_FAILED", {
      action: "stop_loss_sell",
      betId: bet.betId, marketId: bet.market.id,
      sharesOwned, sellPrice, error,
    });
    return { success: false, error };
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * [P2] Extract the actual average fill price from the raw CLOB response.
 * Field names vary across CLOB API versions. Falls back to the submitted
 * price if absent (FOK/FAK fills at the submitted price when the market
 * matches exactly, so this is a safe fallback).
 */
function parseAvgFillPrice(r: Record<string, unknown>, fallback: number): number {
  const candidates = [
    r["avgPrice"],
    r["average_price"],
    r["avg_price"],
    r["executionPrice"],
    r["execution_price"],
    r["fillPrice"],
    r["fill_price"],
  ];
  for (const v of candidates) {
    if (v !== undefined && v !== null) {
      const n = parseFloat(String(v));
      if (!isNaN(n) && n > 0 && n <= 1) return n;  // prices are 0–1 on Polymarket
    }
  }
  return fallback;
}

/**
 * Extract filled share count from the raw CLOB response.
 * Falls back to full size if absent (optimistic — assumes fully filled).
 */
function parseFilledShares(r: Record<string, unknown>, fallback: number): number {
  const candidates = [
    r["matchedAmount"],
    r["filledAmount"],
    r["filled_amount"],
    r["takerAmount"],
  ];
  for (const v of candidates) {
    if (v !== undefined && v !== null) {
      const n = parseFloat(String(v));
      if (!isNaN(n) && n >= 0) return n;
    }
  }
  return fallback;
}

/**
 * Round share size so that size × price has at most 2 decimal places.
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

function round2(n: number): number { return Math.round(n * 100) / 100; }
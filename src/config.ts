/**
 * config.ts — Single source of truth for all bot configuration.
 *
 * New in this version:
 *   - Per-duration price ranges: PRICE_RANGE_MIN_5M, PRICE_RANGE_MAX_5M,
 *     PRICE_RANGE_MIN_15M, PRICE_RANGE_MAX_15M
 *   - Per-duration max time remaining: MAX_TIME_REMAINING_5M (default 150s),
 *     MAX_TIME_REMAINING_15M (default 450s) — half of each market duration.
 *     A bet is only placed when timeRemaining <= this value.
 *   - Toggle each market type on/off: ENABLE_5M, ENABLE_15M, ENABLE_FALLBACK
 *   - Fallback is now a named rule (not just a time-based filter)
 *
 * CHANGE (redeemer):
 *   Added builder program credentials: polyBuilderApiKey, polyBuilderSecret,
 *   polyBuilderPassphrase, polygonRpcUrl.
 *   These are read from env but NOT exposed via POST /config (non-mutable).
 *
 * CHANGE (scheduler):
 *   Added tradingStartTime, tradingEndTime ("HH:MM" UTC format).
 *   Added dailyProfitTarget, dailyLossLimit (USDC, null = disabled).
 */

import "dotenv/config";

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function parseFloat_(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseFloat(v);
  if (isNaN(n)) throw new Error(`${key} must be a number, got: ${v}`);
  return n;
}

function parseInt_(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  if (isNaN(n)) throw new Error(`${key} must be an integer, got: ${v}`);
  return n;
}

function parseBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (!v) return fallback;
  return v.toLowerCase() === "true" || v === "1";
}

function parseList(key: string, fallback: string[]): string[] {
  const v = process.env[key];
  if (!v) return fallback;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

export type OrderTypeOption = "GTC" | "GTD" | "FOK" | "FAK";
export type EarlyCloseOrderTypeOption = "FOK" | "LIMIT";

export interface BotConfig {
  // Wallet / auth
  privateKey: string;
  polymarketFunderAddress: string;
  signatureType: number;
  polyApiKey: string;
  polySecret: string;
  polyPassphrase: string;

  // ── Builder program credentials (required for auto-redemption) ─────────────
  polyBuilderApiKey: string;
  polyBuilderSecret: string;
  polyBuilderPassphrase: string;
  polygonRpcUrl: string;
  // ──────────────────────────────────────────────────────────────────────────

  // Scanning
  scanIntervalMs: number;
  targetAssets: string[];

  // Market type toggles
  enable5m: boolean;
  enable15m: boolean;
  enableFallback: boolean;

  // Price ranges — per duration
  priceRangeMin5m: number;
  priceRangeMax5m: number;
  priceRangeMin15m: number;
  priceRangeMax15m: number;

  // Max time remaining to enter a trade (seconds) — per duration
  maxTimeRemaining5m: number;
  maxTimeRemaining15m: number;

  // Fallback rule
  fallbackTimeRemaining5m: number;
  fallbackTimeRemaining15m: number;
  fallbackMinPrice: number;
  fallbackMaxPrice: number;

  // Order execution
  orderType: OrderTypeOption;

  // Slot / compounding
  numSlots: number;
  slotInitialUsd: number;
  slotProfitMultiplier: number;

  // Mode
  shadowMode: boolean;

  // Logging
  logFilePath: string;

  // Resolution polling
  resolutionPollIntervalMs: number;

  // Express API port
  apiPort: number;

  // ── Scheduler ─────────────────────────────────────────────────────────────
  // Trading hours in UTC. Format: "HH:MM". Bot pauses outside this window.
  // Defaults to all day ("00:00" – "23:59").
  tradingStartTime: string;
  tradingEndTime: string;

  // Daily P&L thresholds in USDC. null = disabled.
  //   dailyProfitTarget: pause when today's net P&L >= this value.
  //   dailyLossLimit:    pause when today's net P&L <= -this value (stored positive).
  dailyProfitTarget: number | null;
  dailyLossLimit: number | null;
  // ──────────────────────────────────────────────────────────────────────────

  // ── Telegram alerts ─────────────────────────────────────────────────────
  telegramBotToken: string;
  telegramChatId: string;
  // ──────────────────────────────────────────────────────────────────────────

  // ── Early close (TP / SL on active bets) ─────────────────────────────────
  // When enabled, the bot monitors the bid price of every held token via
  // WebSocket and closes the position before market expiry.
  earlyCloseEnabled: boolean;
  // "FOK" = Fill-Or-Kill sell with up to earlyCloseFokRetries retries.
  // "LIMIT" = GTC sell, waits for fill until market expires then cancels.
  earlyCloseOrderType: EarlyCloseOrderTypeOption;
  // Take profit: close when current bid rises by this delta above entry price.
  earlyCloseTakeProfitDelta: number;
  // Stop loss: close when current bid falls by this delta below entry price.
  earlyCloseStopLossDelta: number;
  // How many times to retry a failed FOK close (FOK mode only).
  earlyCloseFokRetries: number;
  // Milliseconds to wait between FOK retries (FOK mode only).
  earlyCloseFokRetryDelayMs: number;
  // ──────────────────────────────────────────────────────────────────────────
}

function loadConfig(): BotConfig {
  const orderTypeRaw = optionalEnv("ORDER_TYPE", "FOK").toUpperCase();
  const validOrderTypes: OrderTypeOption[] = ["GTC", "GTD", "FOK", "FAK"];
  if (!validOrderTypes.includes(orderTypeRaw as OrderTypeOption)) {
    throw new Error(`ORDER_TYPE must be one of ${validOrderTypes.join(", ")}, got: ${orderTypeRaw}`);
  }

  return {
    privateKey: requireEnv("PRIVATE_KEY"),
    polymarketFunderAddress: requireEnv("POLYMARKET_FUNDER_ADDRESS"),
    signatureType: parseInt_("SIGNATURE_TYPE", 0),
    polyApiKey: optionalEnv("POLY_API_KEY", ""),
    polySecret: optionalEnv("POLY_SECRET", ""),
    polyPassphrase: optionalEnv("POLY_PASSPHRASE", ""),

    polyBuilderApiKey:     optionalEnv("POLY_BUILDER_API_KEY", ""),
    polyBuilderSecret:     optionalEnv("POLY_BUILDER_SECRET", ""),
    polyBuilderPassphrase: optionalEnv("POLY_BUILDER_PASSPHRASE", ""),
    polygonRpcUrl:         optionalEnv("POLYGON_RPC_URL", "https://polygon-rpc.com"),

    scanIntervalMs: parseInt_("SCAN_INTERVAL_MS", 4000),
    targetAssets: parseList("TARGET_ASSETS", ["BTC", "ETH", "SOL"]),

    enable5m:       parseBool("ENABLE_5M", true),
    enable15m:      parseBool("ENABLE_15M", true),
    enableFallback: parseBool("ENABLE_FALLBACK", true),

    priceRangeMin5m:  parseFloat_("PRICE_RANGE_MIN_5M",  0.91),
    priceRangeMax5m:  parseFloat_("PRICE_RANGE_MAX_5M",  0.99),
    priceRangeMin15m: parseFloat_("PRICE_RANGE_MIN_15M", 0.96),
    priceRangeMax15m: parseFloat_("PRICE_RANGE_MAX_15M", 0.99),

    maxTimeRemaining5m:  parseInt_("MAX_TIME_REMAINING_5M",  150),
    maxTimeRemaining15m: parseInt_("MAX_TIME_REMAINING_15M", 450),

    fallbackTimeRemaining5m:  parseInt_("FALLBACK_TIME_REMAINING_5M",  40),
    fallbackTimeRemaining15m: parseInt_("FALLBACK_TIME_REMAINING_15M", 120),
    fallbackMinPrice:         parseFloat_("FALLBACK_MIN_PRICE", 0.0),
    fallbackMaxPrice:         parseFloat_("FALLBACK_MAX_PRICE", 0.99),

    orderType: orderTypeRaw as OrderTypeOption,

    numSlots:             parseInt_("NUM_SLOTS", 5),
    slotInitialUsd:       parseFloat_("SLOT_INITIAL_USD", 1),
    slotProfitMultiplier: parseFloat_("SLOT_PROFIT_MULTIPLIER", 1.2),

    shadowMode: parseBool("SHADOW_MODE", true),

    logFilePath:              optionalEnv("LOG_FILE_PATH", "./logs/activity.log"),
    resolutionPollIntervalMs: parseInt_("RESOLUTION_POLL_INTERVAL_MS", 5000),
    apiPort:                  parseInt_("API_PORT", 3000),

    tradingStartTime: optionalEnv("TRADING_START_TIME", "00:00"),
    tradingEndTime:   optionalEnv("TRADING_END_TIME",   "23:59"),

    dailyProfitTarget: process.env["DAILY_PROFIT_TARGET"]
      ? parseFloat_("DAILY_PROFIT_TARGET", 0) : null,
    dailyLossLimit: process.env["DAILY_LOSS_LIMIT"]
      ? parseFloat_("DAILY_LOSS_LIMIT", 0) : null,

    telegramBotToken: optionalEnv("TELEGRAM_BOT_TOKEN", ""),
    telegramChatId:   optionalEnv("TELEGRAM_CHAT_ID", ""),
    earlyCloseEnabled:          parseBool("EARLY_CLOSE_ENABLED", false),
    earlyCloseOrderType:        (() => {
      const v = optionalEnv("EARLY_CLOSE_ORDER_TYPE", "FOK").toUpperCase();
      if (v !== "FOK" && v !== "LIMIT") throw new Error(`EARLY_CLOSE_ORDER_TYPE must be FOK or LIMIT, got: ${v}`);
      return v as EarlyCloseOrderTypeOption;
    })(),
    earlyCloseTakeProfitDelta:  parseFloat_("EARLY_CLOSE_TP_DELTA",            0.06),
    earlyCloseStopLossDelta:    parseFloat_("EARLY_CLOSE_SL_DELTA",            0.03),
    earlyCloseFokRetries:       parseInt_("EARLY_CLOSE_FOK_RETRIES",           3),
    earlyCloseFokRetryDelayMs:  parseInt_("EARLY_CLOSE_FOK_RETRY_DELAY_MS",   1000),  };
}

// ─── mutable keys ─────────────────────────────────────────────────────────────

export type MutableConfigKeys =
  | "scanIntervalMs"
  | "enable5m"
  | "enable15m"
  | "enableFallback"
  | "priceRangeMin5m"
  | "priceRangeMax5m"
  | "priceRangeMin15m"
  | "priceRangeMax15m"
  | "maxTimeRemaining5m"
  | "maxTimeRemaining15m"
  | "fallbackTimeRemaining5m"
  | "fallbackTimeRemaining15m"
  | "fallbackMinPrice"
  | "fallbackMaxPrice"
  | "orderType"
  | "numSlots"
  | "slotInitialUsd"
  | "slotProfitMultiplier"
  | "shadowMode"
  | "targetAssets"
  | "tradingStartTime"
  | "tradingEndTime"
  | "dailyProfitTarget"
  | "dailyLossLimit"
  | "earlyCloseEnabled"
  | "earlyCloseOrderType"
  | "earlyCloseTakeProfitDelta"
  | "earlyCloseStopLossDelta"
  | "earlyCloseFokRetries"
  | "earlyCloseFokRetryDelayMs";

const KEY_TYPES: Record<MutableConfigKeys, "number" | "integer" | "boolean" | "string" | "stringArray" | "orderType" | "closeOrderType" | "numberOrNull"> = {
  scanIntervalMs:           "integer",
  enable5m:                 "boolean",
  enable15m:                "boolean",
  enableFallback:           "boolean",
  priceRangeMin5m:          "number",
  priceRangeMax5m:          "number",
  priceRangeMin15m:         "number",
  priceRangeMax15m:         "number",
  maxTimeRemaining5m:       "integer",
  maxTimeRemaining15m:      "integer",
  fallbackTimeRemaining5m:  "integer",
  fallbackTimeRemaining15m: "integer",
  fallbackMinPrice:         "number",
  fallbackMaxPrice:         "number",
  orderType:                "orderType",
  numSlots:                 "integer",
  slotInitialUsd:           "number",
  slotProfitMultiplier:     "number",
  shadowMode:               "boolean",
  targetAssets:             "stringArray",
  tradingStartTime:         "string",
  tradingEndTime:           "string",
  dailyProfitTarget:        "numberOrNull",
  dailyLossLimit:           "numberOrNull",
  earlyCloseEnabled:          "boolean",
  earlyCloseOrderType:        "closeOrderType",
  earlyCloseTakeProfitDelta:  "number",
  earlyCloseStopLossDelta:    "number",
  earlyCloseFokRetries:       "integer",
  earlyCloseFokRetryDelayMs:  "integer",
};

export const CONFIG: BotConfig = loadConfig();

export function updateConfig(
  patch: Partial<Record<MutableConfigKeys, unknown>>
): { updated: string[]; errors: Record<string, string> } {
  const updated: string[] = [];
  const errors: Record<string, string> = {};
  const mutableKeys = Object.keys(KEY_TYPES) as MutableConfigKeys[];

  for (const key of mutableKeys) {
    if (!(key in patch) || patch[key] === undefined) continue;
    const raw = patch[key];
    const expectedType = KEY_TYPES[key];
    try {
      let coerced: unknown;
      switch (expectedType) {
        case "number": {
          const n = Number(raw);
          if (isNaN(n)) throw new Error("must be a number");
          coerced = n;
          break;
        }
        case "integer": {
          const n = Math.round(Number(raw));
          if (isNaN(n)) throw new Error("must be an integer");
          coerced = n;
          break;
        }
        case "boolean": {
          if (typeof raw === "boolean") { coerced = raw; }
          else if (raw === "true" || raw === "1" || raw === 1) { coerced = true; }
          else if (raw === "false" || raw === "0" || raw === 0) { coerced = false; }
          else throw new Error("must be true or false");
          break;
        }
        case "orderType": {
          const s = String(raw).toUpperCase();
          if (!["GTC", "GTD", "FOK", "FAK"].includes(s)) throw new Error("must be GTC, GTD, FOK, or FAK");
          coerced = s;
          break;
        }
        case "closeOrderType": {
          const s = String(raw).toUpperCase();
          if (!["FOK", "LIMIT"].includes(s)) throw new Error("must be FOK or LIMIT");
          coerced = s;
          break;
        }
        case "stringArray": {
          if (Array.isArray(raw)) {
            coerced = (raw as unknown[]).map(String).filter(Boolean);
          } else if (typeof raw === "string") {
            coerced = raw.split(",").map((s) => s.trim()).filter(Boolean);
          } else {
            throw new Error("must be an array or comma-separated string");
          }
          break;
        }
        case "numberOrNull": {
          if (raw === null || raw === "" || raw === "null") { coerced = null; break; }
          const n = Number(raw);
          if (isNaN(n)) throw new Error("must be a number or null");
          coerced = n;
          break;
        }
        default:
          coerced = String(raw);
      }
      // @ts-expect-error dynamic assignment
      CONFIG[key] = coerced;
      updated.push(key);
    } catch (err) {
      errors[key] = `Invalid value for ${key}: ${(err as Error).message}`;
    }
  }
  return { updated, errors };
}
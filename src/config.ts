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

export interface BotConfig {
  // Wallet / auth
  privateKey: string;
  polymarketFunderAddress: string;
  signatureType: number;
  polyApiKey: string;
  polySecret: string;
  polyPassphrase: string;

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
  // A bet is only placed when timeRemainingSeconds <= this value.
  // Default: half of each market's total duration (150s for 5m, 450s for 15m).
  maxTimeRemaining5m: number;
  maxTimeRemaining15m: number;

  // Fallback rule: triggers near expiry regardless of price, per duration
  fallbackTimeRemaining5m: number;   // default 40s  (last ~13% of a 5m market)
  fallbackTimeRemaining15m: number;  // default 120s (last ~13% of a 15m market)
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

    scanIntervalMs: parseInt_("SCAN_INTERVAL_MS", 4000),
    targetAssets: parseList("TARGET_ASSETS", ["BTC", "ETH", "SOL"]),

    enable5m:       parseBool("ENABLE_5M", true),
    enable15m:      parseBool("ENABLE_15M", true),
    enableFallback: parseBool("ENABLE_FALLBACK", true),

    // 5m price range: default slightly wider (more volatile short windows)
    priceRangeMin5m:  parseFloat_("PRICE_RANGE_MIN_5M",  0.91),
    priceRangeMax5m:  parseFloat_("PRICE_RANGE_MAX_5M",  0.99),
    // 15m price range: default tighter (more predictable longer windows)
    priceRangeMin15m: parseFloat_("PRICE_RANGE_MIN_15M", 0.96),
    priceRangeMax15m: parseFloat_("PRICE_RANGE_MAX_15M", 0.99),

    // Max time remaining to enter: defaults to half of each market's duration
    maxTimeRemaining5m:  parseInt_("MAX_TIME_REMAINING_5M",  150), // half of 300s
    maxTimeRemaining15m: parseInt_("MAX_TIME_REMAINING_15M", 450), // half of 900s

    // Fallback rule (applies to any duration when near expiry)
    fallbackTimeRemaining5m:  parseInt_("FALLBACK_TIME_REMAINING_5M",  40),
    fallbackTimeRemaining15m: parseInt_("FALLBACK_TIME_REMAINING_15M", 120),
    fallbackMinPrice:         parseFloat_("FALLBACK_MIN_PRICE", 0.0),
    fallbackMaxPrice:         parseFloat_("FALLBACK_MAX_PRICE", 0.99),

    orderType: orderTypeRaw as OrderTypeOption,

    numSlots:            parseInt_("NUM_SLOTS", 5),
    slotInitialUsd:      parseFloat_("SLOT_INITIAL_USD", 1),
    slotProfitMultiplier: parseFloat_("SLOT_PROFIT_MULTIPLIER", 1.2),

    shadowMode: parseBool("SHADOW_MODE", true),

    logFilePath: optionalEnv("LOG_FILE_PATH", "./logs/activity.log"),
    resolutionPollIntervalMs: parseInt_("RESOLUTION_POLL_INTERVAL_MS", 5000),
    apiPort: parseInt_("API_PORT", 3000),
  };
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
  | "targetAssets";

const KEY_TYPES: Record<MutableConfigKeys, "number" | "integer" | "boolean" | "string" | "stringArray" | "orderType"> = {
  scanIntervalMs:         "integer",
  enable5m:               "boolean",
  enable15m:              "boolean",
  enableFallback:         "boolean",
  priceRangeMin5m:        "number",
  priceRangeMax5m:        "number",
  priceRangeMin15m:       "number",
  priceRangeMax15m:       "number",
  maxTimeRemaining5m:     "integer",
  maxTimeRemaining15m:    "integer",
  fallbackTimeRemaining5m:  "integer",
  fallbackTimeRemaining15m: "integer",
  fallbackMinPrice:         "number",
  fallbackMaxPrice:         "number",
  orderType:              "orderType",
  numSlots:               "integer",
  slotInitialUsd:         "number",
  slotProfitMultiplier:   "number",
  shadowMode:             "boolean",
  targetAssets:           "stringArray",
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
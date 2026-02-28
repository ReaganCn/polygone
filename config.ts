/**
 * config.ts
 *
 * Single source of truth for all bot configuration.
 * Values are loaded from environment variables (via dotenv).
 * A typed CONFIG object is exported and used everywhere else.
 * Some values can be hot-updated at runtime via the REST API (see api.ts).
 */

import "dotenv/config";

// ─── helpers ─────────────────────────────────────────────────────────────────

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required environment variable: ${key}`);
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

// ─── types ───────────────────────────────────────────────────────────────────

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
  marketDurations: string[];

  // Price filtering
  priceRangeMin: number;
  priceRangeMax: number;
  fallbackTimeRemainingS: number;
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

// ─── load ─────────────────────────────────────────────────────────────────────

function loadConfig(): BotConfig {
  const orderTypeRaw = optionalEnv("ORDER_TYPE", "GTC").toUpperCase();
  const validOrderTypes: OrderTypeOption[] = ["GTC", "GTD", "FOK", "FAK"];
  if (!validOrderTypes.includes(orderTypeRaw as OrderTypeOption)) {
    throw new Error(
      `ORDER_TYPE must be one of ${validOrderTypes.join(", ")}, got: ${orderTypeRaw}`
    );
  }

  return {
    // Wallet / auth
    privateKey: requireEnv("PRIVATE_KEY"),
    polymarketFunderAddress: requireEnv("POLYMARKET_FUNDER_ADDRESS"),
    signatureType: parseInt_("SIGNATURE_TYPE", 0),
    polyApiKey: optionalEnv("POLY_API_KEY", ""),
    polySecret: optionalEnv("POLY_SECRET", ""),
    polyPassphrase: optionalEnv("POLY_PASSPHRASE", ""),

    // Scanning
    scanIntervalMs: parseInt_("SCAN_INTERVAL_MS", 4000),
    targetAssets: parseList("TARGET_ASSETS", ["BTC", "ETH", "SOL"]),
    marketDurations: parseList("MARKET_DURATIONS", ["5-minute", "15-minute"]),

    // Price filtering
    priceRangeMin: parseFloat_("PRICE_RANGE_MIN", 0.9),
    priceRangeMax: parseFloat_("PRICE_RANGE_MAX", 0.99),
    fallbackTimeRemainingS: parseInt_("FALLBACK_TIME_REMAINING_S", 40),
    fallbackMaxPrice: parseFloat_("FALLBACK_MAX_PRICE", 0.99),

    // Order execution
    orderType: orderTypeRaw as OrderTypeOption,

    // Slot / compounding
    numSlots: parseInt_("NUM_SLOTS", 5),
    slotInitialUsd: parseFloat_("SLOT_INITIAL_USD", 10),
    slotProfitMultiplier: parseFloat_("SLOT_PROFIT_MULTIPLIER", 1.2),

    // Mode
    shadowMode: parseBool("SHADOW_MODE", true),

    // Logging
    logFilePath: optionalEnv("LOG_FILE_PATH", "./logs/activity.log"),

    // Resolution polling
    resolutionPollIntervalMs: parseInt_("RESOLUTION_POLL_INTERVAL_MS", 5000),

    // Express API
    apiPort: parseInt_("API_PORT", 3000),
  };
}

// ─── mutable runtime config ──────────────────────────────────────────────────
// A subset of fields can be changed via the REST API without restarting.

export type MutableConfigKeys =
  | "scanIntervalMs"
  | "priceRangeMin"
  | "priceRangeMax"
  | "fallbackTimeRemainingS"
  | "fallbackMaxPrice"
  | "orderType"
  | "numSlots"
  | "slotInitialUsd"
  | "slotProfitMultiplier"
  | "shadowMode"
  | "targetAssets"
  | "marketDurations";

export const CONFIG: BotConfig = loadConfig();

/**
 * Partially update the live CONFIG object.
 * Only whitelisted keys (MutableConfigKeys) are accepted.
 * Returns the list of keys that were actually updated.
 */
export function updateConfig(patch: Partial<Record<MutableConfigKeys, unknown>>): string[] {
  const mutableKeys: MutableConfigKeys[] = [
    "scanIntervalMs",
    "priceRangeMin",
    "priceRangeMax",
    "fallbackTimeRemainingS",
    "fallbackMaxPrice",
    "orderType",
    "numSlots",
    "slotInitialUsd",
    "slotProfitMultiplier",
    "shadowMode",
    "targetAssets",
    "marketDurations",
  ];

  const updated: string[] = [];

  for (const key of mutableKeys) {
    if (key in patch && patch[key] !== undefined) {
      // @ts-expect-error – dynamic assignment on typed object
      CONFIG[key] = patch[key];
      updated.push(key);
    }
  }

  return updated;
}

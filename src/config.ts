/**
 * config.ts
 *
 * Single source of truth for all bot configuration.
 * Loaded from .env at startup; a subset can be hot-updated via POST /config.
 *
 * HOT CONFIG FIX: updateConfig now coerces incoming values to the correct type
 * (number, boolean, string[], string) so JSON body values like "0.95" (string)
 * are correctly stored as 0.95 (number). Previously, sending a numeric string
 * would silently store it as a string, causing comparison failures.
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
  privateKey: string;
  polymarketFunderAddress: string;
  signatureType: number;
  polyApiKey: string;
  polySecret: string;
  polyPassphrase: string;
  scanIntervalMs: number;
  targetAssets: string[];
  marketDurations: string[];
  priceRangeMin: number;
  priceRangeMax: number;
  fallbackTimeRemainingS: number;
  fallbackMaxPrice: number;
  orderType: OrderTypeOption;
  numSlots: number;
  slotInitialUsd: number;
  slotProfitMultiplier: number;
  shadowMode: boolean;
  logFilePath: string;
  resolutionPollIntervalMs: number;
  apiPort: number;
}

function loadConfig(): BotConfig {
  const orderTypeRaw = optionalEnv("ORDER_TYPE", "GTC").toUpperCase();
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
    marketDurations: parseList("MARKET_DURATIONS", ["5m", "15m"]),
    priceRangeMin: parseFloat_("PRICE_RANGE_MIN", 0.9),
    priceRangeMax: parseFloat_("PRICE_RANGE_MAX", 0.99),
    fallbackTimeRemainingS: parseInt_("FALLBACK_TIME_REMAINING_S", 40),
    fallbackMaxPrice: parseFloat_("FALLBACK_MAX_PRICE", 0.99),
    orderType: orderTypeRaw as OrderTypeOption,
    numSlots: parseInt_("NUM_SLOTS", 5),
    slotInitialUsd: parseFloat_("SLOT_INITIAL_USD", 10),
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

// The expected type for each mutable key — used for coercion
const KEY_TYPES: Record<MutableConfigKeys, "number" | "integer" | "boolean" | "string" | "stringArray" | "orderType"> = {
  scanIntervalMs:         "integer",
  priceRangeMin:          "number",
  priceRangeMax:          "number",
  fallbackTimeRemainingS: "integer",
  fallbackMaxPrice:       "number",
  orderType:              "orderType",
  numSlots:               "integer",
  slotInitialUsd:         "number",
  slotProfitMultiplier:   "number",
  shadowMode:             "boolean",
  targetAssets:           "stringArray",
  marketDurations:        "stringArray",
};

export const CONFIG: BotConfig = loadConfig();

/**
 * Hot-update CONFIG at runtime.
 * Values are coerced to the correct type so JSON strings like "0.95" become 0.95.
 * Returns the list of keys that were actually updated, and any validation errors.
 */
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
          if (isNaN(n)) throw new Error(`must be a number`);
          coerced = n;
          break;
        }
        case "integer": {
          const n = Math.round(Number(raw));
          if (isNaN(n)) throw new Error(`must be an integer`);
          coerced = n;
          break;
        }
        case "boolean": {
          if (typeof raw === "boolean") {
            coerced = raw;
          } else if (raw === "true" || raw === "1" || raw === 1) {
            coerced = true;
          } else if (raw === "false" || raw === "0" || raw === 0) {
            coerced = false;
          } else {
            throw new Error(`must be true or false`);
          }
          break;
        }
        case "orderType": {
          const s = String(raw).toUpperCase();
          if (!["GTC", "GTD", "FOK", "FAK"].includes(s)) {
            throw new Error(`must be GTC, GTD, FOK, or FAK`);
          }
          coerced = s;
          break;
        }
        case "stringArray": {
          if (Array.isArray(raw)) {
            coerced = (raw as unknown[]).map(String).filter(Boolean);
          } else if (typeof raw === "string") {
            // Accept comma-separated string too: "BTC,ETH"
            coerced = raw.split(",").map((s) => s.trim()).filter(Boolean);
          } else {
            throw new Error(`must be an array of strings or comma-separated string`);
          }
          break;
        }
        case "string":
        default:
          coerced = String(raw);
      }

      // @ts-expect-error – dynamic assignment
      CONFIG[key] = coerced;
      updated.push(key);
    } catch (err) {
      errors[key] = `Invalid value for ${key}: ${(err as Error).message}`;
    }
  }

  return { updated, errors };
}
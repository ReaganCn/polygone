/**
 * config.ts — Single source of truth for all bot configuration.
 *
 * STRADDLE OVERHAUL:
 *   - Removed: enableFallback, priceRange*, fallback* fields
 *   - Added: dump detection, straddle entry, DCA, compounding config
 *   - sumTarget defaults to 0.92 to absorb ~1.8% taker fees
 *   - MutableConfigKeys updated accordingly
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

  // Builder program credentials (required for auto-redemption)
  polyBuilderApiKey: string;
  polyBuilderSecret: string;
  polyBuilderPassphrase: string;
  polygonRpcUrl: string;

  // Scanning
  scanIntervalMs: number;
  targetAssets: string[];

  // Market type toggles
  enable5m: boolean;
  enable15m: boolean;

  // Max time remaining to enter a trade (seconds) — per duration
  maxTimeRemaining5m: number;
  maxTimeRemaining15m: number;

  // ── Dump detection ──────────────────────────────────────────────────────────
  dumpLookbackSeconds: number;   // rolling window for price history (default 3)
  dumpThresholdPercent: number;  // min % drop to fire dump signal (default 15)
  dumpEntryMaxPrice: number;     // only enter if dumped ask <= this (default 0.35)
  // ────────────────────────────────────────────────────────────────────────────

  // ── Straddle entry ──────────────────────────────────────────────────────────
  sumTarget: number;             // leg1 + leg2 target sum (default 0.92)
  hedgeTimeoutSeconds: number;   // max seconds to fill Leg 2 (default 120)
  // ────────────────────────────────────────────────────────────────────────────

  // ── DCA ─────────────────────────────────────────────────────────────────────
  enableDca: boolean;            // allow DCA on Leg 1 (default true)
  dcaThresholdPercent: number;   // Leg 1 ask must drop this % below avg (default 5)
  maxDcaCount: number;           // max DCA buys per straddle (default 3)
  // ────────────────────────────────────────────────────────────────────────────

  // ── Fill monitoring ─────────────────────────────────────────────────────────
  fillPollIntervalMs: number;    // base poll interval for fill checks (default 5000)
  stopLossRemainingSeconds: number; // force-buy Leg 2 when market closes within this (default 300)
  // ────────────────────────────────────────────────────────────────────────────

  // Order execution
  orderType: OrderTypeOption;

  // Slot / compounding
  numSlots: number;
  slotInitialUsd: number;
  slotProfitMultiplier: number;
  enableCompounding: boolean;

  // Mode
  shadowMode: boolean;

  // Logging
  logFilePath: string;

  // Resolution polling
  resolutionPollIntervalMs: number;

  // Express API port
  apiPort: number;

  // Scheduler
  tradingStartTime: string;
  tradingEndTime: string;
  dailyProfitTarget: number | null;
  dailyLossLimit: number | null;

  // Telegram alerts
  telegramBotToken: string;
  telegramChatId: string;
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

    enable5m:  parseBool("ENABLE_5M", true),
    enable15m: parseBool("ENABLE_15M", true),

    maxTimeRemaining5m:  parseInt_("MAX_TIME_REMAINING_5M",  150),
    maxTimeRemaining15m: parseInt_("MAX_TIME_REMAINING_15M", 450),

    dumpLookbackSeconds:  parseInt_("DUMP_LOOKBACK_SECONDS", 3),
    dumpThresholdPercent: parseFloat_("DUMP_THRESHOLD_PERCENT", 15),
    dumpEntryMaxPrice:    parseFloat_("DUMP_ENTRY_MAX_PRICE", 0.35),

    sumTarget:            parseFloat_("SUM_TARGET", 0.92),
    hedgeTimeoutSeconds:  parseInt_("HEDGE_TIMEOUT_SECONDS", 120),

    enableDca:            parseBool("ENABLE_DCA", true),
    dcaThresholdPercent:  parseFloat_("DCA_THRESHOLD_PERCENT", 5),
    maxDcaCount:          parseInt_("MAX_DCA_COUNT", 3),

    fillPollIntervalMs:        parseInt_("FILL_POLL_INTERVAL_MS", 5000),
    stopLossRemainingSeconds:  parseInt_("STOP_LOSS_REMAINING_SECONDS", 300),

    orderType: orderTypeRaw as OrderTypeOption,

    numSlots:             parseInt_("NUM_SLOTS", 5),
    slotInitialUsd:       parseFloat_("SLOT_INITIAL_USD", 1),
    slotProfitMultiplier: parseFloat_("SLOT_PROFIT_MULTIPLIER", 1.2),
    enableCompounding:    parseBool("ENABLE_COMPOUNDING", true),

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
  };
}

// ─── mutable keys ─────────────────────────────────────────────────────────────

export type MutableConfigKeys =
  | "scanIntervalMs"
  | "enable5m"
  | "enable15m"
  | "maxTimeRemaining5m"
  | "maxTimeRemaining15m"
  | "dumpLookbackSeconds"
  | "dumpThresholdPercent"
  | "dumpEntryMaxPrice"
  | "sumTarget"
  | "hedgeTimeoutSeconds"
  | "enableDca"
  | "dcaThresholdPercent"
  | "maxDcaCount"
  | "fillPollIntervalMs"
  | "stopLossRemainingSeconds"
  | "orderType"
  | "numSlots"
  | "slotInitialUsd"
  | "slotProfitMultiplier"
  | "enableCompounding"
  | "shadowMode"
  | "targetAssets"
  | "tradingStartTime"
  | "tradingEndTime"
  | "dailyProfitTarget"
  | "dailyLossLimit";

const KEY_TYPES: Record<MutableConfigKeys, "number" | "integer" | "boolean" | "string" | "stringArray" | "orderType" | "numberOrNull"> = {
  scanIntervalMs:            "integer",
  enable5m:                  "boolean",
  enable15m:                 "boolean",
  maxTimeRemaining5m:        "integer",
  maxTimeRemaining15m:       "integer",
  dumpLookbackSeconds:       "integer",
  dumpThresholdPercent:      "number",
  dumpEntryMaxPrice:         "number",
  sumTarget:                 "number",
  hedgeTimeoutSeconds:       "integer",
  enableDca:                 "boolean",
  dcaThresholdPercent:       "number",
  maxDcaCount:               "integer",
  fillPollIntervalMs:        "integer",
  stopLossRemainingSeconds:  "integer",
  orderType:                 "orderType",
  numSlots:                  "integer",
  slotInitialUsd:            "number",
  slotProfitMultiplier:      "number",
  enableCompounding:         "boolean",
  shadowMode:                "boolean",
  targetAssets:              "stringArray",
  tradingStartTime:          "string",
  tradingEndTime:            "string",
  dailyProfitTarget:         "numberOrNull",
  dailyLossLimit:            "numberOrNull",
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
            coerced = raw.split(",").map((s: string) => s.trim()).filter(Boolean);
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

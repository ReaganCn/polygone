/**
 * index.ts
 *
 * Entry point. Bootstraps all modules in order:
 *   1. Log startup info
 *   2. Initialise slot machine
 *   3. Initialise Polymarket CLOB client (skipped in shadow mode)
 *   4. Start Express control panel
 *   5. Start scanner loop
 *
 * Graceful shutdown on SIGINT / SIGTERM.
 */

import { CONFIG } from "./config.js";
import { log } from "./logger.js";
import { initialiseSlots } from "./slots.js";
import { initialiseClobClient } from "./polymarket.js";
import { startScanner, stopScanner } from "./scanner.js";
import { startApiServer } from "./api.js";
import { handleQualifyingMarket } from "./trader.js";

async function main(): Promise<void> {
  log.info("BOT_STARTED", {
    message: "Polymarket crypto up/down bot starting...",
    shadowMode: CONFIG.shadowMode,
    targetAssets: CONFIG.targetAssets,
    marketDurations: CONFIG.marketDurations,
    priceRange: { min: CONFIG.priceRangeMin, max: CONFIG.priceRangeMax },
    fallback: {
      timeRemainingS: CONFIG.fallbackTimeRemainingS,
      maxPrice: CONFIG.fallbackMaxPrice,
    },
    numSlots: CONFIG.numSlots,
    slotInitialUsd: CONFIG.slotInitialUsd,
    slotProfitMultiplier: CONFIG.slotProfitMultiplier,
    orderType: CONFIG.orderType,
    scanIntervalMs: CONFIG.scanIntervalMs,
    logFile: CONFIG.logFilePath,
  });

  // 1. Initialise slots
  initialiseSlots();

  // 2. Initialise CLOB client (not needed for shadow mode but we init anyway
  //    so credentials are derived and printed for easy copy into .env)
  if (!CONFIG.shadowMode) {
    log.info("INFO", { message: "Live mode — initialising CLOB client..." });
    await initialiseClobClient();
  } else {
    log.info("INFO", {
      message: "Shadow mode enabled — no real orders will be placed.",
      note: "Market resolution is polled from the real Gamma API for accuracy.",
    });
    // Still try to init for credential derivation (useful to print keys)
    try {
      await initialiseClobClient();
    } catch (err) {
      log.warn("WARN", {
        message: "CLOB client init skipped in shadow mode (wallet config incomplete).",
        detail: (err as Error).message,
      });
    }
  }

  // 3. Start control panel API
  startApiServer();

  // 4. Start scanner
  startScanner(handleQualifyingMarket);

  log.info("BOT_STARTED", {
    message: "Bot is running. Use the control panel to monitor and adjust.",
    controlPanel: `http://127.0.0.1:${CONFIG.apiPort}`,
  });
}

// ─── graceful shutdown ────────────────────────────────────────────────────────

function shutdown(signal: string): void {
  log.info("INFO", { message: `Received ${signal} — shutting down gracefully...` });
  stopScanner();
  log.info("INFO", { message: "Scanner stopped. Active bet resolution pollers will drain." });
  // Give pollers 3 seconds to finish their current tick, then exit.
  setTimeout(() => {
    log.info("INFO", { message: "Shutdown complete." });
    process.exit(0);
  }, 3000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ─── run ──────────────────────────────────────────────────────────────────────

main().catch((err: Error) => {
  log.error("ERROR", { message: "Fatal startup error", error: err.message, stack: err.stack });
  process.exit(1);
});

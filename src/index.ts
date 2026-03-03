/**
 * index.ts
 *
 * Entry point. Bootstraps all modules in order:
 *   1. Log startup info
 *   2. Initialise slot machine
 *   3. Initialise Polymarket CLOB client (skipped/warned in shadow mode)
 *   4. Start Express control panel
 *   5. Start WebSocket-driven scanner
 *
 * Graceful shutdown on SIGINT / SIGTERM.
 */

import { CONFIG } from "./config.js";
import { log } from "./logger.js";
import { initialiseSlots } from "./slots.js";
import { initialiseClobClient } from "./polymarket.js";
import { startScanner, stopScanner } from "./scanner.js";
import { startApiServer } from "./api.js";
import { handleQualifyingMarket, handleWsResolution } from "./trader.js";

async function main(): Promise<void> {
  log.info("BOT_STARTED", {
    message: "Polymarket crypto up/down bot starting...",
    shadowMode: CONFIG.shadowMode,
    targetAssets: CONFIG.targetAssets,
    marketDurations: CONFIG.maxTimeRemaining15m,
    priceRange: { min: CONFIG.priceRangeMin15m, max: CONFIG.priceRangeMax15m },
    fallback: {
      timeRemainingS: CONFIG.fallbackTimeRemaining15m,
      maxPrice: CONFIG.fallbackMaxPrice,
    },
    numSlots: CONFIG.numSlots,
    slotInitialUsd: CONFIG.slotInitialUsd,
    slotProfitMultiplier: CONFIG.slotProfitMultiplier,
    orderType: CONFIG.orderType,
    logFile: CONFIG.logFilePath,
    mode: "websocket",
  });

  // 1. Initialise slots
  initialiseSlots();

  // 2. Initialise CLOB client
  if (!CONFIG.shadowMode) {
    log.info("INFO", { message: "Live mode — initialising CLOB client..." });
    await initialiseClobClient();
  } else {
    log.info("INFO", {
      message: "Shadow mode — no real orders will be placed.",
      note: "Market resolution comes from WebSocket market_resolved events + fallback HTTP poll.",
    });
    try {
      await initialiseClobClient();
    } catch (err) {
      log.warn("WARN", {
        message: "CLOB client init skipped in shadow mode (wallet config incomplete).",
        detail: (err as Error).message,
      });
    }
  }

  // 3. Start control panel
  startApiServer();

  // 4. Start WebSocket-driven scanner
  await startScanner(handleQualifyingMarket, handleWsResolution);

  log.info("BOT_STARTED", {
    message: "Bot is running.",
    controlPanel: `http://127.0.0.1:${CONFIG.apiPort}`,
    note: "Price updates arrive via WebSocket. Heartbeat HTTP fetch keeps market list fresh.",
  });
}

// ─── graceful shutdown ────────────────────────────────────────────────────────

function shutdown(signal: string): void {
  log.info("INFO", { message: `Received ${signal} — shutting down gracefully...` });
  stopScanner();
  setTimeout(() => {
    log.info("INFO", { message: "Shutdown complete." });
    process.exit(0);
  }, 3000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((err: Error) => {
  log.error("ERROR", {
    message: "Fatal startup error",
    error: err.message,
    stack: err.stack,
  });
  process.exit(1);
});
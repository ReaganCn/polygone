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
import { sweepUnredeemedPositions } from "./redeemer.js";
import { getSummary, resetAllSlots } from "./slots.js";
import { notifyDailySummary } from "./telegram.js";

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

  // 3. Sweep any unredeemed winning positions from previous sessions
  await sweepUnredeemedPositions();

  // 4. Start control panel
  startApiServer();

  // 5. Start WebSocket-driven scanner
  await startScanner(handleQualifyingMarket, handleWsResolution);

  log.info("BOT_STARTED", {
    message: "Bot is running.",
    controlPanel: `http://127.0.0.1:${CONFIG.apiPort}`,
    note: "Price updates arrive via WebSocket. Heartbeat HTTP fetch keeps market list fresh.",
  });

  // 6. Schedule daily slot reset + Telegram summary at midnight UTC
  scheduleDailyReset();

  // 7. Purge logs older than 24 h — run immediately then every hour
  log.cleanup();
  setInterval(() => log.cleanup(), 60 * 60 * 1000).unref();
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

// ─── daily reset ─────────────────────────────────────────────────────────────

function runDailyReset(): void {
  const summary = getSummary();
  notifyDailySummary({
    totalTrades:          summary.totalTrades,
    totalWins:            summary.totalWins,
    totalLosses:          summary.totalLosses,
    totalStopLosses:      summary.totalStopLosses,
    winRate:              summary.winRate,
    netPnl:               Math.round((summary.totalProfitExtracted - summary.totalLost) * 100) / 100,
    totalProfitExtracted: summary.totalProfitExtracted,
    totalLost:            summary.totalLost,
  });
  log.info("TELEGRAM_DAILY_SUMMARY", { message: "Daily summary sent to Telegram." });

  const resetCount = resetAllSlots();
  log.info("INFO", {
    message: `Daily reset complete: ${resetCount} idle slot(s) reset to $${CONFIG.slotInitialUsd}.`,
    resetCount,
  });

  log.cleanup();
}

/**
 * Schedules runDailyReset() at the next midnight UTC, then every 24 hours.
 * Uses unref() so the timer does not prevent graceful shutdown.
 */
function scheduleDailyReset(): void {
  const now     = Date.now();
  const todayUTC = new Date(now);
  const nextMidnightUTC = Date.UTC(
    todayUTC.getUTCFullYear(),
    todayUTC.getUTCMonth(),
    todayUTC.getUTCDate() + 1,
    0, 0, 0, 0,
  );
  const msUntilMidnight = nextMidnightUTC - now;

  log.info("INFO", {
    message: "Daily reset scheduled.",
    nextResetAt: new Date(nextMidnightUTC).toISOString(),
    inMinutes:   Math.round(msUntilMidnight / 60_000),
  });

  const t = setTimeout(() => {
    runDailyReset();
    setInterval(runDailyReset, 24 * 60 * 60 * 1000).unref();
  }, msUntilMidnight);
  t.unref();
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
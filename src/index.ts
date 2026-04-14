/**
 * index.ts
 *
 * Entry point. Bootstraps all modules in order:
 *   1. Log startup info
 *   2. Initialise slot machine
 *   3. Initialise Polymarket CLOB client (skipped/warned in shadow mode)
 *   4. Start Express control panel
 *   5. Start WebSocket-driven scanner
 *   6. Start supervisor loop (trading hours + daily P&L limits)
 *
 * Graceful shutdown on SIGINT / SIGTERM.
 *
 * CHANGE (scheduler):
 *   supervisorTick() runs every 60s. It pauses/resumes the scanner based on:
 *     - Trading hours: CONFIG.tradingStartTime / tradingEndTime (UTC "HH:MM")
 *     - Daily P&L:     CONFIG.dailyProfitTarget / dailyLossLimit (USDC)
 *   dailyState.startOfDayPnl is reset at UTC midnight.
 */

import { CONFIG } from "./config.js";
import { log } from "./logger.js";
import { initialiseSlots, getSummary, resetSlots } from "./slots.js";
import { initialiseClobClient } from "./polymarket.js";
import { startScanner, stopScanner, pauseScanner, resumeScanner, isPausedState } from "./scanner.js";
import { startApiServer } from "./api.js";
import { handleQualifyingMarket, handleWsResolution, initTrader } from "./trader.js";
import { dailyState } from "./dailyState.js";
import { startRedemptionQueue, stopRedemptionQueue } from "./redemptionQueue.js";
import { sendTelegramAlert, formatStatusMessage } from "./telegram.js";

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
    tradingHours: `${CONFIG.tradingStartTime}–${CONFIG.tradingEndTime} UTC`,
    dailyProfitTarget: CONFIG.dailyProfitTarget,
    dailyLossLimit: CONFIG.dailyLossLimit,
    mode: "websocket",
  });

  // 1. Initialise slots
  initialiseSlots();

  // 2. Initialise trader (wires early-close price callback from scanner)
  initTrader();

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

  // 4. Start redemption queue (loads pending entries from disk)
  startRedemptionQueue();

  // 5. Run supervisor BEFORE scanner to establish pause state first.
  //    This prevents the race condition where the scanner fires bets
  //    before the supervisor has a chance to pause it.
  supervisorTick();
  setInterval(supervisorTick, 60_000);

  // 6. Start WebSocket-driven scanner (pause state already set)
  await startScanner(handleQualifyingMarket, handleWsResolution, isPausedState());

  log.info("BOT_STARTED", {
    message: "Bot is running.",
    controlPanel: `http://127.0.0.1:${CONFIG.apiPort}`,
    note: "Price updates arrive via WebSocket. Heartbeat HTTP fetch keeps market list fresh.",
  });
}

// ─── supervisor ───────────────────────────────────────────────────────────────

let lastSeenUtcDate = new Date().getUTCDate();
let pendingFinalPauseMessage = false;

function supervisorTick(): void {
  const summary = getSummary();
  const netPnl = round2(summary.totalProfitExtracted - summary.totalLost);

  // Reset daily P&L baseline at UTC midnight
  const todayUtcDate = new Date().getUTCDate();
  if (todayUtcDate !== lastSeenUtcDate) {
    lastSeenUtcDate = todayUtcDate;

    // Reset slots first so summary reflects fresh day values.
    resetSlots();
    dailyState.startOfDayPnl = 0;

    // Clean up old log files (>24 hours)
    log.cleanup(24 * 60 * 60 * 1000);

    // Send new-day reset summary (values should be reset for the day).
    const resetSummary = getSummary();
    const resetMessage = formatStatusMessage(resetSummary, {
      tradingWindowStart: CONFIG.tradingStartTime,
      tradingWindowEnd: CONFIG.tradingEndTime,
      dailyNetPnl: 0,
      dailyProfitTarget: CONFIG.dailyProfitTarget,
      dailyLossLimit: CONFIG.dailyLossLimit,
    }, {
      paused: isPausedState(),
      shadowMode: CONFIG.shadowMode,
    });
    sendTelegramAlert(resetMessage).catch(() => {});
    pendingFinalPauseMessage = false;

    log.info("INFO", { message: "UTC midnight — daily reset complete. Slots, PnL, trades zeroed." });
  }

  // Recompute after potential reset
  const summaryNow = getSummary();
  const netPnlNow = round2(summaryNow.totalProfitExtracted - summaryNow.totalLost);
  const netPnlToday = round2(netPnlNow - dailyState.startOfDayPnl);

  const withinHours = isWithinTradingHours();
  const profitHit   = CONFIG.dailyProfitTarget !== null && netPnlToday >= CONFIG.dailyProfitTarget;
  const lossHit     = CONFIG.dailyLossLimit    !== null && netPnlToday <= -CONFIG.dailyLossLimit;

  const shouldPause = !withinHours || profitHit || lossHit;

  if (shouldPause && !isPausedState()) {
    const reason = !withinHours
      ? "outside_trading_hours"
      : profitHit
        ? "daily_profit_target_reached"
        : "daily_loss_limit_reached";
    log.info("BOT_PAUSED", { reason, netPnlToday, withinHours });
    pauseScanner();

    // Send Telegram alert on pause
    const pauseMessage = formatStatusMessage(summaryNow, {
      tradingWindowStart: CONFIG.tradingStartTime,
      tradingWindowEnd: CONFIG.tradingEndTime,
      dailyNetPnl: netPnlToday,
      dailyProfitTarget: CONFIG.dailyProfitTarget,
      dailyLossLimit: CONFIG.dailyLossLimit,
    }, {
      paused: true,
      shadowMode: CONFIG.shadowMode,
    });
    sendTelegramAlert(pauseMessage).catch(() => {});
    if (summaryNow.activeSlots > 0) pendingFinalPauseMessage = true;
  } else if (!shouldPause && isPausedState()) {
    log.info("BOT_RESUMED", { message: "Conditions met — resuming.", netPnlToday, withinHours });
    resumeScanner();
    pendingFinalPauseMessage = false;
  }

  // If there were active bets when the bot paused, send a final status message
  // once they have all settled — giving the complete picture.
  if (isPausedState() && pendingFinalPauseMessage) {
    const settledSummary = getSummary();
    if (settledSummary.activeSlots === 0) {
      const settledNetPnl = round2(settledSummary.totalProfitExtracted - settledSummary.totalLost);
      const settledNetPnlToday = round2(settledNetPnl - dailyState.startOfDayPnl);
      const finalMessage =
        "=== ALL TRADES SETTLED ===\n" +
        formatStatusMessage(settledSummary, {
          tradingWindowStart: CONFIG.tradingStartTime,
          tradingWindowEnd: CONFIG.tradingEndTime,
          dailyNetPnl: settledNetPnlToday,
          dailyProfitTarget: CONFIG.dailyProfitTarget,
          dailyLossLimit: CONFIG.dailyLossLimit,
        }, { paused: true, shadowMode: CONFIG.shadowMode });
      sendTelegramAlert(finalMessage).catch(() => {});
      pendingFinalPauseMessage = false;
      log.info("BOT_PAUSED_FINAL_STATUS_SENT", { settledNetPnlToday });
    }
  }
}

function isWithinTradingHours(): boolean {
  const now = new Date();
  const current = `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;
  return current >= CONFIG.tradingStartTime && current <= CONFIG.tradingEndTime;
}

// ─── graceful shutdown ────────────────────────────────────────────────────────

function shutdown(signal: string): void {
  log.info("INFO", { message: `Received ${signal} — shutting down gracefully...` });
  stopScanner();
  stopRedemptionQueue();
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

// ─── helpers ─────────────────────────────────────────────────────────────────

function round2(n: number): number { return Math.round(n * 100) / 100; }
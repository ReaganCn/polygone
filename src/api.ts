/**
 * api.ts — Express REST API for local bot control.
 * Localhost only — no authentication.
 *
 * Endpoints:
 *   GET  /status                   Full state, P&L summary, per-rule breakdown
 *   GET  /config                   Current config (sensitive fields redacted)
 *   POST /config                   Hot-update mutable config fields
 *   POST /pause / /resume          Pause/resume new bets
 *   GET  /logs?tail=N&cat=...      Last N log lines
 *   GET  /logs/files               List all log files
 *
 * CHANGE (scheduler):
 *   /status now includes a `scheduler` block with trading window,
 *   today's net P&L, and the configured daily thresholds.
 */

import express, { Request, Response } from "express";
import { CONFIG, updateConfig } from "./config.js";
import { log } from "./logger.js";
import { getSnapshot, getActiveBets, getSummary } from "./slots.js";
import { pauseScanner, resumeScanner, isPausedState } from "./scanner.js";
import { dailyState } from "./dailyState.js";
import { getRedemptionStatus } from "./redemptionQueue.js";
import type { MutableConfigKeys } from "./config.js";

export function startApiServer(): void {
  const app = express();
  app.use(express.json());

  // ── GET /status ─────────────────────────────────────────────────────────────
  app.get("/status", (_req: Request, res: Response) => {
    const snapshot = getSnapshot();
    const summary  = getSummary();

    const initialCapital = round2(CONFIG.numSlots * CONFIG.slotInitialUsd);
    const unrealisedGain = round2(Math.max(0, summary.totalBalance - initialCapital));
    const netPnl         = round2(summary.totalProfitExtracted - summary.totalLost + unrealisedGain);
    const netPnlToday    = round2(netPnl - dailyState.startOfDayPnl);

    const activeBets = getActiveBets().map((b) => ({
      betId: b.betId,
      slotId: b.slotId,
      marketId: b.market.id,
      question: b.market.question,
      asset: b.market.asset,
      duration: b.market.duration,
      side: b.side,
      stakeUsd: b.stakeUsd,
      expectedPayoutUsd: b.expectedPayoutUsd,
      priceAtBet: b.priceAtBet,
      placedAt: b.placedAt,
      closesAt: b.market.closesAt,
      orderId: b.orderId,
      shadow: b.shadow,
      rule: b.rule,
    }));

    res.json({
      timestamp:  new Date().toISOString(),
      shadowMode: CONFIG.shadowMode,
      paused:     isPausedState(),

      summary: {
        // Slots
        totalSlots:  summary.totalSlots,
        activeSlots: summary.activeSlots,
        idleSlots:   summary.idleSlots,

        // P&L
        initialCapital,
        currentBalance:       summary.totalBalance,
        profitExtracted:      summary.totalProfitExtracted,
        totalLost:            summary.totalLost,
        unrealisedGain,
        netPnl,

        // Overall trade stats
        totalWins:    summary.totalWins,
        totalLosses:  summary.totalLosses,
        totalTrades:  summary.totalTrades,
        winRate:      summary.winRate,
        avgWinAmount: summary.avgWinAmount,

        // Per-rule breakdown (5m / 15m / fallback)
        byRule: summary.byRule,
      },

      scheduler: {
        tradingWindow: {
          start: CONFIG.tradingStartTime,
          end:   CONFIG.tradingEndTime,
        },
        dailyNetPnl:       netPnlToday,
        dailyProfitTarget: CONFIG.dailyProfitTarget,
        dailyLossLimit:    CONFIG.dailyLossLimit,
      },

      slots: snapshot,
      activeBets,
    });
  });

  // ── GET /config ─────────────────────────────────────────────────────────────
  app.get("/config", (_req: Request, res: Response) => {
    const { privateKey, polyApiKey, polySecret, polyPassphrase, ...safe } = CONFIG;
    res.json({
      ...safe,
      privateKey:     "[REDACTED]",
      polyApiKey:     polyApiKey     ? "[SET]" : "[NOT SET]",
      polySecret:     polySecret     ? "[SET]" : "[NOT SET]",
      polyPassphrase: polyPassphrase ? "[SET]" : "[NOT SET]",
    });
  });

  // ── POST /config ─────────────────────────────────────────────────────────────
  app.post("/config", (req: Request, res: Response) => {
    const patch = req.body as Partial<Record<MutableConfigKeys, unknown>>;

    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      res.status(400).json({ error: "Body must be a JSON object." });
      return;
    }

    const { updated, errors } = updateConfig(patch);

    if (updated.length === 0 && Object.keys(errors).length === 0) {
      res.status(400).json({
        error: "No recognised mutable config keys in body.",
        mutableKeys: [
          "scanIntervalMs",
          "enable5m", "enable15m", "enableFallback",
          "priceRangeMin5m", "priceRangeMax5m",
          "priceRangeMin15m", "priceRangeMax15m",
          "maxTimeRemaining5m", "maxTimeRemaining15m",
          "fallbackTimeRemaining5m", "fallbackTimeRemaining15m",
          "fallbackMinPrice", "fallbackMaxPrice",
          "orderType",
          "numSlots", "slotInitialUsd", "slotProfitMultiplier",
          "shadowMode", "targetAssets",
          "tradingStartTime", "tradingEndTime",
          "dailyProfitTarget", "dailyLossLimit",
        ],
        examples: {
          "set trading hours":         { tradingStartTime: "09:00", tradingEndTime: "17:00" },
          "set daily profit target":   { dailyProfitTarget: 50 },
          "set daily loss limit":      { dailyLossLimit: 20 },
          "disable daily profit cap":  { dailyProfitTarget: null },
          "disable 5m markets":        { enable5m: false },
          "set 15m price range":       { priceRangeMin15m: 0.96, priceRangeMax15m: 0.99 },
        },
      });
      return;
    }

    if (updated.length > 0) {
      const newValues: Record<string, unknown> = {};
      for (const k of updated) newValues[k] = (CONFIG as unknown as Record<string, unknown>)[k];
      log.info("CONFIG_UPDATED", { updatedKeys: updated, newValues });
    }

    res.json({
      success: updated.length > 0,
      updated,
      errors,
      message: updated.length > 0 ? `Updated: ${updated.join(", ")}` : "No fields updated.",
    });
  });

  // ── POST /pause ──────────────────────────────────────────────────────────────
  app.post("/pause", (_req: Request, res: Response) => {
    if (isPausedState()) { res.json({ message: "Already paused." }); return; }
    pauseScanner();
    res.json({ success: true, message: "Paused. Active bets will still resolve." });
  });

  // ── POST /resume ─────────────────────────────────────────────────────────────
  app.post("/resume", (_req: Request, res: Response) => {
    if (!isPausedState()) { res.json({ message: "Already running." }); return; }
    resumeScanner();
    res.json({ success: true, message: "Resumed." });
  });

  // ── GET /logs ────────────────────────────────────────────────────────────────
  app.get("/logs", (req: Request, res: Response) => {
    const n = parseInt((req.query["tail"] as string) ?? "100", 10);
    if (isNaN(n) || n < 1 || n > 10000) {
      res.status(400).json({ error: "tail must be 1–10000." });
      return;
    }
    const validCategories = ["trades", "errors", "system"] as const;
    type LogCat = typeof validCategories[number];
    const cat = (req.query["cat"] as string | undefined) ?? "trades";
    const category: LogCat = validCategories.includes(cat as LogCat) ? (cat as LogCat) : "trades";
    const entries = log.tail(n, category);
    res.json({ category, count: entries.length, entries });
  });

  // ── GET /logs/files ───────────────────────────────────────────────────────────
  app.get("/logs/files", (_req: Request, res: Response) => {
    res.json({ files: log.listFiles() });
  });

  // ── GET /redemptions ────────────────────────────────────────────────────────
  app.get("/redemptions", (_req: Request, res: Response) => {
    const entries = getRedemptionStatus();
    const pending = entries.filter(e => e.status === "pending" || e.status === "processing").length;
    const completed = entries.filter(e => e.status === "completed").length;
    const failed = entries.filter(e => e.status === "failed").length;
    res.json({ summary: { total: entries.length, pending, completed, failed }, entries });
  });

  app.listen(CONFIG.apiPort, "127.0.0.1", () => {
    log.info("BOT_STARTED", {
      message: `Control panel on http://127.0.0.1:${CONFIG.apiPort}`,
      endpoints: [
        "GET  /status",
        "GET  /config",
        "POST /config",
        "POST /pause",
        "POST /resume",
        "GET  /logs?tail=N&cat=trades|errors|system",
        "GET  /logs/files",
        "GET  /redemptions",
      ],
    });
  });
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
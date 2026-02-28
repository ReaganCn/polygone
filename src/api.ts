/**
 * api.ts
 *
 * Express REST API for local bot control.
 * Localhost only — no authentication needed.
 *
 * Endpoints:
 *   GET  /status                   Bot state, slots, active bets, P&L summary
 *   GET  /config                   Current config (sensitive fields redacted)
 *   POST /config                   Hot-update mutable config fields
 *   POST /pause                    Pause new bets
 *   POST /resume                   Resume bot
 *   GET  /logs?tail=N&cat=trades   Last N lines from trades|errors|system log
 *   GET  /logs/files               List all log files
 *
 * P&L note:
 *   netPnl = totalProfitExtracted + unrealisedPnl
 *   unrealisedPnl = (currentTotalBalance - initialCapital)
 *   initialCapital = numSlots × slotInitialUsd
 */

import express, { Request, Response } from "express";
import { CONFIG, updateConfig } from "./config.js";
import { log } from "./logger.js";
import { getSnapshot, getActiveBets, getSummary } from "./slots.js";
import { pauseScanner, resumeScanner, isPausedState } from "./scanner.js";
import type { MutableConfigKeys } from "./config.js";

export function startApiServer(): void {
  const app = express();
  app.use(express.json());

  // ── GET /status ─────────────────────────────────────────────────────────────
  app.get("/status", (_req: Request, res: Response) => {
    const snapshot = getSnapshot();
    const summary = getSummary();

    // Net P&L calculation:
    //   initialCapital  = how much money the bot started with across all slots
    //   currentBalance  = what's sitting in slots right now (unrealised)
    //   profitExtracted = profits already pulled out and "banked"
    //   netPnl          = extracted + unrealised gain/loss in current balances
    const initialCapital = round2(CONFIG.numSlots * CONFIG.slotInitialUsd);
    const unrealisedPnl = round2(summary.totalBalance - initialCapital);
    const netPnl = round2(summary.totalProfitExtracted + unrealisedPnl);

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
    }));

    res.json({
      timestamp: new Date().toISOString(),
      shadowMode: CONFIG.shadowMode,
      paused: isPausedState(),
      pnl: {
        initialCapital,
        currentBalance: summary.totalBalance,
        profitExtracted: summary.totalProfitExtracted,
        unrealisedPnl,
        netPnl,
        totalWins: summary.totalWins,
        totalLosses: summary.totalLosses,
        winRate: summary.winRate,
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
      privateKey: "[REDACTED]",
      polyApiKey: polyApiKey ? "[SET]" : "[NOT SET]",
      polySecret: polySecret ? "[SET]" : "[NOT SET]",
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
          "scanIntervalMs", "priceRangeMin", "priceRangeMax",
          "fallbackTimeRemainingS", "fallbackMaxPrice", "orderType",
          "numSlots", "slotInitialUsd", "slotProfitMultiplier",
          "shadowMode", "targetAssets", "marketDurations",
        ],
        example: { priceRangeMin: 0.92, shadowMode: false, targetAssets: ["BTC", "ETH"] },
      });
      return;
    }

    if (updated.length > 0) {
      // Build a map of key → new coerced value for the log
      const newValues: Record<string, unknown> = {};
      for (const k of updated) newValues[k] = (CONFIG as unknown as Record<string, unknown>)[k];
      log.info("CONFIG_UPDATED", { updatedKeys: updated, newValues });
    }

    res.json({
      success: updated.length > 0,
      updated,
      errors,
      message: updated.length > 0
        ? `Updated: ${updated.join(", ")}`
        : "No fields were updated.",
    });
  });

  // ── POST /pause ──────────────────────────────────────────────────────────────
  app.post("/pause", (_req: Request, res: Response) => {
    if (isPausedState()) {
      res.json({ message: "Already paused." });
      return;
    }
    pauseScanner();
    res.json({ success: true, message: "Paused. Active bets will still resolve." });
  });

  // ── POST /resume ─────────────────────────────────────────────────────────────
  app.post("/resume", (_req: Request, res: Response) => {
    if (!isPausedState()) {
      res.json({ message: "Already running." });
      return;
    }
    resumeScanner();
    res.json({ success: true, message: "Resumed." });
  });

  // ── GET /logs ────────────────────────────────────────────────────────────────
  app.get("/logs", (req: Request, res: Response) => {
    const tailParam = req.query["tail"];
    const catParam = req.query["cat"] as string | undefined;
    const n = tailParam ? parseInt(tailParam as string, 10) : 100;

    if (isNaN(n) || n < 1 || n > 10000) {
      res.status(400).json({ error: "tail must be 1–10000." });
      return;
    }

    const validCategories = ["trades", "errors", "system"] as const;
    type LogCat = typeof validCategories[number];
    const category: LogCat = validCategories.includes(catParam as LogCat)
      ? (catParam as LogCat)
      : "trades";

    const entries = log.tail(n, category);
    res.json({ category, count: entries.length, entries });
  });

  // ── GET /logs/files ───────────────────────────────────────────────────────────
  app.get("/logs/files", (_req: Request, res: Response) => {
    res.json({ files: log.listFiles() });
  });

  // ── start ────────────────────────────────────────────────────────────────────
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
      ],
    });
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
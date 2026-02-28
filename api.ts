/**
 * api.ts
 *
 * Lightweight Express REST API for local bot control.
 * No authentication — intended for localhost use only.
 *
 * Endpoints:
 *   GET  /status          — All slot states, active bets, summary P&L, bot state
 *   GET  /config          — Current runtime config (sensitive keys redacted)
 *   POST /config          — Hot-update mutable config fields
 *   POST /pause           — Stop scanner from placing new bets
 *   POST /resume          — Resume scanner
 *   GET  /logs?tail=N     — Last N log lines (default 100)
 */

import express, { Request, Response } from "express";
import { CONFIG, updateConfig } from "./config.js";
import { log } from "./logger.js";
import { getSnapshot, getActiveBets, getSummary } from "./slots.js";
import { pauseScanner, resumeScanner, isPausedState } from "./scanner.js";
import type { MutableConfigKeys } from "./config.js";

// ─── server setup ─────────────────────────────────────────────────────────────

export function startApiServer(): void {
  const app = express();
  app.use(express.json());

  // ── GET /status ─────────────────────────────────────────────────────────────
  app.get("/status", (_req: Request, res: Response) => {
    const snapshot = getSnapshot();
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
      summary: getSummary(),
      slots: snapshot,
      activeBets,
    });
  });

  // ── GET /config ─────────────────────────────────────────────────────────────
  app.get("/config", (_req: Request, res: Response) => {
    // Return the full config but redact sensitive wallet fields
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

    if (!patch || typeof patch !== "object") {
      res.status(400).json({ error: "Body must be a JSON object." });
      return;
    }

    const updated = updateConfig(patch);

    if (updated.length === 0) {
      res.status(400).json({
        error: "No valid mutable config keys found in the request body.",
        mutableKeys: [
          "scanIntervalMs", "priceRangeMin", "priceRangeMax",
          "fallbackTimeRemainingS", "fallbackMaxPrice", "orderType",
          "numSlots", "slotInitialUsd", "slotProfitMultiplier",
          "shadowMode", "targetAssets", "marketDurations",
        ],
      });
      return;
    }

    log.info("CONFIG_UPDATED", { updatedKeys: updated, newValues: patch });

    res.json({
      success: true,
      updatedKeys: updated,
      message: `Updated: ${updated.join(", ")}`,
    });
  });

  // ── POST /pause ──────────────────────────────────────────────────────────────
  app.post("/pause", (_req: Request, res: Response) => {
    if (isPausedState()) {
      res.json({ message: "Already paused." });
      return;
    }
    pauseScanner();
    res.json({ success: true, message: "Bot paused. Active bets will still resolve normally." });
  });

  // ── POST /resume ─────────────────────────────────────────────────────────────
  app.post("/resume", (_req: Request, res: Response) => {
    if (!isPausedState()) {
      res.json({ message: "Bot is already running." });
      return;
    }
    resumeScanner();
    res.json({ success: true, message: "Bot resumed." });
  });

  // ── GET /logs ────────────────────────────────────────────────────────────────
  app.get("/logs", (req: Request, res: Response) => {
    const tailParam = req.query["tail"];
    const n = tailParam ? parseInt(tailParam as string, 10) : 100;

    if (isNaN(n) || n < 1 || n > 10000) {
      res.status(400).json({ error: "tail must be a number between 1 and 10000." });
      return;
    }

    const entries = log.tail(n);
    res.json({ count: entries.length, entries });
  });

  // ── start listening ──────────────────────────────────────────────────────────
  app.listen(CONFIG.apiPort, "127.0.0.1", () => {
    log.info("BOT_STARTED", {
      message: `Control panel listening on http://127.0.0.1:${CONFIG.apiPort}`,
      endpoints: [
        "GET  /status",
        "GET  /config",
        "POST /config",
        "POST /pause",
        "POST /resume",
        "GET  /logs?tail=N",
      ],
    });
  });
}

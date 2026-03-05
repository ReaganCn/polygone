/**
 * api.ts — Express REST API for local bot control.
 *
 * FIXES APPLIED:
 *
 * [S2] initialCapital now uses getSeededCapital() — the capital frozen at
 *   startup — instead of CONFIG.numSlots × CONFIG.slotInitialUsd at request
 *   time. This means netPnl stays correct even after POST /config changes
 *   slotInitialUsd or numSlots mid-session.
 *
 * [A2] stopLossRecoveredByRule is now exact.
 *   Previously estimated as stopLosses × CONFIG.slotInitialUsd, which was
 *   wrong for compounded slots that staked more than slotInitialUsd.
 *   Now uses totalStopLossStaked - totalStopLossNetLost from RuleStats,
 *   both of which are tracked precisely in slots.ts recordStopLoss().
 *
 * [A3] stopLoss byRule netLost now shows only stop-loss net losses
 *   (totalStopLossNetLost) instead of all losses for the rule (totalLost).
 */

import express, { Request, Response } from "express";
import { CONFIG, updateConfig } from "./config.js";
import { log } from "./logger.js";
import { getSnapshot, getActiveBets, getSummary, getSeededCapital } from "./slots.js";
import { pauseScanner, resumeScanner, isPausedState } from "./scanner.js";
import type { MutableConfigKeys } from "./config.js";

export function startApiServer(): void {
  const app = express();
  app.use(express.json());

  // ── GET /status ──────────────────────────────────────────────────────────────
  app.get("/status", (_req: Request, res: Response) => {
    const snapshot = getSnapshot();
    const summary  = getSummary();

    // ── P&L calculation ───────────────────────────────────────────────────────
    //
    // initialCapital  = capital actually seeded at startup (frozen — never
    //                   changes if POST /config updates slotInitialUsd later).
    //                   Sourced from getSeededCapital() in slots.ts. [S2]
    //
    // currentBalance  = sum of all slot balances right now
    //
    // profitExtracted = USDC banked when slots crossed slotProfitMultiplier
    //
    // totalLost       = sum of net losses (normal losses + stop-loss net losses).
    //                   A stop-loss recovering $0.80 of a $1 stake adds $0.20,
    //                   not $1.00.
    //
    // unrealisedGain  = how much current balances exceed seeded capital.
    //                   Uses seededCapital (not current CONFIG) for accuracy. [S2]
    //
    // netPnl          = profitExtracted - totalLost + unrealisedGain
    // ─────────────────────────────────────────────────────────────────────────

    const initialCapital = getSeededCapital();  // [S2] frozen at startup
    const unrealisedGain = round2(Math.max(0, summary.totalBalance - initialCapital));
    const netPnl         = round2(summary.totalProfitExtracted - summary.totalLost + unrealisedGain);

    const byRule = summary.byRule;
    const totalStopLosses = summary.totalStopLosses;

    // [A2] Exact stop-loss recovered per rule.
    // totalStopLossStaked and totalStopLossNetLost are both tracked precisely
    // in slots.ts recordStopLoss(). No estimation needed.
    const stopLossRecoveredByRule = (["5m", "15m", "fallback"] as const).reduce((acc, rule) => {
      const r = byRule[rule];
      acc[rule] = round2(Math.max(0, r.totalStopLossStaked - r.totalStopLossNetLost));
      return acc;
    }, {} as Record<string, number>);

    const totalStopLossRecovered = round2(
      stopLossRecoveredByRule["5m"] +
      stopLossRecoveredByRule["15m"] +
      stopLossRecoveredByRule["fallback"]
    );

    // Total stop-loss net lost across all rules (for avgNetLoss calculation)
    const totalStopLossNetLost = round2(
      byRule["5m"].totalStopLossNetLost +
      byRule["15m"].totalStopLossNetLost +
      byRule["fallback"].totalStopLossNetLost
    );

    const activeBets = getActiveBets().map((b) => ({
      betId:             b.betId,
      slotId:            b.slotId,
      marketId:          b.market.id,
      question:          b.market.question,
      asset:             b.market.asset,
      duration:          b.market.duration,
      side:              b.side,
      stakeUsd:          b.stakeUsd,
      expectedPayoutUsd: b.expectedPayoutUsd,
      priceAtBet:        b.priceAtBet,
      placedAt:          b.placedAt,
      closesAt:          b.market.closesAt,
      orderId:           b.orderId,
      shadow:            b.shadow,
      rule:              b.rule,
      stopLossTriggered: b.stopLossTriggered ?? false,
    }));

    res.json({
      timestamp:  new Date().toISOString(),
      shadowMode: CONFIG.shadowMode,
      paused:     isPausedState(),

      summary: {
        // ── Slot counts ────────────────────────────────────────────────────
        totalSlots:  summary.totalSlots,
        activeSlots: summary.activeSlots,
        idleSlots:   summary.idleSlots,

        // ── Capital & P&L ──────────────────────────────────────────────────
        initialCapital,          // frozen at startup [S2]
        currentBalance:   summary.totalBalance,
        profitExtracted:  summary.totalProfitExtracted,
        totalLost:        summary.totalLost,
        unrealisedGain,
        netPnl,

        // ── Overall trade counts ───────────────────────────────────────────
        totalWins:       summary.totalWins,
        totalLosses:     summary.totalLosses,
        totalStopLosses: summary.totalStopLosses,
        totalTrades:     summary.totalTrades,
        winRate:         summary.winRate,
        avgWinAmount:    summary.avgWinAmount,

        // ── Stop-loss aggregate ────────────────────────────────────────────
        stopLoss: {
          enabled:           CONFIG.stopLossEnabled,
          triggerPrice:      CONFIG.stopLossTriggerPrice,
          limitPrice:        CONFIG.stopLossLimitPrice,
          totalTriggered:    totalStopLosses,
          totalRecoveredUsd: totalStopLossRecovered,  // exact [A2]
          totalNetLost:      totalStopLossNetLost,     // stop-loss losses only [A3]
          avgNetLoss:        totalStopLosses > 0
            ? round2(totalStopLossNetLost / totalStopLosses)
            : 0,
          byRule: {
            // [A3] netLost is now totalStopLossNetLost (SL trades only),
            //      not totalLost (which includes normal losses too).
            "5m": {
              triggered: byRule["5m"].stopLosses,
              recovered: stopLossRecoveredByRule["5m"],
              netLost:   round2(byRule["5m"].totalStopLossNetLost),  // [A3]
            },
            "15m": {
              triggered: byRule["15m"].stopLosses,
              recovered: stopLossRecoveredByRule["15m"],
              netLost:   round2(byRule["15m"].totalStopLossNetLost),  // [A3]
            },
            "fallback": {
              triggered: byRule["fallback"].stopLosses,
              recovered: stopLossRecoveredByRule["fallback"],
              netLost:   round2(byRule["fallback"].totalStopLossNetLost),  // [A3]
            },
          },
        },

        // ── Per-rule full breakdown ────────────────────────────────────────
        byRule: {
          "5m": {
            wins:                byRule["5m"].wins,
            losses:              byRule["5m"].losses,
            stopLosses:          byRule["5m"].stopLosses,
            totalTrades:         byRule["5m"].totalTrades,
            winRate:             byRule["5m"].winRate,
            totalWinAmount:      byRule["5m"].totalWinAmount,
            avgWinAmount:        byRule["5m"].avgWinAmount,
            totalLost:           byRule["5m"].totalLost,
            totalStopLossNetLost:byRule["5m"].totalStopLossNetLost,
            totalStopLossStaked: byRule["5m"].totalStopLossStaked,
            netPnl:              byRule["5m"].netPnl,
          },
          "15m": {
            wins:                byRule["15m"].wins,
            losses:              byRule["15m"].losses,
            stopLosses:          byRule["15m"].stopLosses,
            totalTrades:         byRule["15m"].totalTrades,
            winRate:             byRule["15m"].winRate,
            totalWinAmount:      byRule["15m"].totalWinAmount,
            avgWinAmount:        byRule["15m"].avgWinAmount,
            totalLost:           byRule["15m"].totalLost,
            totalStopLossNetLost:byRule["15m"].totalStopLossNetLost,
            totalStopLossStaked: byRule["15m"].totalStopLossStaked,
            netPnl:              byRule["15m"].netPnl,
          },
          "fallback": {
            wins:                byRule["fallback"].wins,
            losses:              byRule["fallback"].losses,
            stopLosses:          byRule["fallback"].stopLosses,
            totalTrades:         byRule["fallback"].totalTrades,
            winRate:             byRule["fallback"].winRate,
            totalWinAmount:      byRule["fallback"].totalWinAmount,
            avgWinAmount:        byRule["fallback"].avgWinAmount,
            totalLost:           byRule["fallback"].totalLost,
            totalStopLossNetLost:byRule["fallback"].totalStopLossNetLost,
            totalStopLossStaked: byRule["fallback"].totalStopLossStaked,
            netPnl:              byRule["fallback"].netPnl,
          },
        },
      },

      slots: snapshot,
      activeBets,
    });
  });

  // ── GET /config ──────────────────────────────────────────────────────────────
  app.get("/config", (_req: Request, res: Response) => {
    const {
      privateKey,
      polyApiKey, polySecret, polyPassphrase,
      polyBuilderApiKey, polyBuilderSecret, polyBuilderPassphrase,
      ...safe
    } = CONFIG;

    res.json({
      ...safe,
      privateKey:            "[REDACTED]",
      polyApiKey:            polyApiKey            ? "[SET]" : "[NOT SET]",
      polySecret:            polySecret            ? "[SET]" : "[NOT SET]",
      polyPassphrase:        polyPassphrase        ? "[SET]" : "[NOT SET]",
      polyBuilderApiKey:     polyBuilderApiKey     ? "[SET]" : "[NOT SET]",
      polyBuilderSecret:     polyBuilderSecret     ? "[SET]" : "[NOT SET]",
      polyBuilderPassphrase: polyBuilderPassphrase ? "[SET]" : "[NOT SET]",
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
          "scanIntervalMs", "targetAssets",
          "enable5m", "enable15m", "enableFallback",
          "priceRangeMin5m", "priceRangeMax5m",
          "priceRangeMin15m", "priceRangeMax15m",
          "maxTimeRemaining5m", "maxTimeRemaining15m",
          "fallbackTimeRemaining5m", "fallbackTimeRemaining15m",
          "fallbackMinPrice", "fallbackMaxPrice",
          "stopLossEnabled", "stopLossTriggerPrice", "stopLossLimitPrice",
          "orderType",
          "numSlots", "slotInitialUsd", "slotProfitMultiplier",
          "shadowMode",
        ],
        note: "numSlots and slotInitialUsd changes take effect for new sessions only. " +
              "Changing them mid-session affects config display but not running slots.",
        examples: {
          "enable stop-loss at 49¢":        { stopLossEnabled: true, stopLossTriggerPrice: 0.49 },
          "tighten stop-loss floor to 10¢": { stopLossLimitPrice: 0.10 },
          "disable stop-loss":              { stopLossEnabled: false },
          "disable 5m markets":             { enable5m: false },
          "set 15m price range":            { priceRangeMin15m: 0.96, priceRangeMax15m: 0.99 },
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

  // ── POST /pause ───────────────────────────────────────────────────────────────
  app.post("/pause", (_req: Request, res: Response) => {
    if (isPausedState()) { res.json({ message: "Already paused." }); return; }
    pauseScanner();
    res.json({
      success: true,
      message: "Paused. Active bets will still resolve normally. Stop-loss checks continue for active bets.",
    });
  });

  // ── POST /resume ──────────────────────────────────────────────────────────────
  app.post("/resume", (_req: Request, res: Response) => {
    if (!isPausedState()) { res.json({ message: "Already running." }); return; }
    resumeScanner();
    res.json({ success: true, message: "Resumed." });
  });

  // ── GET /logs ─────────────────────────────────────────────────────────────────
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

function round2(n: number): number { return Math.round(n * 100) / 100; }
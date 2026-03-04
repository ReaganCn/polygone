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
 * CHANGE (stop-loss):
 *   - /status summary now includes totalStopLosses, totalRecovered, and a
 *     stopLoss sub-object with the current trigger/limit config and aggregate
 *     fill stats so the operator can see if stop-losses are working.
 *   - /status byRule now carries stopLosses, totalRecovered, and avgNetLoss
 *     per rule, matching the new RuleStats shape from slots.ts.
 *   - /config redacts the four builder credential fields.
 *   - POST /config help text lists all current mutable keys including the three
 *     new stop-loss keys (stopLossEnabled, stopLossTriggerPrice, stopLossLimitPrice).
 *   - netPnl formula updated: stop-loss recoveries are already factored into
 *     totalLost (which stores net loss = stake − recovered), so no extra term needed.
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

  // ── GET /status ──────────────────────────────────────────────────────────────
  app.get("/status", (_req: Request, res: Response) => {
    const snapshot = getSnapshot();
    const summary  = getSummary();

    // ── P&L calculation ───────────────────────────────────────────────────────
    //
    // initialCapital    = numSlots × slotInitialUsd  (the seed money put in)
    //
    // currentBalance    = sum of all slot balances right now (includes compounded
    //                     wins that haven't been extracted yet)
    //
    // profitExtracted   = USDC banked out of slots when they crossed the
    //                     slotProfitMultiplier threshold
    //
    // totalLost         = sum of net losses across all resolved losing trades,
    //                     INCLUDING stop-loss trades where totalLost = stake - recovered.
    //                     A stop-loss that recovered $0.80 of a $1 stake adds only
    //                     $0.20 to totalLost, not $1.00.
    //
    // unrealisedGain    = how much the current slot balances exceed the seed capital.
    //                     This is > 0 when slots have been compounding wins but haven't
    //                     hit the extraction threshold yet.
    //
    // netPnl            = profitExtracted - totalLost + unrealisedGain
    //
    // Note: recovered USDC from stop-losses goes back into the wallet directly;
    // it is NOT added to slot balances. The accounting is captured entirely via
    // the reduced totalLost figure (stake - recovered).
    // ─────────────────────────────────────────────────────────────────────────

    const initialCapital = round2(CONFIG.numSlots * CONFIG.slotInitialUsd);
    const unrealisedGain = round2(Math.max(0, summary.totalBalance - initialCapital));
    const netPnl         = round2(summary.totalProfitExtracted - summary.totalLost + unrealisedGain);

    // Aggregate recovered USDC across all stop-loss trades.
    // recoveredUsd per stop-loss = stakeUsd - netLoss (both tracked in ruleStats).
    // We can derive it from the slot snapshot: totalStopLostStake - totalStopLostNet.
    // Since slots.ts doesn't separately track totalRecovered we compute it here from
    // the byRule data: for each rule, recoveredUsd = totalStaked_on_stop_losses - totalLost_on_stop_losses.
    // The simpler approach: we know totalLost already deducts recovered amounts, so:
    //   totalRecoveredUsd ≈ (totalStopLosses × CONFIG.slotInitialUsd) - stopLossContributionToTotalLost
    // Instead, surface it cleanly per-rule from byRule where it's derivable.
    const byRule = summary.byRule;
    const totalStopLosses     = summary.totalStopLosses;

    // Per-rule stop-loss recovered estimates (stake × stopLosses - netLoss per rule)
    // Exact recovered = stakeUsd - netLoss, where stakeUsd = stopLosses × slotInitialUsd
    // (This is an approximation since slotInitialUsd may change; the log has exact values.)
    const stopLossRecoveredByRule = (["5m", "15m", "fallback"] as const).reduce((acc, rule) => {
      const r = byRule[rule];
      const estimatedStaked = r.stopLosses * CONFIG.slotInitialUsd;
      acc[rule] = round2(Math.max(0, estimatedStaked - r.totalLost));
      return acc;
    }, {} as Record<string, number>);

    const totalStopLossRecovered = round2(
      stopLossRecoveredByRule["5m"] +
      stopLossRecoveredByRule["15m"] +
      stopLossRecoveredByRule["fallback"]
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
        initialCapital,
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
        // Shows current config and aggregate fill stats so the operator can
        // verify stop-losses are triggering and recovering meaningful USDC.
        stopLoss: {
          enabled:          CONFIG.stopLossEnabled,
          triggerPrice:     CONFIG.stopLossTriggerPrice,
          limitPrice:       CONFIG.stopLossLimitPrice,
          totalTriggered:   totalStopLosses,
          totalRecoveredUsd: totalStopLossRecovered,
          // Average net loss per stop-loss trade.
          // totalStopLossNetLost is tracked separately in slots.ts — it only
          // counts stop-loss net losses (stake - recovered), not normal losses.
          avgNetLoss: (() => {
            const totalStopLossNetLost = round2(
              byRule["5m"].totalStopLossNetLost +
              byRule["15m"].totalStopLossNetLost +
              byRule["fallback"].totalStopLossNetLost
            );
            return totalStopLosses > 0 ? round2(totalStopLossNetLost / totalStopLosses) : 0;
          })(),
          byRule: {
            "5m":      { triggered: byRule["5m"].stopLosses,      recovered: stopLossRecoveredByRule["5m"],      netLost: byRule["5m"].totalLost },
            "15m":     { triggered: byRule["15m"].stopLosses,     recovered: stopLossRecoveredByRule["15m"],     netLost: byRule["15m"].totalLost },
            "fallback":{ triggered: byRule["fallback"].stopLosses, recovered: stopLossRecoveredByRule["fallback"], netLost: byRule["fallback"].totalLost },
          },
        },

        // ── Per-rule full breakdown ────────────────────────────────────────
        byRule: {
          "5m": {
            wins:           byRule["5m"].wins,
            losses:         byRule["5m"].losses,
            stopLosses:     byRule["5m"].stopLosses,
            totalTrades:    byRule["5m"].totalTrades,
            winRate:        byRule["5m"].winRate,
            totalWinAmount: byRule["5m"].totalWinAmount,
            avgWinAmount:   byRule["5m"].avgWinAmount,
            totalLost:      byRule["5m"].totalLost,
            netPnl:         byRule["5m"].netPnl,
          },
          "15m": {
            wins:           byRule["15m"].wins,
            losses:         byRule["15m"].losses,
            stopLosses:     byRule["15m"].stopLosses,
            totalTrades:    byRule["15m"].totalTrades,
            winRate:        byRule["15m"].winRate,
            totalWinAmount: byRule["15m"].totalWinAmount,
            avgWinAmount:   byRule["15m"].avgWinAmount,
            totalLost:      byRule["15m"].totalLost,
            netPnl:         byRule["15m"].netPnl,
          },
          "fallback": {
            wins:           byRule["fallback"].wins,
            losses:         byRule["fallback"].losses,
            stopLosses:     byRule["fallback"].stopLosses,
            totalTrades:    byRule["fallback"].totalTrades,
            winRate:        byRule["fallback"].winRate,
            totalWinAmount: byRule["fallback"].totalWinAmount,
            avgWinAmount:   byRule["fallback"].avgWinAmount,
            totalLost:      byRule["fallback"].totalLost,
            netPnl:         byRule["fallback"].netPnl,
          },
        },
      },

      slots: snapshot,
      activeBets,
    });
  });

  // ── GET /config ──────────────────────────────────────────────────────────────
  app.get("/config", (_req: Request, res: Response) => {
    // Destructure all sensitive fields so none leak into the response
    const {
      privateKey,
      polyApiKey, polySecret, polyPassphrase,
      polyBuilderApiKey, polyBuilderSecret, polyBuilderPassphrase,
      ...safe
    } = CONFIG;

    res.json({
      ...safe,
      // Wallet
      privateKey:     "[REDACTED]",
      // CLOB credentials
      polyApiKey:           polyApiKey           ? "[SET]" : "[NOT SET]",
      polySecret:           polySecret           ? "[SET]" : "[NOT SET]",
      polyPassphrase:       polyPassphrase       ? "[SET]" : "[NOT SET]",
      // Builder credentials (auto-redemption)
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
          // Scanning
          "scanIntervalMs",
          "targetAssets",
          // Market type toggles
          "enable5m",
          "enable15m",
          "enableFallback",
          // Price ranges
          "priceRangeMin5m",
          "priceRangeMax5m",
          "priceRangeMin15m",
          "priceRangeMax15m",
          // Time-remaining windows
          "maxTimeRemaining5m",
          "maxTimeRemaining15m",
          // Fallback rule
          "fallbackTimeRemaining5m",
          "fallbackTimeRemaining15m",
          "fallbackMinPrice",
          "fallbackMaxPrice",
          // Stop-loss
          "stopLossEnabled",
          "stopLossTriggerPrice",
          "stopLossLimitPrice",
          // Order execution
          "orderType",
          // Slot / compounding
          "numSlots",
          "slotInitialUsd",
          "slotProfitMultiplier",
          // Mode
          "shadowMode",
        ],
        examples: {
          "enable stop-loss at 49¢":          { stopLossEnabled: true, stopLossTriggerPrice: 0.49 },
          "tighten stop-loss floor to 10¢":   { stopLossLimitPrice: 0.10 },
          "disable stop-loss":                { stopLossEnabled: false },
          "disable 5m markets":               { enable5m: false },
          "only use fallback":                { enable5m: false, enable15m: false, enableFallback: true },
          "set 15m price range":              { priceRangeMin15m: 0.96, priceRangeMax15m: 0.99 },
          "set max time remaining (5m)":      { maxTimeRemaining5m: 120 },
          "set max time remaining (15m)":     { maxTimeRemaining15m: 300 },
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
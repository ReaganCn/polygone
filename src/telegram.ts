/**
 * telegram.ts — Telegram alerting module.
 *
 * Sends bot status messages to a Telegram chat using the Bot API.
 * Formats messages in the exact same style as botstatus.sh.
 * Gracefully no-ops if TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID are not set.
 */

import { CONFIG } from "./config.js";
import { log } from "./logger.js";
import type { BetRule } from "./types.js";

// ─── Send Alert ──────────────────────────────────────────────────────────────

export async function sendTelegramAlert(message: string): Promise<void> {
  if (!CONFIG.telegramBotToken || !CONFIG.telegramChatId) return;

  const url = `https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendMessage`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CONFIG.telegramChatId,
        text: message,
      }),
    });

    if (resp.status === 429) {
      // Rate limited — wait and retry once
      const retryAfter = Number(resp.headers.get("Retry-After") || "5");
      log.warn("WARN", { message: `Telegram rate limited, retrying in ${retryAfter}s` });
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CONFIG.telegramChatId,
          text: message,
        }),
      });
      return;
    }

    if (!resp.ok) {
      const body = await resp.text();
      log.error("ERROR", { message: "Telegram send failed", status: resp.status, body });
    }
  } catch (err) {
    log.error("ERROR", { message: "Telegram send error", error: (err as Error).message });
  }
}

// ─── Format Status Message ───────────────────────────────────────────────────

interface StatusSummary {
  totalSlots: number;
  activeSlots: number;
  idleSlots: number;
  totalBalance: number;
  totalProfitExtracted: number;
  totalLost: number;
  totalWins: number;
  totalLosses: number;
  totalTrades: number;
  winRate: number;
  avgWinAmount: number;
  byRule: Record<BetRule, {
    wins: number; losses: number; totalTrades: number; winRate: number;
    totalWinAmount: number; avgWinAmount: number; totalLost: number; netPnl: number;
  }>;
}

interface SchedulerInfo {
  tradingWindowStart: string;
  tradingWindowEnd: string;
  dailyNetPnl: number;
  dailyProfitTarget: number | null;
  dailyLossLimit: number | null;
}

export function formatStatusMessage(
  summary: StatusSummary,
  scheduler: SchedulerInfo,
  opts: { paused: boolean; shadowMode: boolean },
): string {
  const initialCapital = round2(CONFIG.numSlots * CONFIG.slotInitialUsd);
  const unrealisedGain = round2(Math.max(0, summary.totalBalance - initialCapital));
  const netPnl = round2(summary.totalProfitExtracted - summary.totalLost + unrealisedGain);

  const modeStr = `${opts.shadowMode ? "SHADOW" : "LIVE"} | ${opts.paused ? "PAUSED" : "RUNNING"}`;
  const targetStr = scheduler.dailyProfitTarget === null ? "null" : scheduler.dailyProfitTarget;
  const limitStr = scheduler.dailyLossLimit === null ? "null" : scheduler.dailyLossLimit;

  const lines: string[] = [];
  lines.push("=== TRADING BOT STATUS ===");
  lines.push(`Mode:      ${modeStr}`);
  lines.push(`Balance:   $${summary.totalBalance.toFixed(2)} (initial: $${initialCapital.toFixed(2)})`);
  lines.push(`Net PnL:   $${netPnl.toFixed(2)} | Unrealised: $${unrealisedGain.toFixed(2)}`);
  lines.push(`Extracted: $${summary.totalProfitExtracted.toFixed(2)} | Lost: $${summary.totalLost.toFixed(2)}`);
  lines.push(`Trades:    ${summary.totalTrades} (${summary.totalWins}W / ${summary.totalLosses}L) — ${summary.winRate.toFixed(1)}% WR`);
  lines.push(`Slots:     ${summary.activeSlots} active / ${summary.idleSlots} idle / ${summary.totalSlots} total`);
  lines.push(`Daily:     PnL $${scheduler.dailyNetPnl.toFixed(2)} | Target $${targetStr} | Limit -$${limitStr}`);
  lines.push(`Window:    ${scheduler.tradingWindowStart} - ${scheduler.tradingWindowEnd}`);
  lines.push("");
  lines.push("--- BY RULE ---");

  for (const rule of ["5m", "15m"] as BetRule[]) {
    const r = summary.byRule[rule];
    if (r.totalTrades === 0) {
      lines.push(`  ${rule.padEnd(10)} no trades`);
    } else {
      lines.push(
        `  ${rule.padEnd(10)} ${r.totalTrades}T ${r.wins}W/${r.losses}L ${r.winRate.toFixed(1)}%WR  PnL $${r.netPnl.toFixed(2)}  avgWin $${r.avgWinAmount.toFixed(2)}`
      );
    }
  }

  return lines.join("\n");
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

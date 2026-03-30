/**
 * telegram.ts — Telegram alert notifications.
 *
 * Sends trade event alerts and daily summaries to a Telegram chat via the
 * Bot API. Configure with TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID env vars.
 * If either is missing, all calls are no-ops — no errors are thrown.
 *
 * Usage:
 *   notifyBetPlaced(asset, side, stakeUsd, rule, price)
 *   notifyWin(asset, side, stakeUsd, payoutUsd, rule)
 *   notifyLoss(asset, side, stakeUsd, rule)
 *   notifyDailySummary(summary)
 */

import { CONFIG } from "./config.js";
import { log } from "./logger.js";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const MAX_ERROR_BODY_LENGTH = 200;

function isConfigured(): boolean {
  return Boolean(CONFIG.telegramBotToken && CONFIG.telegramChatId);
}

async function sendMessage(text: string): Promise<void> {
  if (!isConfigured()) return;
  try {
    const url = `${TELEGRAM_API_BASE}/bot${CONFIG.telegramBotToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CONFIG.telegramChatId,
        text,
        parse_mode: "HTML",
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      log.warn("WARN", {
        message: "Telegram sendMessage failed",
        status: res.status,
        body: body.slice(0, MAX_ERROR_BODY_LENGTH),
      });
    }
  } catch (err) {
    log.warn("WARN", {
      message: "Telegram sendMessage error",
      error: (err as Error).message,
    });
  }
}

export function notifyBetPlaced(
  asset: string,
  side: string,
  stakeUsd: number,
  rule: string,
  price: number
): void {
  const mode = CONFIG.shadowMode ? " [shadow]" : "";
  const text =
    `🎯 <b>Bet Placed${mode}</b>\n` +
    `Asset: <b>${asset}</b>  Rule: ${rule}\n` +
    `Side: ${side}  Stake: $${stakeUsd}  @${price}`;
  sendMessage(text).catch(() => {});
}

export function notifyWin(
  asset: string,
  side: string,
  stakeUsd: number,
  payoutUsd: number,
  rule: string
): void {
  const profit = Math.round((payoutUsd - stakeUsd) * 100) / 100;
  const mode = CONFIG.shadowMode ? " [shadow]" : "";
  const text =
    `✅ <b>Win!${mode}</b>\n` +
    `Asset: <b>${asset}</b>  Rule: ${rule}\n` +
    `Side: ${side}  Stake: $${stakeUsd}  Payout: $${payoutUsd}  Profit: +$${profit}`;
  sendMessage(text).catch(() => {});
}

export function notifyLoss(
  asset: string,
  side: string,
  stakeUsd: number,
  rule: string
): void {
  const mode = CONFIG.shadowMode ? " [shadow]" : "";
  const text =
    `❌ <b>Loss${mode}</b>\n` +
    `Asset: <b>${asset}</b>  Rule: ${rule}\n` +
    `Side: ${side}  Stake: $${stakeUsd}`;
  sendMessage(text).catch(() => {});
}

export function notifyDailySummary(summary: {
  totalTrades: number;
  totalWins: number;
  totalLosses: number;
  totalStopLosses: number;
  winRate: number;
  netPnl: number;
  totalProfitExtracted: number;
  totalLost: number;
}): void {
  const mode = CONFIG.shadowMode ? " [shadow]" : "";
  const text =
    `📊 <b>Daily Summary${mode}</b>\n` +
    `Trades: ${summary.totalTrades}  Wins: ${summary.totalWins}  Losses: ${summary.totalLosses}  SL: ${summary.totalStopLosses}\n` +
    `Win Rate: ${summary.winRate}%\n` +
    `Net PnL: $${summary.netPnl}\n` +
    `Extracted: $${summary.totalProfitExtracted}  Lost: $${summary.totalLost}`;
  sendMessage(text).catch(() => {});
}

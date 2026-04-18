/**
 * logger.ts
 *
 * Structured logger with:
 *   - Three separate log files: trades, errors, system
 *   - Hourly rotation (new file every hour, old files kept)
 *   - Reduced console noise (only important events printed to stdout)
 *   - Every entry is a single JSON line
 *
 * Log files written to LOG_FILE_PATH directory (default ./logs/):
 *   trades-YYYY-MM-DD-HH.log        — bet placement, wins, losses, P&L
 *   shadow-trades-YYYY-MM-DD-HH.log — same but when SHADOW_MODE=true
 *   errors-YYYY-MM-DD-HH.log        — all WARN and ERROR events
 *   system-YYYY-MM-DD-HH.log        — lifecycle, config changes, WS status
 *
 * Console: only key trade events + errors. Set LOG_VERBOSE=true for everything.
 */

import fs from "fs";
import path from "path";
import { CONFIG } from "./config.js";

type LogLevel = "INFO" | "WARN" | "ERROR";

export type LogEvent =
  // Bet lifecycle → trades log
  | "BET_PLACED"
  | "BET_QUEUED"
  | "BET_SKIPPED_NO_SLOT"
  | "ORDER_RESPONSE"
  | "ORDER_FAILED"
  | "ORDER_FOK_RETRY"
  | "ORDER_CLOSE_RESPONSE"
  | "ORDER_CLOSE_FAILED"
  | "RESOLUTION_WIN"
  | "RESOLUTION_LOSS"
  | "RESOLUTION_ERROR"
  | "REDEEM_UNCAUGHT"
  // Early close (TP / SL) → trades log
  | "EARLY_CLOSE_TP"
  | "EARLY_CLOSE_SL"
  | "EARLY_CLOSE_FOK_RETRY"
  | "EARLY_CLOSE_EXHAUSTED"
  | "EARLY_CLOSE_FAILED"
  | "EARLY_CLOSE_POLL_ERROR"
  | "EARLY_CLOSE_LIMIT_CANCELLED"
  | "EARLY_CLOSE_CANCEL_ERROR"
  | "EARLY_CLOSE_ERROR"
  // Redemption lifecycle → trades/system/errors log
  | "REDEEM_POLLING_SETTLEMENT"
  | "REDEEM_SETTLEMENT_CONFIRMED_ONCHAIN"
  | "REDEEM_FAILED_SETTLEMENT_TIMEOUT"
  | "REDEEM_SKIPPED_NO_BALANCE"
  | "REDEEM_CONFIRMED"
  | "REDEEM_ERROR"
  | "REDEEM_RPC_INITIAL_ERROR"
  | "REDEEM_RPC_POLLING_RETRY"
  // Shadow mode → trades log
  | "SHADOW_BET_SIMULATED"
  | "SHADOW_RESOLUTION_WIN"
  | "SHADOW_RESOLUTION_LOSS"
  // Slot management → trades log
  | "SLOT_ASSIGNED"
  | "SLOT_WIN_COMPOUND"
  | "SLOT_LOSS_RESET"
  | "SLOT_PROFIT_EXTRACTED"
  | "SLOT_STATE_SNAPSHOT"
  // Scanner → system log
  | "SCAN_TICK"
  | "MARKET_FOUND"
  | "SCAN_ERROR"
  // Bot lifecycle → system log
  | "BOT_STARTED"
  | "BOT_PAUSED"
  | "BOT_PAUSED_FINAL_STATUS_SENT"
  | "BOT_RESUMED"
  | "CONFIG_UPDATED"
  | "RESOLUTION_POLLING"
  | "LOG_CLEANUP"
  // General
  | "INFO"
  | "WARN"
  | "ERROR";

interface LogEntry {
  ts: string;
  level: LogLevel;
  event: LogEvent;
  shadow: boolean;
  data: Record<string, unknown>;
}

// ─── routing ──────────────────────────────────────────────────────────────────

const TRADE_EVENTS = new Set<LogEvent>([
  "BET_PLACED", "BET_QUEUED", "BET_SKIPPED_NO_SLOT", "ORDER_RESPONSE", "ORDER_FAILED",
  "ORDER_FOK_RETRY",
  "ORDER_CLOSE_RESPONSE", "ORDER_CLOSE_FAILED",
  "RESOLUTION_WIN", "RESOLUTION_LOSS", "RESOLUTION_ERROR",
  "EARLY_CLOSE_TP", "EARLY_CLOSE_SL", "EARLY_CLOSE_FOK_RETRY",
  "EARLY_CLOSE_EXHAUSTED", "EARLY_CLOSE_FAILED", "EARLY_CLOSE_POLL_ERROR",
  "EARLY_CLOSE_LIMIT_CANCELLED", "EARLY_CLOSE_CANCEL_ERROR", "EARLY_CLOSE_ERROR",
  "REDEEM_CONFIRMED",
  "SHADOW_BET_SIMULATED", "SHADOW_RESOLUTION_WIN", "SHADOW_RESOLUTION_LOSS",
  "SLOT_ASSIGNED", "SLOT_WIN_COMPOUND", "SLOT_LOSS_RESET",
  "SLOT_PROFIT_EXTRACTED", "SLOT_STATE_SNAPSHOT",
]);

const SYSTEM_EVENTS = new Set<LogEvent>([
  "SCAN_TICK", "MARKET_FOUND", "SCAN_ERROR",
  "BOT_STARTED", "BOT_PAUSED", "BOT_RESUMED", "CONFIG_UPDATED",
  "RESOLUTION_POLLING",
  "REDEEM_POLLING_SETTLEMENT",
  "REDEEM_SETTLEMENT_CONFIRMED_ONCHAIN",
  "LOG_CLEANUP",
  "INFO",
]);

// Events always shown on console
const CONSOLE_EVENTS = new Set<LogEvent>([
  "BOT_STARTED", "BOT_PAUSED", "BOT_RESUMED", "CONFIG_UPDATED",
  "BET_PLACED", "SHADOW_BET_SIMULATED",
  "RESOLUTION_WIN", "RESOLUTION_LOSS",
  "SHADOW_RESOLUTION_WIN", "SHADOW_RESOLUTION_LOSS",
  "EARLY_CLOSE_TP", "EARLY_CLOSE_SL", "EARLY_CLOSE_EXHAUSTED",
  "SLOT_PROFIT_EXTRACTED",
  "ORDER_FAILED", "ORDER_CLOSE_FAILED", "RESOLUTION_ERROR", "SCAN_ERROR",
  "REDEEM_CONFIRMED", "REDEEM_FAILED_SETTLEMENT_TIMEOUT", "REDEEM_ERROR",
  "REDEEM_RPC_INITIAL_ERROR",
]);

// ─── file paths ───────────────────────────────────────────────────────────────

function getLogDir(): string {
  return path.dirname(CONFIG.logFilePath);
}

function hourlySuffix(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const mo = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const h = String(now.getUTCHours()).padStart(2, "0");
  return `${y}-${mo}-${d}-${h}`;
}

function getFilePath(category: "trades" | "errors" | "system"): string {
  const prefix = CONFIG.shadowMode ? `shadow-${category}` : category;
  return path.join(getLogDir(), `${prefix}-${hourlySuffix()}.log`);
}

// ─── write ────────────────────────────────────────────────────────────────────

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function appendToFile(filePath: string, line: string): void {
  try {
    ensureDir(filePath);
    fs.appendFileSync(filePath, line, "utf8");
  } catch (err) {
    process.stderr.write(`[logger] Write failed: ${(err as Error).message}\n`);
  }
}

function write(level: LogLevel, event: LogEvent, data: Record<string, unknown>): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    event,
    shadow: CONFIG.shadowMode,
    data,
  };

  const line = JSON.stringify(entry) + "\n";

  // Route to file(s)
  if (TRADE_EVENTS.has(event)) {
    appendToFile(getFilePath("trades"), line);
  } else if (SYSTEM_EVENTS.has(event)) {
    appendToFile(getFilePath("system"), line);
  }
  // Errors/warnings also go to errors log
  if (level === "WARN" || level === "ERROR") {
    appendToFile(getFilePath("errors"), line);
  }

  // Console: only important events (or everything if LOG_VERBOSE=true)
  const verbose = process.env["LOG_VERBOSE"] === "true";
  if (verbose || CONSOLE_EVENTS.has(event) || level === "ERROR") {
    const icon = level === "ERROR" ? "🔴" : level === "WARN" ? "🟡" : "🟢";
    const summary = buildSummary(event, data);
    process.stdout.write(`${icon} [${entry.ts.slice(11, 19)}] ${event}${summary}\n`);
  }
}

function buildSummary(event: LogEvent, data: Record<string, unknown>): string {
  const parts: string[] = [];
  if (data["asset"])                        parts.push(String(data["asset"]));
  if (data["duration"])                     parts.push(String(data["duration"]));
  if (data["slotId"] !== undefined)         parts.push(`slot=${data["slotId"]}`);
  if (data["stakeUsd"] !== undefined)       parts.push(`$${data["stakeUsd"]}`);
  if (data["priceAtBet"] !== undefined)     parts.push(`@${data["priceAtBet"]}`);
  if (data["side"])                         parts.push(`${data["side"]}`);
  if (data["winSide"])                      parts.push(`${data["winSide"]}`);
  if (data["payoutUsd"] !== undefined)      parts.push(`payout=$${data["payoutUsd"]}`);
  if (data["profitUsd"] !== undefined)      parts.push(`profit=$${data["profitUsd"]}`);
  if (data["profitExtracted"] !== undefined) parts.push(`extracted=$${data["profitExtracted"]}`);
  if (data["txHash"])                       parts.push(`tx=${data["txHash"]}`);
  if (data["market"])                       parts.push(`market=${data["market"]}`);
  if (data["conditionId"])                  parts.push(`condition=${data["conditionId"]}`);
  if (data["error"])                        parts.push(`ERR: ${data["error"]}`);
  if (data["updatedKeys"])                  parts.push(`keys=${JSON.stringify(data["updatedKeys"])}`);
  if (data["message"] && parts.length === 0) parts.push(String(data["message"]));
  return parts.length > 0 ? `  ${parts.join("  ")}` : "";
}

// ─── public API ───────────────────────────────────────────────────────────────

export const log = {
  info(event: LogEvent, data: Record<string, unknown> = {}): void {
    write("INFO", event, data);
  },
  warn(event: LogEvent, data: Record<string, unknown> = {}): void {
    write("WARN", event, data);
  },
  error(event: LogEvent, data: Record<string, unknown> = {}): void {
    write("ERROR", event, data);
  },

  /**
   * Read the last N lines from a log category.
   * Checks current hour file, falls back to previous hour.
   */
  tail(n: number, category: "trades" | "errors" | "system" = "trades"): LogEntry[] {
    const prefix = CONFIG.shadowMode ? `shadow-${category}` : category;
    const dir = getLogDir();
    const lines: string[] = [];

    // Collect entries from current and previous hour files
    for (let offsetHours = 0; offsetHours <= 2; offsetHours++) {
      const d = new Date(Date.now() - offsetHours * 3600_000);
      const suffix = [
        d.getUTCFullYear(),
        String(d.getUTCMonth() + 1).padStart(2, "0"),
        String(d.getUTCDate()).padStart(2, "0"),
        String(d.getUTCHours()).padStart(2, "0"),
      ].join("-");
      const filePath = path.join(dir, `${prefix}-${suffix}.log`);
      try {
        if (fs.existsSync(filePath)) {
          lines.push(...fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean));
        }
      } catch { /* skip */ }
    }

    return lines.slice(-n).map((l) => {
      try { return JSON.parse(l) as LogEntry; } catch { return null; }
    }).filter(Boolean) as LogEntry[];
  },

  /** List all log files. */
  listFiles(): string[] {
    const dir = getLogDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith(".log"))
      .sort()
      .map((f) => path.join(dir, f));
  },

  /**
   * Delete log files older than maxAgeMs (default 24 hours).
   * Parses the YYYY-MM-DD-HH suffix to determine each file's age.
   */
  cleanup(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
    const dir = getLogDir();
    if (!fs.existsSync(dir)) return;

    const now = Date.now();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".log"));
    let deleted = 0;

    for (const file of files) {
      // Extract YYYY-MM-DD-HH from filename like "trades-2026-03-29-14.log"
      const match = file.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})\.log$/);
      if (!match) continue;

      const [, year, month, day, hour] = match;
      const fileDate = new Date(Date.UTC(
        parseInt(year), parseInt(month) - 1, parseInt(day), parseInt(hour)
      ));
      const ageMs = now - fileDate.getTime();

      if (ageMs > maxAgeMs) {
        try {
          fs.unlinkSync(path.join(dir, file));
          deleted++;
        } catch { /* skip */ }
      }
    }

    if (deleted > 0) {
      write("INFO", "LOG_CLEANUP", { deletedFiles: deleted, maxAgeHours: Math.round(maxAgeMs / 3600_000) });
    }
  },
};
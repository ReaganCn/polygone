/**
 * logger.ts
 *
 * Append-only structured logger.
 * Every log entry is written as a single JSON line (never truncated, never
 * pretty-printed) to both stdout and the configured log file.
 *
 * Log format:
 *   { "ts": "ISO8601", "level": "INFO|WARN|ERROR", "event": "...", "shadow": bool, "data": {...} }
 *
 * Usage:
 *   log.info("BET_PLACED", { slotId: 1, market: "...", ... })
 *   log.warn("MARKET_SKIPPED", { reason: "...", ... })
 *   log.error("ORDER_FAILED", { error: "...", ... })
 */

import fs from "fs";
import path from "path";
import { CONFIG } from "./config.js";

// ─── types ───────────────────────────────────────────────────────────────────

type LogLevel = "INFO" | "WARN" | "ERROR";

export type LogEvent =
  // Scanner
  | "SCAN_TICK"
  | "MARKET_FOUND"
  | "MARKET_SKIPPED"
  | "SCAN_ERROR"
  // Bet lifecycle
  | "BET_QUEUED"
  | "BET_PLACED"
  | "BET_SKIPPED_NO_SLOT"
  | "ORDER_RESPONSE"
  | "ORDER_FAILED"
  // Resolution
  | "RESOLUTION_POLLING"
  | "RESOLUTION_WIN"
  | "RESOLUTION_LOSS"
  | "RESOLUTION_ERROR"
  // Slot management
  | "SLOT_ASSIGNED"
  | "SLOT_WIN_COMPOUND"
  | "SLOT_LOSS_RESET"
  | "SLOT_PROFIT_EXTRACTED"
  | "SLOT_STATE_SNAPSHOT"
  // Shadow mode
  | "SHADOW_BET_SIMULATED"
  | "SHADOW_RESOLUTION_WIN"
  | "SHADOW_RESOLUTION_LOSS"
  // Config / control
  | "BOT_STARTED"
  | "BOT_PAUSED"
  | "BOT_RESUMED"
  | "CONFIG_UPDATED"
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

// ─── internals ───────────────────────────────────────────────────────────────

function ensureLogDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
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

  // Serialize as a single line — JSON.stringify never truncates
  const line = JSON.stringify(entry) + "\n";

  // Console output with colour hint prefix
  const prefix = level === "ERROR" ? "🔴" : level === "WARN" ? "🟡" : "🟢";
  process.stdout.write(`${prefix} ${line}`);

  // File output — synchronous to avoid losing entries on crash
  try {
    ensureLogDir(CONFIG.logFilePath);
    fs.appendFileSync(CONFIG.logFilePath, line, "utf8");
  } catch (err) {
    process.stderr.write(`[logger] Failed to write to log file: ${(err as Error).message}\n`);
  }
}

// ─── public API ──────────────────────────────────────────────────────────────

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
   * Read the last N lines from the log file.
   * Used by the REST API's /logs endpoint.
   */
  tail(n: number): LogEntry[] {
    try {
      if (!fs.existsSync(CONFIG.logFilePath)) return [];
      const raw = fs.readFileSync(CONFIG.logFilePath, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      const slice = lines.slice(-n);
      return slice.map((l) => JSON.parse(l) as LogEntry);
    } catch {
      return [];
    }
  },
};

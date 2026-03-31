/**
 * dailyState.ts — Shared mutable for daily P&L baseline and pause persistence.
 *
 * Stored here (not in index.ts) so both index.ts and api.ts can read/write
 * it without creating a circular dependency.
 *
 * Pause persistence:
 *   When any pause trigger fires (PnL target, loss limit, or outside trading
 *   hours), the reason is written to PAUSE_STATE_FILE. On restart, if the file
 *   exists for the current UTC date the pause is restored — preventing the bot
 *   from trading again just because an in-memory restart cleared the pause flag.
 *   The file is cleared on UTC midnight reset or on explicit POST /resume.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";

const PAUSE_STATE_FILE = "./pause-state.json";

interface PersistedPauseState {
  reason: string;
  utcDate: string;
  pausedAt: string;
}

export const dailyState = {
  startOfDayPnl: 0,
  /**
   * True when the pause was persisted to disk for the current UTC day.
   * Included in shouldPause so the supervisor never auto-resumes a
   * persisted pause, even after an in-memory restart.
   */
  isPersistentlyPaused: false,
};

function utcDateString(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
}

/** Persist the current pause reason so it survives server restarts within the same UTC day. */
export function savePauseState(reason: string): void {
  const state: PersistedPauseState = {
    reason,
    utcDate: utcDateString(),
    pausedAt: new Date().toISOString(),
  };
  try {
    writeFileSync(PAUSE_STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // Non-fatal — in-memory state is still correct
  }
}

/** Remove the persisted pause file (midnight reset or manual resume). */
export function clearPauseState(): void {
  try {
    if (existsSync(PAUSE_STATE_FILE)) unlinkSync(PAUSE_STATE_FILE);
  } catch {
    // Non-fatal
  }
}

/** Returns the persisted pause reason if valid for today's UTC date, null otherwise. */
export function loadPauseState(): string | null {
  try {
    if (!existsSync(PAUSE_STATE_FILE)) return null;
    const state = JSON.parse(readFileSync(PAUSE_STATE_FILE, "utf8")) as PersistedPauseState;
    if (state.utcDate === utcDateString()) return state.reason;
  } catch {
    // Corrupt or missing file — ignore
  }
  return null;
}
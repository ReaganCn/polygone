/**
 * dailyState.ts — Shared mutable for daily P&L baseline.
 *
 * Stored here (not in index.ts) so both index.ts and api.ts can read/write
 * it without creating a circular dependency.
 */

export const dailyState = {
  startOfDayPnl: 0,
};
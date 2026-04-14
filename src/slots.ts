/**
 * slots.ts — Compounding slot machine.
 *
 * Loss accounting (corrected):
 *   A loss wipes the STAKE (initialBalance), not the accumulated balance.
 *   If a slot had compounded to $1.10 but only bet $1 (its initialBalance),
 *   the loss destroys $1 — the extra $0.10 never left the slot.
 *   So: totalLost += bet.stakeUsd (which equals initialBalance, the actual
 *   amount at risk), not balanceBefore.
 *
 * Per-rule statistics (5m / 15m / fallback):
 *   Each slot tracks wins/losses/profit independently per BetRule.
 *   The global getSummary() aggregates these for the /status endpoint.
 */

import { CONFIG } from "./config.js";
import { log } from "./logger.js";
import type { ActiveBet, BetRule } from "./types.js";

export type SlotStatus = "idle" | "pending" | "active";

export interface RuleStats {
  wins: number;
  losses: number;
  totalWinAmount: number;  // sum of profit per win (payout - stake)
  totalLost: number;       // sum of stakes lost
}

export interface Slot {
  id: number;
  status: SlotStatus;
  balance: number;
  initialBalance: number;
  totalProfitExtracted: number;
  /** Capital destroyed by losses — only the stake (initialBalance), not compounded gains */
  totalLost: number;
  wins: number;
  losses: number;
  /** Per-rule breakdown */
  ruleStats: Record<BetRule, RuleStats>;
  activeBet?: ActiveBet;
}

const slots: Slot[] = [];

function emptyRuleStats(): Record<BetRule, RuleStats> {
  return {
    "5m":      { wins: 0, losses: 0, totalWinAmount: 0, totalLost: 0 },
    "15m":     { wins: 0, losses: 0, totalWinAmount: 0, totalLost: 0 },
    "fallback":{ wins: 0, losses: 0, totalWinAmount: 0, totalLost: 0 },
  };
}

// ─── initialise ───────────────────────────────────────────────────────────────

export function initialiseSlots(): void {
  slots.length = 0;
  for (let i = 0; i < CONFIG.numSlots; i++) {
    slots.push({
      id: i + 1,
      status: "idle",
      balance: CONFIG.slotInitialUsd,
      initialBalance: CONFIG.slotInitialUsd,
      totalProfitExtracted: 0,
      totalLost: 0,
      wins: 0,
      losses: 0,
      ruleStats: emptyRuleStats(),
    });
  }
  log.info("SLOT_STATE_SNAPSHOT", { action: "initialised", slots: getSnapshot() });
}

/**
 * Reset all slots to initial capital for a new day.
 * Active bets are left to resolve naturally — only idle/pending slots are reset.
 * Returns the pre-reset summary for use in end-of-day alerts.
 */
export function resetSlots(): ReturnType<typeof getSummary> {
  const summaryBeforeReset = getSummary();

  for (const slot of slots) {
    // Leave active bets alone — they'll resolve into the new day's stats
    if (slot.status === "active" && slot.activeBet) continue;

    slot.status = "idle";
    slot.balance = CONFIG.slotInitialUsd;
    slot.initialBalance = CONFIG.slotInitialUsd;
    slot.totalProfitExtracted = 0;
    slot.totalLost = 0;
    slot.wins = 0;
    slot.losses = 0;
    slot.ruleStats = emptyRuleStats();
    slot.activeBet = undefined;
  }

  log.info("SLOT_STATE_SNAPSHOT", { action: "daily_reset", slots: getSnapshot() });
  return summaryBeforeReset;
}

// ─── queries ──────────────────────────────────────────────────────────────────

export function getIdleSlot(): Slot | null {
  const activeCount = Math.min(slots.length, CONFIG.numSlots);
  for (let i = 0; i < activeCount; i++) {
    if (slots[i].status === "idle") return slots[i];
  }
  return null;
}

export function getSnapshot(): Omit<Slot, "activeBet">[] {
  return slots.map(({ id, status, balance, initialBalance,
    totalProfitExtracted, totalLost, wins, losses, ruleStats }) => ({
    id, status, balance, initialBalance,
    totalProfitExtracted, totalLost, wins, losses, ruleStats,
  }));
}

export function getActiveBets(): ActiveBet[] {
  return slots.flatMap((s) => (s.activeBet ? [s.activeBet] : []));
}

/** Aggregate summary across all slots, with per-rule breakdown. */
export function getSummary() {
  const totalBalance        = slots.reduce((s, slot) => s + slot.balance, 0);
  const totalProfitExtracted = slots.reduce((s, slot) => s + slot.totalProfitExtracted, 0);
  const totalLost           = slots.reduce((s, slot) => s + slot.totalLost, 0);
  const totalWins           = slots.reduce((s, slot) => s + slot.wins, 0);
  const totalLosses         = slots.reduce((s, slot) => s + slot.losses, 0);
  const activeSlots         = slots.filter((s) => s.status === "active").length;

  // Aggregate per-rule stats
  const rules: Record<BetRule, RuleStats> = {
    "5m":      { wins: 0, losses: 0, totalWinAmount: 0, totalLost: 0 },
    "15m":     { wins: 0, losses: 0, totalWinAmount: 0, totalLost: 0 },
    "fallback":{ wins: 0, losses: 0, totalWinAmount: 0, totalLost: 0 },
  };
  for (const slot of slots) {
    for (const rule of ["5m", "15m", "fallback"] as BetRule[]) {
      rules[rule].wins           += slot.ruleStats[rule].wins;
      rules[rule].losses         += slot.ruleStats[rule].losses;
      rules[rule].totalWinAmount += slot.ruleStats[rule].totalWinAmount;
      rules[rule].totalLost      += slot.ruleStats[rule].totalLost;
    }
  }

  // Per-rule derived stats
  const ruleBreakdown = {} as Record<BetRule, {
    wins: number; losses: number; totalTrades: number; winRate: number;
    totalWinAmount: number; avgWinAmount: number; totalLost: number; netPnl: number;
  }>;
  for (const rule of ["5m", "15m", "fallback"] as BetRule[]) {
    const r = rules[rule];
    const totalTrades = r.wins + r.losses;
    ruleBreakdown[rule] = {
      wins: r.wins,
      losses: r.losses,
      totalTrades,
      winRate: totalTrades > 0 ? round2((r.wins / totalTrades) * 100) : 0,
      totalWinAmount: round2(r.totalWinAmount),
      avgWinAmount:   r.wins > 0 ? round2(r.totalWinAmount / r.wins) : 0,
      totalLost:      round2(r.totalLost),
      netPnl:         round2(r.totalWinAmount - r.totalLost),
    };
  }

  const totalWinAmount = totalWins > 0
    ? round2(slots.reduce((s, slot) => s + slot.ruleStats["5m"].totalWinAmount + slot.ruleStats["15m"].totalWinAmount + slot.ruleStats["fallback"].totalWinAmount, 0))
    : 0;

  return {
    totalSlots: slots.length,
    activeSlots,
    idleSlots: slots.length - activeSlots,
    totalBalance:         round2(totalBalance),
    totalProfitExtracted: round2(totalProfitExtracted),
    totalLost:            round2(totalLost),
    totalWins,
    totalLosses,
    totalTrades:  totalWins + totalLosses,
    winRate:      totalWins + totalLosses > 0 ? round2((totalWins / (totalWins + totalLosses)) * 100) : 0,
    avgWinAmount: totalWins > 0 ? round2(totalWinAmount / totalWins) : 0,
    byRule:       ruleBreakdown,
  };
}

// ─── mutations ────────────────────────────────────────────────────────────────

/**
 * Synchronously marks a slot as "pending" so no other caller can grab it
 * while an async order is in flight. Must be called immediately after
 * getIdleSlot(), before any await.
 */
export function reserveSlot(slotId: number): void {
  const slot = findSlot(slotId);
  slot.status = "pending";
}

/**
 * Returns a "pending" slot back to "idle" when an order fails before
 * assignBet() is reached (e.g. FOK rejection, balance check failure).
 */
export function releaseSlot(slotId: number): void {
  const slot = findSlot(slotId);
  slot.status = "idle";
}

export function assignBet(slotId: number, bet: ActiveBet): void {
  const slot = findSlot(slotId);
  slot.status = "active";
  slot.activeBet = bet;
  log.info("SLOT_ASSIGNED", {
    slotId,
    betId: bet.betId,
    marketId: bet.market.id,
    asset: bet.market.asset,
    side: bet.side,
    stakeUsd: bet.stakeUsd,
    priceAtBet: bet.priceAtBet,
    rule: bet.rule,
    balanceBefore: slot.balance,
    shadow: bet.shadow,
  });
}

export function recordWin(slotId: number, payoutUsd: number): void {
  const slot = findSlot(slotId);
  const bet = slot.activeBet!;
  const profit = payoutUsd - bet.stakeUsd;
  const balanceBefore = slot.balance;

  slot.balance += profit;
  slot.wins++;
  slot.ruleStats[bet.rule].wins++;
  slot.ruleStats[bet.rule].totalWinAmount += profit;

  const eventBase = {
    slotId, betId: bet.betId, marketId: bet.market.id,
    asset: bet.market.asset, side: bet.side, rule: bet.rule,
    stakeUsd: bet.stakeUsd,
    payoutUsd: round2(payoutUsd),
    profitUsd: round2(profit),
    balanceBefore: round2(balanceBefore),
    balanceAfter: round2(slot.balance),
    shadow: bet.shadow,
  };

  log.info("SLOT_WIN_COMPOUND", eventBase);

  const threshold = slot.initialBalance * CONFIG.slotProfitMultiplier;
  if (slot.balance >= threshold) {
    const extracted = round2(slot.balance - slot.initialBalance);
    slot.totalProfitExtracted += extracted;
    slot.balance = slot.initialBalance;
    log.info("SLOT_PROFIT_EXTRACTED", {
      ...eventBase,
      profitExtracted: extracted,
      totalProfitExtracted: round2(slot.totalProfitExtracted),
      balanceResetTo: slot.initialBalance,
      threshold: round2(threshold),
    });
  }

  clearSlot(slot);
}

export function recordLoss(slotId: number, actualLossUsd?: number): void {
  const slot = findSlot(slotId);
  const bet = slot.activeBet!;
  const balanceBefore = slot.balance;

  // If actualLossUsd is provided (e.g. early close with partial loss), use it.
  // Otherwise fall back to the full stake (natural expiry = full capital lost).
  const loss = actualLossUsd !== undefined ? actualLossUsd : bet.stakeUsd;
  const excessForfeit = round2(Math.max(0, balanceBefore - slot.initialBalance));

  slot.totalLost += loss;
  slot.losses++;
  slot.ruleStats[bet.rule].losses++;
  slot.ruleStats[bet.rule].totalLost += loss;

  // Reset balance to initial — excess compounded gain is forfeited back to base.
  slot.balance = slot.initialBalance;

  log.info("SLOT_LOSS_RESET", {
    slotId, betId: bet.betId, marketId: bet.market.id,
    asset: bet.market.asset, side: bet.side, rule: bet.rule,
    stakeUsd: bet.stakeUsd,
    balanceBefore: round2(balanceBefore),
    actualLossUsd: round2(loss),
    excessForfeit,
    balanceAfter: round2(slot.balance),
    totalLostOnSlot: round2(slot.totalLost),
    shadow: bet.shadow,
  });

  clearSlot(slot);
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function findSlot(id: number): Slot {
  const s = slots.find((s) => s.id === id);
  if (!s) throw new Error(`Slot ${id} not found`);
  return s;
}

function clearSlot(slot: Slot): void {
  slot.status = "idle";
  slot.activeBet = undefined;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
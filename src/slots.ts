/**
 * slots.ts — Compounding slot machine (straddle edition).
 *
 * Changes from v1:
 *   - activeBet → activeStraddle (StraddlePosition)
 *   - recordWin(slotId, payoutUsd, totalCostUsd)
 *   - recordLoss(slotId, lostUsd)
 *   - emptyRuleStats(): only "5m" | "15m"
 *   - enableCompounding toggle
 */

import { CONFIG } from "./config.js";
import { log } from "./logger.js";
import type { StraddlePosition, BetRule } from "./types.js";

export type SlotStatus = "idle" | "pending" | "active";

export interface RuleStats {
  wins: number;
  losses: number;
  totalWinAmount: number;
  totalLost: number;
}

export interface Slot {
  id: number;
  status: SlotStatus;
  balance: number;
  initialBalance: number;
  totalProfitExtracted: number;
  totalLost: number;
  wins: number;
  losses: number;
  ruleStats: Record<BetRule, RuleStats>;
  activeStraddle?: StraddlePosition;
}

const slots: Slot[] = [];

function emptyRuleStats(): Record<BetRule, RuleStats> {
  return {
    "5m":  { wins: 0, losses: 0, totalWinAmount: 0, totalLost: 0 },
    "15m": { wins: 0, losses: 0, totalWinAmount: 0, totalLost: 0 },
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

export function resetSlots(): ReturnType<typeof getSummary> {
  const summaryBeforeReset = getSummary();

  for (const slot of slots) {
    if (slot.status === "active" && slot.activeStraddle) continue;

    slot.status = "idle";
    slot.balance = CONFIG.slotInitialUsd;
    slot.initialBalance = CONFIG.slotInitialUsd;
    slot.totalProfitExtracted = 0;
    slot.totalLost = 0;
    slot.wins = 0;
    slot.losses = 0;
    slot.ruleStats = emptyRuleStats();
    slot.activeStraddle = undefined;
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

export function getSnapshot(): Omit<Slot, "activeStraddle">[] {
  return slots.map(({ id, status, balance, initialBalance,
    totalProfitExtracted, totalLost, wins, losses, ruleStats }) => ({
    id, status, balance, initialBalance,
    totalProfitExtracted, totalLost, wins, losses, ruleStats,
  }));
}

export function getActiveStraddles(): StraddlePosition[] {
  return slots.flatMap((s) => (s.activeStraddle ? [s.activeStraddle] : []));
}

export function getSummary() {
  const totalBalance         = slots.reduce((s, slot) => s + slot.balance, 0);
  const totalProfitExtracted = slots.reduce((s, slot) => s + slot.totalProfitExtracted, 0);
  const totalLost            = slots.reduce((s, slot) => s + slot.totalLost, 0);
  const totalWins            = slots.reduce((s, slot) => s + slot.wins, 0);
  const totalLosses          = slots.reduce((s, slot) => s + slot.losses, 0);
  const activeSlots          = slots.filter((s) => s.status === "active").length;

  const rules: Record<BetRule, RuleStats> = emptyRuleStats();
  for (const slot of slots) {
    for (const rule of ["5m", "15m"] as BetRule[]) {
      rules[rule].wins           += slot.ruleStats[rule].wins;
      rules[rule].losses         += slot.ruleStats[rule].losses;
      rules[rule].totalWinAmount += slot.ruleStats[rule].totalWinAmount;
      rules[rule].totalLost      += slot.ruleStats[rule].totalLost;
    }
  }

  const ruleBreakdown = {} as Record<BetRule, {
    wins: number; losses: number; totalTrades: number; winRate: number;
    totalWinAmount: number; avgWinAmount: number; totalLost: number; netPnl: number;
  }>;
  for (const rule of ["5m", "15m"] as BetRule[]) {
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
    ? round2(slots.reduce((s, slot) => s + slot.ruleStats["5m"].totalWinAmount + slot.ruleStats["15m"].totalWinAmount, 0))
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

export function reserveSlot(slotId: number): void {
  const slot = findSlot(slotId);
  slot.status = "pending";
}

export function releaseSlot(slotId: number): void {
  const slot = findSlot(slotId);
  slot.status = "idle";
}

export function assignStraddle(slotId: number, straddle: StraddlePosition): void {
  const slot = findSlot(slotId);
  slot.status = "active";
  slot.activeStraddle = straddle;
  log.info("SLOT_ASSIGNED", {
    slotId,
    straddleId: straddle.id,
    marketId: straddle.market.id,
    asset: straddle.market.asset,
    rule: straddle.rule,
    stakeUsd: straddle.stakeUsd,
    shadow: straddle.shadow,
  });
}

export function recordWin(slotId: number, payoutUsd: number, totalCostUsd: number): void {
  const slot = findSlot(slotId);
  const straddle = slot.activeStraddle!;
  const profit = payoutUsd - totalCostUsd;
  const balanceBefore = slot.balance;

  slot.balance += profit;
  slot.wins++;
  slot.ruleStats[straddle.rule].wins++;
  slot.ruleStats[straddle.rule].totalWinAmount += profit;

  log.info("SLOT_WIN", {
    slotId, straddleId: straddle.id, rule: straddle.rule,
    payoutUsd: round2(payoutUsd), totalCostUsd: round2(totalCostUsd),
    profitUsd: round2(profit),
    balanceBefore: round2(balanceBefore), balanceAfter: round2(slot.balance),
    shadow: straddle.shadow,
  });

  if (CONFIG.enableCompounding) {
    const threshold = slot.initialBalance * CONFIG.slotProfitMultiplier;
    if (slot.balance >= threshold) {
      const extracted = round2(slot.balance - slot.initialBalance);
      slot.totalProfitExtracted += extracted;
      slot.balance = slot.initialBalance;
      log.info("SLOT_PROFIT_EXTRACTED", {
        slotId, profitExtracted: extracted,
        totalProfitExtracted: round2(slot.totalProfitExtracted),
        balanceResetTo: slot.initialBalance,
      });
    }
  }

  clearSlot(slot);
}

export function recordLoss(slotId: number, lostUsd: number): void {
  const slot = findSlot(slotId);
  const straddle = slot.activeStraddle!;
  const balanceBefore = slot.balance;

  slot.totalLost += lostUsd;
  slot.losses++;
  slot.ruleStats[straddle.rule].losses++;
  slot.ruleStats[straddle.rule].totalLost += lostUsd;

  slot.balance = slot.initialBalance;

  log.info("SLOT_LOSS_RESET", {
    slotId, straddleId: straddle.id, rule: straddle.rule,
    lostUsd: round2(lostUsd),
    balanceBefore: round2(balanceBefore), balanceAfter: round2(slot.balance),
    shadow: straddle.shadow,
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
  slot.activeStraddle = undefined;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

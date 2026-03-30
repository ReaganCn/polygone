/**
 * slots.ts — Compounding slot machine.
 *
 * FIXES APPLIED:
 *
 * [T2] Race condition — reserveSlot() added.
 *   handleLiveBet/handleShadowBet must call reserveSlot(slotId) synchronously
 *   before any await. This marks the slot "active" with no activeBet yet,
 *   so getIdleSlot() cannot hand the same slot to a concurrent qualifying event.
 *   assignBet() is then called once the order fills to attach the real bet.
 *   If the order fails, releaseReservedSlot() restores the slot to idle.
 *   All three mutation functions (recordWin, recordLoss, recordStopLoss) already
 *   guard against missing activeBet — they remain safe during the reserved window.
 *
 * [A2] Stop-loss recovered now exact.
 *   RuleStats gains totalStopLossStaked (sum of stakeUsd for every SL trade).
 *   recordStopLoss increments it alongside totalStopLossNetLost.
 *   getSummary exposes it so api.ts can compute exact recovered =
 *   totalStopLossStaked - totalStopLossNetLost, rather than estimating from
 *   stopLosses × CONFIG.slotInitialUsd which was wrong for compounded slots.
 *
 * [S2] Seeded capital snapshot.
 *   getSeededCapital() returns the capital actually seeded at initialiseSlots()
 *   time (numSlots × slotInitialUsd frozen at startup). api.ts uses this for
 *   netPnl calculation so the figure doesn't drift when POST /config changes
 *   slotInitialUsd or numSlots mid-session.
 *
 * Loss accounting (unchanged):
 *   A loss wipes the STAKE (initialBalance), not the accumulated balance.
 *   If a slot had compounded to $1.10 but only bet $1 (its initialBalance),
 *   the loss destroys $1 — the extra $0.10 never left the slot.
 *
 * Stop-loss accounting (unchanged):
 *   recordStopLoss(slotId, recoveredUsd) is called when the sell order fills.
 *   Net loss = stakeUsd - recoveredUsd.
 *   The slot is reset to initialBalance exactly like a normal loss.
 */

import { CONFIG } from "./config.js";
import { log } from "./logger.js";
import type { ActiveBet, BetRule } from "./types.js";

export type SlotStatus = "idle" | "reserved" | "active";

export interface RuleStats {
  wins: number;
  losses: number;
  stopLosses: number;
  totalWinAmount: number;
  totalLost: number;
  totalStopLossNetLost: number;
  /** Sum of stakeUsd for every stop-loss trade — used to compute exact recovered. */
  totalStopLossStaked: number;
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
  stopLosses: number;
  ruleStats: Record<BetRule, RuleStats>;
  activeBet?: ActiveBet;
}

const slots: Slot[] = [];

/** Capital frozen at initialiseSlots() time — never mutated by config changes. */
let seededCapital = 0;

function emptyRuleStats(): Record<BetRule, RuleStats> {
  return {
    "5m":      { wins: 0, losses: 0, stopLosses: 0, totalWinAmount: 0, totalLost: 0, totalStopLossNetLost: 0, totalStopLossStaked: 0 },
    "15m":     { wins: 0, losses: 0, stopLosses: 0, totalWinAmount: 0, totalLost: 0, totalStopLossNetLost: 0, totalStopLossStaked: 0 },
    "fallback":{ wins: 0, losses: 0, stopLosses: 0, totalWinAmount: 0, totalLost: 0, totalStopLossNetLost: 0, totalStopLossStaked: 0 },
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
      stopLosses: 0,
      ruleStats: emptyRuleStats(),
    });
  }
  seededCapital = round2(CONFIG.numSlots * CONFIG.slotInitialUsd);
  log.info("SLOT_STATE_SNAPSHOT", { action: "initialised", seededCapital, slots: getSnapshot() });
}

// ─── queries ──────────────────────────────────────────────────────────────────

/**
 * Returns the capital that was actually seeded at startup.
 * Safe to use in P&L calculations even after POST /config changes slotInitialUsd.
 */
export function getSeededCapital(): number {
  return seededCapital;
}

/** Only "idle" slots are eligible — "reserved" slots are already spoken for. */
export function getIdleSlot(): Slot | null {
  const activeCount = Math.min(slots.length, CONFIG.numSlots);
  for (let i = 0; i < activeCount; i++) {
    if (slots[i].status === "idle") return slots[i];
  }
  return null;
}

export function getSnapshot(): Omit<Slot, "activeBet">[] {
  return slots.map(({ id, status, balance, initialBalance,
    totalProfitExtracted, totalLost, wins, losses, stopLosses, ruleStats }) => ({
    id, status, balance, initialBalance,
    totalProfitExtracted, totalLost, wins, losses, stopLosses, ruleStats,
  }));
}

export function getActiveBets(): ActiveBet[] {
  return slots.flatMap((s) => (s.activeBet ? [s.activeBet] : []));
}

export function getSummary() {
  const totalBalance         = slots.reduce((s, slot) => s + slot.balance, 0);
  const totalProfitExtracted = slots.reduce((s, slot) => s + slot.totalProfitExtracted, 0);
  const totalLost            = slots.reduce((s, slot) => s + slot.totalLost, 0);
  const totalWins            = slots.reduce((s, slot) => s + slot.wins, 0);
  const totalLosses          = slots.reduce((s, slot) => s + slot.losses, 0);
  const totalStopLosses      = slots.reduce((s, slot) => s + slot.stopLosses, 0);
  const activeSlots          = slots.filter((s) => s.status === "active").length;

  const rules: Record<BetRule, RuleStats> = {
    "5m":      { wins: 0, losses: 0, stopLosses: 0, totalWinAmount: 0, totalLost: 0, totalStopLossNetLost: 0, totalStopLossStaked: 0 },
    "15m":     { wins: 0, losses: 0, stopLosses: 0, totalWinAmount: 0, totalLost: 0, totalStopLossNetLost: 0, totalStopLossStaked: 0 },
    "fallback":{ wins: 0, losses: 0, stopLosses: 0, totalWinAmount: 0, totalLost: 0, totalStopLossNetLost: 0, totalStopLossStaked: 0 },
  };
  for (const slot of slots) {
    for (const rule of ["5m", "15m", "fallback"] as BetRule[]) {
      rules[rule].wins                 += slot.ruleStats[rule].wins;
      rules[rule].losses               += slot.ruleStats[rule].losses;
      rules[rule].stopLosses           += slot.ruleStats[rule].stopLosses;
      rules[rule].totalWinAmount       += slot.ruleStats[rule].totalWinAmount;
      rules[rule].totalLost            += slot.ruleStats[rule].totalLost;
      rules[rule].totalStopLossNetLost += slot.ruleStats[rule].totalStopLossNetLost;
      rules[rule].totalStopLossStaked  += slot.ruleStats[rule].totalStopLossStaked;
    }
  }

  const ruleBreakdown = {} as Record<BetRule, {
    wins: number; losses: number; stopLosses: number;
    totalTrades: number; winRate: number;
    totalWinAmount: number; avgWinAmount: number;
    totalLost: number; totalStopLossNetLost: number; totalStopLossStaked: number;
    avgStopLossNetLost: number; netPnl: number;
  }>;
  for (const rule of ["5m", "15m", "fallback"] as BetRule[]) {
    const r = rules[rule];
    const totalTrades = r.wins + r.losses + r.stopLosses;
    ruleBreakdown[rule] = {
      wins: r.wins,
      losses: r.losses,
      stopLosses: r.stopLosses,
      totalTrades,
      winRate:              totalTrades > 0 ? round2((r.wins / totalTrades) * 100) : 0,
      totalWinAmount:       round2(r.totalWinAmount),
      avgWinAmount:         r.wins > 0 ? round2(r.totalWinAmount / r.wins) : 0,
      totalLost:            round2(r.totalLost),
      totalStopLossNetLost: round2(r.totalStopLossNetLost),
      totalStopLossStaked:  round2(r.totalStopLossStaked),
      avgStopLossNetLost:   r.stopLosses > 0 ? round2(r.totalStopLossNetLost / r.stopLosses) : 0,
      netPnl:               round2(r.totalWinAmount - r.totalLost),
    };
  }

  const totalWinAmount = slots.reduce((s, slot) =>
    s + slot.ruleStats["5m"].totalWinAmount
      + slot.ruleStats["15m"].totalWinAmount
      + slot.ruleStats["fallback"].totalWinAmount, 0);

  return {
    totalSlots: slots.length,
    activeSlots,
    idleSlots: slots.length - activeSlots,
    totalBalance:         round2(totalBalance),
    totalProfitExtracted: round2(totalProfitExtracted),
    totalLost:            round2(totalLost),
    totalWins,
    totalLosses,
    totalStopLosses,
    totalTrades:  totalWins + totalLosses + totalStopLosses,
    winRate:      (totalWins + totalLosses + totalStopLosses) > 0
      ? round2((totalWins / (totalWins + totalLosses + totalStopLosses)) * 100)
      : 0,
    avgWinAmount: totalWins > 0 ? round2(totalWinAmount / totalWins) : 0,
    byRule: ruleBreakdown,
  };
}

// ─── mutations ────────────────────────────────────────────────────────────────

/**
 * [T2] Reserve a slot synchronously before any async order placement.
 *
 * Sets status to "reserved" so getIdleSlot() skips it, preventing a second
 * concurrent qualifying event from grabbing the same slot while placeOrder
 * is awaiting. No activeBet is set yet — that happens in assignBet() once
 * the order fills. If the order fails, call releaseReservedSlot() to restore
 * the slot to idle.
 */
export function reserveSlot(slotId: number): void {
  const slot = findSlot(slotId);
  if (slot.status !== "idle") {
    throw new Error(`Slot ${slotId} is not idle (status: ${slot.status}) — cannot reserve`);
  }
  slot.status = "reserved";
  log.info("SLOT_RESERVED", { slotId, balance: slot.balance });
}

/**
 * [T2] Release a reserved slot back to idle when order placement fails.
 * Safe to call on an already-idle slot (no-op with a warning).
 */
export function releaseReservedSlot(slotId: number): void {
  const slot = findSlot(slotId);
  if (slot.status === "active") {
    log.warn("WARN", {
      message: "releaseReservedSlot called on active slot — ignoring",
      slotId,
    });
    return;
  }
  if (slot.status === "idle") {
    log.warn("WARN", {
      message: "releaseReservedSlot called on already-idle slot — ignoring",
      slotId,
    });
    return;
  }
  slot.status = "idle";
  log.info("SLOT_RELEASED", { slotId, balance: slot.balance });
}

export function assignBet(slotId: number, bet: ActiveBet): void {
  const slot = findSlot(slotId);
  // Accept both "reserved" (normal live/shadow path) and "idle" (legacy callers
  // or tests that skip reserveSlot). Never overwrite an already-active slot.
  if (slot.status === "active") {
    log.warn("WARN", {
      message: "assignBet called on already-active slot — ignoring to prevent orphan overwrite",
      slotId, betId: bet.betId,
    });
    return;
  }
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
  const bet = slot.activeBet;

  if (!bet) {
    log.warn("WARN", {
      message: "recordWin called but slot has no activeBet — possible double-fire, ignoring",
      slotId, payoutUsd,
    });
    return;
  }

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

export function recordLoss(slotId: number): void {
  const slot = findSlot(slotId);
  const bet = slot.activeBet;

  if (!bet) {
    log.warn("WARN", {
      message: "recordLoss called but slot has no activeBet — possible double-fire, ignoring",
      slotId,
    });
    return;
  }

  const balanceBefore = slot.balance;
  const stakeAtRisk = bet.stakeUsd;

  slot.totalLost += stakeAtRisk;
  slot.losses++;
  slot.ruleStats[bet.rule].losses++;
  slot.ruleStats[bet.rule].totalLost += stakeAtRisk;

  slot.balance = slot.initialBalance;

  log.info("SLOT_LOSS_RESET", {
    slotId, betId: bet.betId, marketId: bet.market.id,
    asset: bet.market.asset, side: bet.side, rule: bet.rule,
    stakeUsd: bet.stakeUsd,
    balanceBefore: round2(balanceBefore),
    stakeAtRisk,
    balanceAfter: round2(slot.balance),
    totalLostOnSlot: round2(slot.totalLost),
    shadow: bet.shadow,
  });

  clearSlot(slot);
}

/**
 * Called when a stop-loss sell completes (fully or partially filled).
 *
 * recoveredUsd = actual USDC returned by the sell order.
 * Net loss = stakeUsd - recoveredUsd.
 * The slot is reset to initialBalance exactly like a normal loss.
 *
 * [A2] Also records stakeUsd into totalStopLossStaked so api.ts can
 * compute exact recovered = totalStopLossStaked - totalStopLossNetLost.
 */
export function recordStopLoss(slotId: number, recoveredUsd: number): void {
  const slot = findSlot(slotId);
  const bet = slot.activeBet;

  if (!bet) {
    log.warn("WARN", {
      message: "recordStopLoss called but slot has no activeBet — possible double-fire, ignoring",
      slotId, recoveredUsd,
    });
    return;
  }

  const balanceBefore = slot.balance;
  const netLoss = round2(Math.max(0, bet.stakeUsd - recoveredUsd));

  slot.totalLost += netLoss;
  slot.stopLosses++;
  slot.ruleStats[bet.rule].stopLosses++;
  slot.ruleStats[bet.rule].totalLost            += netLoss;
  slot.ruleStats[bet.rule].totalStopLossNetLost += netLoss;
  slot.ruleStats[bet.rule].totalStopLossStaked  += bet.stakeUsd;  // [A2]

  slot.balance = slot.initialBalance;

  log.info("SLOT_STOP_LOSS", {
    slotId, betId: bet.betId, marketId: bet.market.id,
    asset: bet.market.asset, side: bet.side, rule: bet.rule,
    stakeUsd: bet.stakeUsd,
    recoveredUsd: round2(recoveredUsd),
    netLoss,
    balanceBefore: round2(balanceBefore),
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

// ─── daily reset ──────────────────────────────────────────────────────────────

/**
 * Resets the balance and initialBalance of every idle slot back to
 * CONFIG.slotInitialUsd. Active and reserved slots (with in-flight bets)
 * are skipped so running trades are not disrupted.
 *
 * Returns the number of slots that were reset.
 * Called by the midnight UTC scheduler in index.ts and by POST /reset-slots.
 */
export function resetAllSlots(): number {
  let resetCount = 0;
  for (const slot of slots) {
    if (slot.status !== "idle") continue;
    const balanceBefore = slot.balance;
    slot.balance = CONFIG.slotInitialUsd;
    slot.initialBalance = CONFIG.slotInitialUsd;
    log.info("SLOT_RESET", {
      slotId: slot.id,
      balanceBefore: round2(balanceBefore),
      balanceAfter: round2(slot.balance),
    });
    resetCount++;
  }
  log.info("SLOT_STATE_SNAPSHOT", {
    action: "daily_reset",
    resetCount,
    skippedActive: slots.length - resetCount,
    slots: getSnapshot(),
  });
  return resetCount;
}
/**
 * slots.ts
 *
 * Manages the array of compounding "slots".
 *
 * Each slot holds:
 *   - A current balance (starts at slotInitialUsd, compounds on wins)
 *   - An "active" / "idle" status
 *   - A reference to the currently active bet (if any)
 *
 * Compounding rules:
 *   WIN  → balance += (payout - stake). If balance ≥ initial × profitMultiplier,
 *           extract profit → reset balance to initial. Log the extraction.
 *   LOSS → losses are always 100% of stake → reset balance to initial.
 *
 * The CONFIG values for numSlots, slotInitialUsd, and slotProfitMultiplier
 * are read dynamically so hot-updates via the API take effect on the next
 * relevant event.
 */

import { CONFIG } from "./config.js";
import { log } from "./logger.js";
import type { ActiveBet } from "./types.js";

// ─── types ───────────────────────────────────────────────────────────────────

export type SlotStatus = "idle" | "active";

export interface Slot {
  id: number;
  status: SlotStatus;
  /** Current compounded balance in USDC */
  balance: number;
  /** The original per-slot starting amount (captured at slot creation) */
  initialBalance: number;
  /** Total lifetime profit extracted from this slot */
  totalProfitExtracted: number;
  /** Total wins recorded on this slot */
  wins: number;
  /** Total losses recorded on this slot */
  losses: number;
  /** The bet currently assigned to this slot (if active) */
  activeBet?: ActiveBet;
}

// ─── module state ─────────────────────────────────────────────────────────────

const slots: Slot[] = [];

// ─── initialise ───────────────────────────────────────────────────────────────

/**
 * Build the initial slot array using the current CONFIG.
 * Called once at startup from index.ts.
 */
export function initialiseSlots(): void {
  slots.length = 0;
  for (let i = 0; i < CONFIG.numSlots; i++) {
    slots.push({
      id: i + 1,
      status: "idle",
      balance: CONFIG.slotInitialUsd,
      initialBalance: CONFIG.slotInitialUsd,
      totalProfitExtracted: 0,
      wins: 0,
      losses: 0,
    });
  }
  log.info("SLOT_STATE_SNAPSHOT", {
    action: "initialised",
    slots: getSnapshot(),
  });
}

// ─── queries ──────────────────────────────────────────────────────────────────

/**
 * Returns the first idle slot, or null if all slots are occupied.
 */
export function getIdleSlot(): Slot | null {
  // Respect a possibly hot-updated numSlots by only looking at the
  // first N slots. Extra slots are effectively disabled.
  const activeCount = Math.min(slots.length, CONFIG.numSlots);
  for (let i = 0; i < activeCount; i++) {
    if (slots[i].status === "idle") return slots[i];
  }
  return null;
}

/**
 * Returns a snapshot of all slot states (safe to serialise).
 */
export function getSnapshot(): Omit<Slot, "activeBet">[] {
  return slots.map(({ id, status, balance, initialBalance, totalProfitExtracted, wins, losses }) => ({
    id,
    status,
    balance,
    initialBalance,
    totalProfitExtracted,
    wins,
    losses,
  }));
}

/**
 * Returns the full active bets list across all slots.
 */
export function getActiveBets(): ActiveBet[] {
  return slots.flatMap((s) => (s.activeBet ? [s.activeBet] : []));
}

/**
 * Summary statistics across all slots.
 */
export function getSummary(): Record<string, number> {
  const active = slots.filter((s) => s.status === "active").length;
  const totalBalance = slots.reduce((sum, s) => sum + s.balance, 0);
  const totalProfitExtracted = slots.reduce((sum, s) => sum + s.totalProfitExtracted, 0);
  const totalWins = slots.reduce((sum, s) => sum + s.wins, 0);
  const totalLosses = slots.reduce((sum, s) => sum + s.losses, 0);
  return {
    totalSlots: slots.length,
    activeSlots: active,
    idleSlots: slots.length - active,
    totalBalance: round2(totalBalance),
    totalProfitExtracted: round2(totalProfitExtracted),
    totalWins,
    totalLosses,
    winRate: totalWins + totalLosses > 0
      ? round2((totalWins / (totalWins + totalLosses)) * 100)
      : 0,
  };
}

// ─── mutations ────────────────────────────────────────────────────────────────

/**
 * Assign a bet to a slot. Marks the slot as active.
 */
export function assignBet(slotId: number, bet: ActiveBet): void {
  const slot = findSlot(slotId);
  slot.status = "active";
  slot.activeBet = bet;

  log.info("SLOT_ASSIGNED", {
    slotId,
    betId: bet.betId,
    marketId: bet.market.id,
    marketQuestion: bet.market.question,
    asset: bet.market.asset,
    side: bet.side,
    stakeUsd: bet.stakeUsd,
    priceAtBet: bet.priceAtBet,
    balanceBefore: slot.balance,
    shadow: bet.shadow,
  });
}

/**
 * Record a win for a slot.
 * Compounds the balance, extracts profit if the multiplier threshold is hit.
 * @param slotId   - which slot won
 * @param payoutUsd - total USDC received (stake + profit)
 */
export function recordWin(slotId: number, payoutUsd: number): void {
  const slot = findSlot(slotId);
  const bet = slot.activeBet!;
  const profit = payoutUsd - bet.stakeUsd;
  const balanceBefore = slot.balance;

  slot.balance += profit;
  slot.wins++;

  const eventBase = {
    slotId,
    betId: bet.betId,
    marketId: bet.market.id,
    asset: bet.market.asset,
    side: bet.side,
    stakeUsd: bet.stakeUsd,
    payoutUsd: round2(payoutUsd),
    profitUsd: round2(profit),
    balanceBefore: round2(balanceBefore),
    balanceAfter: round2(slot.balance),
    shadow: bet.shadow,
  };

  log.info("SLOT_WIN_COMPOUND", eventBase);

  // Check profit extraction threshold
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

/**
 * Record a loss for a slot.
 * On Polymarket up/down markets at 99¢, a loss = 100% of stake.
 * Resets the slot balance to its initial amount.
 */
export function recordLoss(slotId: number): void {
  const slot = findSlot(slotId);
  const bet = slot.activeBet!;
  const balanceBefore = slot.balance;

  slot.losses++;
  slot.balance = slot.initialBalance; // always reset to initial on loss

  log.info("SLOT_LOSS_RESET", {
    slotId,
    betId: bet.betId,
    marketId: bet.market.id,
    asset: bet.market.asset,
    side: bet.side,
    stakeUsd: bet.stakeUsd,
    balanceBefore: round2(balanceBefore),
    balanceAfter: round2(slot.balance),
    shadow: bet.shadow,
  });

  clearSlot(slot);
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function findSlot(slotId: number): Slot {
  const slot = slots.find((s) => s.id === slotId);
  if (!slot) throw new Error(`Slot ${slotId} not found`);
  return slot;
}

function clearSlot(slot: Slot): void {
  slot.status = "idle";
  slot.activeBet = undefined;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

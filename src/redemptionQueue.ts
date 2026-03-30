/**
 * redemptionQueue.ts — Sequential redemption queue with persistence and retry.
 *
 * Instead of firing redeemAfterWin() concurrently (which causes on-chain
 * collisions), this module queues redemptions and processes them one at a time
 * with 15s spacing. After each redemption, it verifies on-chain that the
 * tokens were actually redeemed. Failed redemptions are retried up to 5 times.
 *
 * Queue is persisted to ./data/redemption-queue.json so pending entries
 * survive bot restarts.
 */

import fs from "fs";
import path from "path";
import { CONFIG } from "./config.js";
import { log } from "./logger.js";
import { redeemAfterWin, verifyRedemption } from "./redeemer.js";
import type { Market } from "./types.js";

// ─── Types ───────────────────────────────────────────────────────────────────

type RedemptionStatus = "pending" | "processing" | "completed" | "failed";

interface RedemptionEntry {
  id: string;
  market: Market;
  status: RedemptionStatus;
  attempts: number;
  maxAttempts: number;
  enqueuedAt: string;
  lastAttemptAt: string | null;
  completedAt: string | null;
  error: string | null;
}

// Serialisable subset stored on disk (Market is stored as-is since it's a plain object)
interface PersistedQueue {
  entries: RedemptionEntry[];
}

// ─── State ───────────────────────────────────────────────────────────────────

const entries: RedemptionEntry[] = [];
let processorHandle: ReturnType<typeof setInterval> | null = null;
let isProcessing = false;

const DATA_DIR = "./data";
const QUEUE_FILE = path.join(DATA_DIR, "redemption-queue.json");
const MAX_ATTEMPTS = 5;
const PROCESS_INTERVAL_MS = 15_000;
const MIN_RETRY_GAP_MS = 10_000;

// ─── Persistence ─────────────────────────────────────────────────────────────

function saveToDisk(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    // Only persist pending/processing/failed — completed entries are pruned
    const toSave: PersistedQueue = {
      entries: entries.filter(e => e.status !== "completed"),
    };
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(toSave, null, 2), "utf8");
  } catch (err) {
    log.error("ERROR", { message: "Failed to save redemption queue", error: (err as Error).message });
  }
}

function loadFromDisk(): void {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return;
    const raw = fs.readFileSync(QUEUE_FILE, "utf8");
    const data: PersistedQueue = JSON.parse(raw);
    if (!Array.isArray(data.entries)) return;

    for (const entry of data.entries) {
      // Restore pending/failed entries so they get retried
      if (entry.status === "processing") entry.status = "pending"; // was mid-flight when bot died
      if (entry.status === "pending" || entry.status === "failed") {
        // Only re-queue if under max attempts
        if (entry.attempts < entry.maxAttempts) {
          entry.status = "pending";
          entries.push(entry);
        } else {
          entry.status = "failed";
          entries.push(entry);
        }
      }
    }

    if (entries.length > 0) {
      log.info("INFO", { message: `Loaded ${entries.length} pending redemption(s) from disk` });
    }
  } catch (err) {
    log.warn("WARN", { message: "Failed to load redemption queue from disk", error: (err as Error).message });
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function enqueueRedemption(market: Market): void {
  if (CONFIG.shadowMode) return;

  // Avoid duplicate entries for the same conditionId
  const existing = entries.find(e => e.market.conditionId === market.conditionId && (e.status === "pending" || e.status === "processing"));
  if (existing) {
    log.info("INFO", { message: "Redemption already queued", conditionId: market.conditionId });
    return;
  }

  const entry: RedemptionEntry = {
    id: `redeem-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    market,
    status: "pending",
    attempts: 0,
    maxAttempts: MAX_ATTEMPTS,
    enqueuedAt: new Date().toISOString(),
    lastAttemptAt: null,
    completedAt: null,
    error: null,
  };

  entries.push(entry);
  saveToDisk();

  log.info("INFO", {
    message: "Redemption enqueued",
    id: entry.id,
    conditionId: market.conditionId,
    market: market.question,
    pendingCount: entries.filter(e => e.status === "pending").length,
  });
}

export function startRedemptionQueue(): void {
  loadFromDisk();

  if (processorHandle) return;
  processorHandle = setInterval(processNext, PROCESS_INTERVAL_MS);
  processorHandle.unref();

  log.info("INFO", { message: "Redemption queue processor started", intervalMs: PROCESS_INTERVAL_MS });
}

export function stopRedemptionQueue(): void {
  if (processorHandle) {
    clearInterval(processorHandle);
    processorHandle = null;
  }
}

export function getRedemptionStatus(): Omit<RedemptionEntry, "market">[] & { market: string; conditionId: string }[] {
  return entries.map(e => ({
    id: e.id,
    market: e.market.question,
    conditionId: e.market.conditionId,
    status: e.status,
    attempts: e.attempts,
    maxAttempts: e.maxAttempts,
    enqueuedAt: e.enqueuedAt,
    lastAttemptAt: e.lastAttemptAt,
    completedAt: e.completedAt,
    error: e.error,
  }));
}

// ─── Processor ───────────────────────────────────────────────────────────────

async function processNext(): Promise<void> {
  if (isProcessing) return;

  const now = Date.now();

  // Find first pending entry that hasn't been attempted too recently
  const entry = entries.find(e =>
    e.status === "pending" &&
    (!e.lastAttemptAt || now - new Date(e.lastAttemptAt).getTime() >= MIN_RETRY_GAP_MS)
  );

  if (!entry) return;

  isProcessing = true;
  entry.status = "processing";
  entry.attempts++;
  entry.lastAttemptAt = new Date().toISOString();
  entry.error = null;
  saveToDisk();

  log.info("INFO", {
    message: `Processing redemption (attempt ${entry.attempts}/${entry.maxAttempts})`,
    id: entry.id,
    conditionId: entry.market.conditionId,
    market: entry.market.question,
  });

  try {
    // Attempt redemption with a quick settlement check so one unsettled market
    // does not block all queued redemptions.
    await redeemAfterWin(entry.market, { settlementMaxChecks: 1, settlementPollMs: 0 });

    // Wait a moment for on-chain state to propagate
    await new Promise(r => setTimeout(r, 5000));

    // Verify on-chain that tokens are actually gone
    const verified = await verifyRedemption(entry.market);

    if (verified) {
      entry.status = "completed";
      entry.completedAt = new Date().toISOString();
      log.info("INFO", {
        message: "Redemption verified on-chain",
        id: entry.id,
        conditionId: entry.market.conditionId,
        market: entry.market.question,
        attempts: entry.attempts,
      });
    } else {
      // Tokens still present — retry
      if (entry.attempts >= entry.maxAttempts) {
        entry.status = "failed";
        entry.error = "Max attempts reached — tokens still present on-chain";
        log.error("ERROR", {
          message: "Redemption permanently failed",
          id: entry.id,
          conditionId: entry.market.conditionId,
          market: entry.market.question,
          attempts: entry.attempts,
        });
      } else {
        entry.status = "pending";
        entry.error = "Tokens still present after redemption tx — will retry";
        log.warn("WARN", {
          message: "Redemption not verified — will retry",
          id: entry.id,
          conditionId: entry.market.conditionId,
          attempts: entry.attempts,
          maxAttempts: entry.maxAttempts,
        });
      }
    }
  } catch (err) {
    const errorMsg = (err as Error).message;
    if (entry.attempts >= entry.maxAttempts) {
      entry.status = "failed";
      entry.error = errorMsg;
      log.error("ERROR", {
        message: "Redemption permanently failed",
        id: entry.id,
        conditionId: entry.market.conditionId,
        error: errorMsg,
        attempts: entry.attempts,
      });
    } else {
      entry.status = "pending";
      entry.error = errorMsg;
      log.warn("WARN", {
        message: "Redemption attempt failed — will retry",
        id: entry.id,
        conditionId: entry.market.conditionId,
        error: errorMsg,
        attempts: entry.attempts,
        maxAttempts: entry.maxAttempts,
      });
    }
  } finally {
    isProcessing = false;
    saveToDisk();
  }
}

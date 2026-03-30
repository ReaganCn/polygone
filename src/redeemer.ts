/**
 * redeemer.ts — Redeem winning CTF tokens for USDC.e after market resolution.
 *
 * ─── ROOT CAUSE OF THE PREVIOUS FAILURE ────────────────────────────────────
 * Polymarket positions are held by a Gnosis Safe (proxy wallet) that is
 * DETERMINISTICALLY DERIVED from your EOA address. Calling redeemPositions
 * directly on the CTF contract from the raw EOA does nothing — the tokens
 * don't live there. All on-chain actions (split, merge, redeem) MUST be
 * executed through the Safe via RelayClient.execute(), which submits the tx
 * to the Polymarket builder relayer and has it executed by the Safe.
 *
 * Source: https://github.com/Polymarket/py-clob-client/issues/139
 *         https://github.com/Polymarket/safe-wallet-integration
 *
 * ─── CORRECT ARCHITECTURE ───────────────────────────────────────────────────
 * 1. Derive the Safe address from your EOA (deterministic, no deployment needed
 *    if you are already trading — the Safe was deployed when you set up the bot).
 * 2. Query the Data API for positions held by the SAFE address (not the EOA).
 * 3. Poll the CTF contract's payoutNumerators directly for the resolution signal.
 * 4. Submit redeemPositions through RelayClient.execute() so the Safe executes it.
 *
 * ─── RESOLUTION TIMING ──────────────────────────────────────────────────────
 * Markets typically resolve 2–10 minutes after close. We poll the CTF contract
 * directly (payoutNumerators) rather than the Gamma API — it's the authoritative
 * on-chain signal and has no API lag. Two-speed polling:
 *   - Every 5 s for the first 2 minutes  → catches most wins within one or two polls
 *   - Every 15 s from 2–15 minutes       → handles slower oracles efficiently
 *   - Hard timeout at 15 minutes         → gives up without blocking the bot
 *
 * ─── FUNCTION NAMES ─────────────────────────────────────────────────────────
 * Public API is unchanged: redeemAfterWin() and sweepUnredeemedPositions()
 *
 * ─── ENV ─────────────────────────────────────────────────────────────────────
 *   POLY_BUILDER_API_KEY      — builder API key
 *   POLY_BUILDER_SECRET       — builder secret
 *   POLY_BUILDER_PASSPHRASE   — builder passphrase
 *   POLYGON_RPC_URL           — Polygon mainnet RPC
 *   PRIVATE_KEY               — trading wallet private key (EOA)
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  type Hex,
  encodeFunctionData,
  zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { RelayClient } from "@polymarket/builder-relayer-client";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { log } from "./logger.js";
import { CONFIG } from "./config.js";

// ─── Contract addresses (Polygon mainnet, official docs) ──────────────────────
// Source: https://docs.polymarket.com/resources/contract-addresses

const CTF_ADDRESS  = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" as const;
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as const;

// ─── API endpoints ────────────────────────────────────────────────────────────

const RELAYER_URL  = "https://relayer.polymarket.com/";
const DATA_API_URL = "https://data-api.polymarket.com";
const CHAIN_ID     = 137;

// ─── Retry / polling config ───────────────────────────────────────────────────

// Resolution polling: check on-chain every 5 s for the first 2 minutes,
// then every 15 s up to a 15-minute ceiling. For 2–10 min markets the first
// or second poll almost always hits. The 15-min ceiling catches slow oracles
// without blocking the bot for hours.
const RESOLUTION_POLL_FAST_INTERVAL_MS = 5_000;   // first 2 min: every 5 s
const RESOLUTION_POLL_FAST_DURATION_MS = 120_000;  // switch to slow after 2 min
const RESOLUTION_POLL_SLOW_INTERVAL_MS = 15_000;   // thereafter: every 15 s
const RESOLUTION_POLL_TIMEOUT_MS       = 900_000;  // give up after 15 min total

// After confirmed resolved, how often to retry a failed relay submission
const REDEEM_RETRY_DELAY_MS = 15_000;
const REDEEM_MAX_ATTEMPTS   = 5;

// Sweep: market is already known resolved, shorter patience
const SWEEP_RETRY_DELAY_MS = 15_000;
const SWEEP_MAX_ATTEMPTS   = 3;

// ─── redeemPositions ABI fragment ────────────────────────────────────────────
// Source: https://polygonscan.com/address/0x4d97dcd97ec945f40cf65f87097ace5ea0476045

const REDEEM_ABI = [{
  name: "redeemPositions",
  type: "function",
  stateMutability: "nonpayable",
  inputs: [
    { name: "collateralToken",    type: "address"   },
    { name: "parentCollectionId", type: "bytes32"   },
    { name: "conditionId",        type: "bytes32"   },
    { name: "indexSets",          type: "uint256[]" },
  ],
  outputs: [],
}] as const;

// ─── payoutNumerators ABI fragment ───────────────────────────────────────────
// Used to verify on-chain that reportPayouts() has been called before redeeming.

const PAYOUT_ABI = [{
  name: "payoutNumerators",
  type: "function",
  stateMutability: "view",
  inputs: [
    { name: "conditionId", type: "bytes32" },
    { name: "index",       type: "uint256" },
  ],
  outputs: [{ name: "", type: "uint256" }],
}] as const;

// ─── Lazy-initialised singletons ─────────────────────────────────────────────

let _client: RelayClient | null = null;
let _safeAddress: string | null = null;
let _eoaAddress:  string | null = null;

function getEoaAddress(): string {
  if (_eoaAddress) return _eoaAddress;
  const pk = process.env.PRIVATE_KEY as Hex;
  if (!pk) throw new Error("PRIVATE_KEY env var is not set");
  _eoaAddress = privateKeyToAccount(pk).address;
  return _eoaAddress;
}

/**
 * Returns the RelayClient, initialised once.
 * The RelayClient routes all transactions through the user's Gnosis Safe,
 * which is the actual holder of CTF token positions on Polymarket.
 */
function getRelayClient(): RelayClient {
  if (_client) return _client;

  const privateKey = process.env.PRIVATE_KEY as Hex;
  if (!privateKey) throw new Error("PRIVATE_KEY env var is not set");

  const account = privateKeyToAccount(privateKey);
  const wallet  = createWalletClient({
    account,
    chain:     polygon,
    transport: http(process.env.POLYGON_RPC_URL ?? "https://polygon-rpc.com"),
  });

  const builderConfig = new BuilderConfig({
    localBuilderCreds: {
      key:        process.env.POLY_BUILDER_API_KEY!,
      secret:     process.env.POLY_BUILDER_SECRET!,
      passphrase: process.env.POLY_BUILDER_PASSPHRASE!,
    },
  });

  _client = new RelayClient(RELAYER_URL, CHAIN_ID, wallet, builderConfig);
  return _client;
}

/**
 * Derives (or fetches) the Safe address for this EOA.
 *
 * Polymarket deploys a deterministic Gnosis Safe for every trading account.
 * ALL positions (CTF tokens) are held by this Safe, not the raw EOA.
 * We derive it via the RelayClient which knows the factory address.
 *
 * If derivation fails (e.g. Safe not yet deployed), we fall back to the EOA
 * so the Data API query at least returns something, though in practice the
 * bot should never be in this state if it has open positions to redeem.
 */
async function getSafeAddress(): Promise<string> {
  if (_safeAddress) return _safeAddress;
  try {
    const client = getRelayClient();
    // RelayClient exposes the derived Safe address via getAddress() / address property.
    // The exact API depends on the installed version; try common property names.
    const addr: string =
      (client as any).safeAddress ??
      (client as any).address ??
      (typeof (client as any).getAddress === "function"
        ? await (client as any).getAddress()
        : null);

    if (addr && addr.startsWith("0x")) {
      _safeAddress = addr;
      log.info("REDEEM_SAFE_DERIVED", { safeAddress: _safeAddress, eoa: getEoaAddress() });
      return _safeAddress;
    }
  } catch (err) {
    log.warn("REDEEM_SAFE_DERIVE_WARN", {
      error: (err as Error).message,
      fallback: "eoa",
    });
  }
  // Fallback: use EOA address for API queries (positions may not show up).
  _safeAddress = getEoaAddress();
  log.warn("REDEEM_SAFE_FALLBACK_EOA", { address: _safeAddress });
  return _safeAddress;
}

// ─── On-chain resolution check ────────────────────────────────────────────────

/**
 * Queries the CTF contract directly to verify that reportPayouts() has been
 * called for this conditionId. Returns true only if at least one payout
 * numerator is non-zero (i.e. the oracle has finalised the outcome).
 *
 * This is the authoritative signal — faster and more reliable than any API.
 */
async function isResolvedOnChain(conditionId: string): Promise<boolean> {
  try {
    const publicClient = createPublicClient({
      chain:     polygon,
      transport: http(process.env.POLYGON_RPC_URL ?? "https://polygon-rpc.com"),
    });

    // Check both index sets (YES=0, NO=1). If either is non-zero, oracle is done.
    const [p0, p1] = await Promise.all([
      publicClient.readContract({
        address:      CTF_ADDRESS,
        abi:          PAYOUT_ABI,
        functionName: "payoutNumerators",
        args:         [conditionId as Hex, BigInt(0)],
      }),
      publicClient.readContract({
        address:      CTF_ADDRESS,
        abi:          PAYOUT_ABI,
        functionName: "payoutNumerators",
        args:         [conditionId as Hex, BigInt(1)],
      }),
    ]);

    return p0 > BigInt(0) || p1 > BigInt(0);
  } catch {
    return false;
  }
}

// ─── Resolution polling ───────────────────────────────────────────────────────

/**
 * Polls the CTF contract's payoutNumerators directly until the oracle has
 * called reportPayouts() for this conditionId.
 *
 * Two-speed strategy:
 *   - First 2 minutes: poll every 5 s  (catches your typical 2–10 min markets fast)
 *   - After 2 minutes: poll every 15 s (saves RPC calls for slower oracles)
 *   - Hard timeout:    15 minutes total (gives up without blocking forever)
 *
 * Returns true the moment on-chain resolution is confirmed, false on timeout.
 */
async function waitForResolution(
  conditionId: string,
  question: string,
): Promise<boolean> {
  const startMs = Date.now();
  let attempt   = 0;

  while (true) {
    attempt++;
    const elapsedMs = Date.now() - startMs;

    if (elapsedMs >= RESOLUTION_POLL_TIMEOUT_MS) {
      log.error("REDEEM_RESOLUTION_TIMEOUT", {
        conditionId, question, elapsedMs, attempts: attempt,
      });
      return false;
    }

    try {
      const resolved = await isResolvedOnChain(conditionId);
      if (resolved) {
        log.info("REDEEM_RESOLUTION_CONFIRMED", {
          conditionId, question,
          elapsedMs: Date.now() - startMs,
          attempts: attempt,
          source: "onchain",
        });
        return true;
      }
    } catch (err) {
      log.warn("REDEEM_RESOLUTION_POLL_ERROR", {
        conditionId, question, attempt,
        error: (err as Error).message,
      });
    }

    log.info("REDEEM_RESOLUTION_POLLING", {
      conditionId, question, attempt, elapsedMs,
    });

    const intervalMs = elapsedMs < RESOLUTION_POLL_FAST_DURATION_MS
      ? RESOLUTION_POLL_FAST_INTERVAL_MS
      : RESOLUTION_POLL_SLOW_INTERVAL_MS;

    await sleep(intervalMs);
  }
}

// ─── Core redeem submission ───────────────────────────────────────────────────

/**
 * Builds and submits a redeemPositions transaction via the Polymarket builder
 * relayer. The relayer executes it through the user's Gnosis Safe, which is
 * the actual holder of the CTF token positions.
 *
 * Per the official docs, indexSets [1, 2] redeems both YES and NO outcome
 * tokens. Only the winning token produces a non-zero payout; the losing
 * token burns at $0. There is no amount parameter — the contract redeems
 * the entire balance.
 *
 * Returns true on success, false on relay failure (retryable), throws on
 * non-recoverable errors (auth, network, etc.).
 */
async function submitRedeem(conditionId: string): Promise<boolean> {
  const client = getRelayClient();

  const redeemCalldata = encodeFunctionData({
    abi:          REDEEM_ABI,
    functionName: "redeemPositions",
    args: [
      USDC_ADDRESS,
      zeroHash,               // parentCollectionId is always bytes32(0) for Polymarket
      conditionId as Hex,
      [BigInt(1), BigInt(2)], // YES index set = 1, NO index set = 2
    ],
  });

  const redeemTx = {
    to:    CTF_ADDRESS,
    data:  redeemCalldata,
    value: "0",
  };

  const response = await client.execute([redeemTx], "Redeem winning tokens");
  const result   = await response.wait();

  // The RelayerTransaction result has a `state` field. Only "confirmed" or
  // "success" mean the on-chain tx was mined. Anything else is a failure.
  const confirmed = result &&
    (result.state === "confirmed" || result.state === "success");

  return !!confirmed;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Called fire-and-forget after a live win is recorded. Polls for oracle
 * resolution (instead of a blind sleep), then submits the redeem through
 * the Safe via the builder relayer. Retries on relay failures.
 *
 * All errors are logged and swallowed — never throws.
 */
export async function redeemAfterWin(
  conditionId: string,
  question: string,
): Promise<void> {
  if (CONFIG.shadowMode) {
    log.info("REDEEM_SKIPPED_SHADOW", { conditionId, question });
    return;
  }

  log.info("REDEEM_WAITING_RESOLUTION", { conditionId, question });

  // Poll until the UMA oracle has reported payouts on-chain
  const resolved = await waitForResolution(conditionId, question);
  if (!resolved) {
    log.error("REDEEM_FAILED", {
      conditionId, question,
      reason: "resolution_poll_timeout",
    });
    return;
  }

  // Submit the redeem, retrying on relay/network failures
  for (let attempt = 1; attempt <= REDEEM_MAX_ATTEMPTS; attempt++) {
    try {
      log.info("REDEEM_SUBMITTING", {
        conditionId, question, attempt, maxAttempts: REDEEM_MAX_ATTEMPTS,
      });

      const ok = await submitRedeem(conditionId);

      if (ok) {
        log.info("REDEEM_CONFIRMED", { conditionId, question, attempt });
        return;
      }

      log.warn("REDEEM_RELAY_FAILED", {
        conditionId, question, attempt,
        reason: "relay_not_confirmed",
        retryInMs: attempt < REDEEM_MAX_ATTEMPTS ? REDEEM_RETRY_DELAY_MS : 0,
      });

    } catch (err) {
      // Non-recoverable error (auth failure, malformed tx, etc.) — log and bail.
      log.error("REDEEM_FAILED", {
        conditionId, question, attempt,
        reason: "exception",
        error:  (err as Error).message,
      });
      return;
    }

    if (attempt < REDEEM_MAX_ATTEMPTS) {
      await sleep(REDEEM_RETRY_DELAY_MS);
    }
  }

  log.error("REDEEM_FAILED", {
    conditionId, question,
    reason: "max_relay_attempts_exhausted",
    attempts: REDEEM_MAX_ATTEMPTS,
  });
}

/**
 * Called at startup to redeem any winning positions from previous sessions
 * that were never redeemed (e.g. bot crashed after win but before redeem).
 *
 * Queries the Data API for positions belonging to the SAFE address (not the
 * raw EOA — that is where positions actually live). For each redeemable
 * position, verifies on-chain resolution and submits the redeem.
 *
 * All errors are swallowed per-market — never throws.
 */
export async function sweepUnredeemedPositions(): Promise<void> {
  if (CONFIG.shadowMode) return;

  // CRITICAL: positions are held by the Safe, not the raw EOA
  let safeAddress: string;
  try {
    safeAddress = await getSafeAddress();
  } catch (err) {
    log.error("REDEEM_SWEEP_SAFE_ERROR", { error: (err as Error).message });
    return;
  }

  // Fetch positions from the Data API using the Safe address
  let positions: Array<{ conditionId: string; question?: string; size?: number }>;
  try {
    const resp = await fetch(
      `${DATA_API_URL}/positions?user=${safeAddress}`,
      { headers: { Accept: "application/json" } },
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from Data API`);

    const body = await resp.json();

    // Data API returns an array of position objects.
    // Filter to only those with a non-zero balance.
    // We do NOT filter on `redeemable` here because that field may lag;
    // instead we verify resolution on-chain ourselves.
    const raw: any[] = Array.isArray(body) ? body : (body.positions ?? []);
    positions = raw.filter((p: any) => Number(p.size ?? p.amount ?? 0) > 0);

  } catch (err) {
    log.warn("REDEEM_SWEEP_FETCH_ERROR", { error: (err as Error).message, safeAddress });
    return;
  }

  if (positions.length === 0) {
    log.info("REDEEM_SWEEP_NONE", { safeAddress });
    return;
  }

  log.info("REDEEM_SWEEP_START", { count: positions.length, safeAddress });

  for (const pos of positions) {
    // Check on-chain resolution directly — most reliable signal
    const resolved = await isResolvedOnChain(pos.conditionId);
    if (!resolved) {
      log.info("REDEEM_SWEEP_SKIP_UNRESOLVED", {
        conditionId: pos.conditionId,
        question:    pos.question,
      });
      continue;
    }

    // Attempt the redeem with retries
    for (let attempt = 1; attempt <= SWEEP_MAX_ATTEMPTS; attempt++) {
      try {
        log.info("REDEEM_SUBMITTING", {
          conditionId: pos.conditionId,
          question:    pos.question,
          source:      "sweep",
          attempt,
          maxAttempts: SWEEP_MAX_ATTEMPTS,
        });

        const ok = await submitRedeem(pos.conditionId);

        if (ok) {
          log.info("REDEEM_CONFIRMED", {
            conditionId: pos.conditionId,
            question:    pos.question,
            source:      "sweep",
            attempt,
          });
          break;
        }

        log.warn("REDEEM_RELAY_FAILED", {
          conditionId: pos.conditionId,
          question:    pos.question,
          source:      "sweep",
          attempt,
          reason:      "relay_not_confirmed",
        });

      } catch (err) {
        log.error("REDEEM_SWEEP_ERROR", {
          conditionId: pos.conditionId,
          question:    pos.question,
          attempt,
          error:       (err as Error).message,
        });
        break; // non-recoverable for this position, move to next
      }

      if (attempt < SWEEP_MAX_ATTEMPTS) {
        await sleep(SWEEP_RETRY_DELAY_MS);
      }
    }
  }

  log.info("REDEEM_SWEEP_DONE", { count: positions.length, safeAddress });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Periodic background sweep ────────────────────────────────────────────────

/** Guard: prevents two overlapping sweepUnredeemedPositions() calls. */
let _sweepRunning = false;

/**
 * Starts a background timer that calls sweepUnredeemedPositions() every
 * intervalMs milliseconds. A concurrency guard prevents a new sweep from
 * starting before the previous one finishes (e.g. if RPC calls are slow).
 *
 * Returns the interval handle so the caller can unref() or clear it.
 *
 * This is the "10-20s check" that catches every won position that
 * redeemAfterWin() may have missed (timeout, relay failure, restart, etc.).
 */
export function startPeriodicRedeemSweep(
  intervalMs: number = 15_000,
): ReturnType<typeof setInterval> {
  log.info("INFO", {
    message: "Periodic redeem sweep started.",
    intervalMs,
  });

  const handle = setInterval(async () => {
    if (_sweepRunning) return; // skip tick if previous sweep still running
    _sweepRunning = true;
    try {
      await sweepUnredeemedPositions();
    } catch (err) {
      log.error("REDEEM_SWEEP_ERROR", {
        conditionId: "periodic",
        question:    "background sweep",
        attempt:     0,
        error:       (err as Error).message,
      });
    } finally {
      _sweepRunning = false;
    }
  }, intervalMs);

  return handle;
}
/**
 * redeemer.ts — Auto-redeems winning Polymarket positions back into USDC.
 *
 * Why this is needed:
 *   When a bet resolves as a WIN, the payout is NOT automatically credited as
 *   spendable USDC. Instead, you hold ERC-1155 conditional tokens (the winning
 *   outcome tokens) that must be explicitly redeemed by calling redeemPositions()
 *   on Polymarket's Conditional Token Framework (CTF) contract.
 *
 *   Because every Polymarket account's positions are held inside a Safe (Gnosis
 *   proxy multisig), you cannot call redeemPositions() directly with your EOA.
 *   The Safe must execute the call via execTransaction, which requires the
 *   builder-relayer-client to construct and sign correctly.
 *
 * How it works:
 *   1. After a WIN resolution in trader.ts, redeemAfterWin(conditionId) is called.
 *   2. On bot startup, sweepUnredeemedPositions() is called to catch any
 *      positions that were won in previous sessions but never claimed.
 *   3. Both paths build a redeemPositions tx, submit it via the relayer, and
 *      wait for on-chain confirmation.
 *
 * Why transactions were failing onchain:
 *   The CTF oracle needs time to report the winning outcome on-chain after a
 *   market closes. Calling redeemPositions before the oracle reports causes a
 *   revert even though the tx reaches the chain successfully. The fix is a 60s
 *   initial delay after WIN, with up to 5 retries (60s apart) if still not ready.
 *
 * New env vars required (add to .env):
 *   POLY_BUILDER_API_KEY=...       (from polymarket.com/settings?tab=builder)
 *   POLY_BUILDER_SECRET=...
 *   POLY_BUILDER_PASSPHRASE=...
 *   POLYGON_RPC_URL=https://polygon-rpc.com   (or your own RPC)
 *
 * New dependency:
 *   npm install @polymarket/builder-relayer-client @polymarket/builder-signing-sdk viem
 */

import {
  createWalletClient,
  http,
  encodeFunctionData,
  zeroHash,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import {
  RelayClient,
  RelayerTxType,
  type Transaction,
} from "@polymarket/builder-relayer-client";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";

import { CONFIG } from "./config.js";
import { log } from "./logger.js";

// ─── Polygon contract addresses (never change) ────────────────────────────────

const CTF_ADDRESS = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const RELAYER_URL = "https://relayer-v2.polymarket.com";
const CHAIN_ID = 137;
const DATA_API = "https://data-api.polymarket.com";

// ─── Redemption timing ────────────────────────────────────────────────────────

// How long to wait after a WIN before the first redeem attempt.
// The CTF oracle typically takes 30-120s to report the result on-chain after
// market close. Trying to redeem before the oracle reports causes an on-chain
// revert even though the tx itself is valid and reaches the chain.
const REDEEM_INITIAL_DELAY_MS = 60_000; // 60s

// Retry config for redeemAfterWin: up to 5 attempts, 60s apart.
const REDEEM_MAX_ATTEMPTS = 5;
const REDEEM_RETRY_DELAY_MS = 60_000;

// ─── ABI (minimal) ───────────────────────────────────────────────────────────

const CTF_REDEEM_ABI = [
  {
    constant: false,
    inputs: [
      { name: "collateralToken", type: "address" },
      { name: "parentCollectionId", type: "bytes32" },
      { name: "conditionId", type: "bytes32" },
      { name: "indexSets", type: "uint256[]" },
    ],
    name: "redeemPositions",
    outputs: [],
    payable: false,
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// ─── Types ────────────────────────────────────────────────────────────────────

interface RedeemablePosition {
  conditionId: string;
  outcomeIndex: number;
  size: number;
  title: string;
}

type SubmitResult = "confirmed" | "reverted" | "failed";

// ─── Relay client (lazy singleton) ───────────────────────────────────────────

let _relayClient: RelayClient | null = null;

function getRelayClient(): RelayClient {
  if (_relayClient) return _relayClient;

  const builderApiKey = process.env.POLY_BUILDER_API_KEY;
  const builderSecret = process.env.POLY_BUILDER_SECRET;
  const builderPassphrase = process.env.POLY_BUILDER_PASSPHRASE;
  const rpcUrl = process.env.POLYGON_RPC_URL ?? "https://polygon-rpc.com";

  if (!builderApiKey || !builderSecret || !builderPassphrase) {
    throw new Error(
      "Missing POLY_BUILDER_API_KEY / POLY_BUILDER_SECRET / POLY_BUILDER_PASSPHRASE. " +
        "Generate them at polymarket.com/settings?tab=builder and add them to .env."
    );
  }

  const account = privateKeyToAccount(CONFIG.privateKey as Hex);
  const wallet = createWalletClient({
    account,
    chain: polygon,
    transport: http(rpcUrl),
  });

  const builderConfig = new BuilderConfig({
    localBuilderCreds: {
      key: builderApiKey,
      secret: builderSecret,
      passphrase: builderPassphrase,
    },
  });

  // SIGNATURE_TYPE 0 = MetaMask/EOA → Safe wallet  (RelayerTxType.SAFE)
  // SIGNATURE_TYPE 1 = Magic/email  → Proxy wallet (RelayerTxType.PROXY)
  const txType =
    CONFIG.signatureType === 1 ? RelayerTxType.PROXY : RelayerTxType.SAFE;

  _relayClient = new RelayClient(
    RELAYER_URL,
    CHAIN_ID,
    wallet,
    builderConfig,
    txType
  );

  return _relayClient;
}

// ─── Core: build & submit one redeemPositions tx ─────────────────────────────

function buildRedeemTx(conditionId: string): Transaction {
  const calldata = encodeFunctionData({
    abi: CTF_REDEEM_ABI,
    functionName: "redeemPositions",
    // indexSets [1, 2] = outcome slot 0 (YES) and slot 1 (NO) in binary markets.
    // The CTF no-ops on whichever slot has no winning tokens — safe to always pass both.
    args: [USDC_ADDRESS as Hex, zeroHash, conditionId as Hex, [BigInt(1), BigInt(2)]],
  });

  return { to: CTF_ADDRESS, data: calldata, value: "0" };
}

/**
 * Submit one redeemPositions tx and wait for the relayer result.
 *
 * Returns:
 *   "confirmed" — relayer + on-chain success
 *   "reverted"  — tx reached chain but reverted (oracle not ready yet → retry)
 *   "failed"    — relayer/network error (don't retry)
 */
async function submitRedeem(
  conditionId: string,
  label: string
): Promise<SubmitResult> {
  const client = getRelayClient();
  const tx = buildRedeemTx(conditionId);

  try {
    log.info("REDEEM_SUBMITTING", { conditionId, label });
    const response = await client.execute([tx], `Redeem: ${label}`);
    const result = await response.wait() as any;

    // The relayer SDK signals an on-chain revert through the state field.
    // Check every known field name used across SDK versions.
    const state: string = result?.state ?? result?.status ?? "";
    const txHash: string = result?.transactionHash ?? result?.txHash ?? "unknown";
    const onChainFailed =
      state === "STATE_FAILED" ||
      state === "FAILED" ||
      result?.failed === true ||
      result?.onChainFailed === true;

    if (onChainFailed) {
      log.warn("REDEEM_FAILED", {
        conditionId,
        label,
        txHash,
        state,
        reason: "on-chain revert — oracle may not have settled yet",
      });
      return "reverted";
    }

    log.info("REDEEM_CONFIRMED", { conditionId, label, txHash });
    return "confirmed";
  } catch (err) {
    const msg = (err as Error).message ?? "";

    // "failed onchain" also surfaces as a thrown error from response.wait()
    // in some versions of the relayer SDK.
    if (msg.toLowerCase().includes("failed onchain") || msg.toLowerCase().includes("onchain")) {
      log.warn("REDEEM_FAILED", {
        conditionId,
        label,
        reason: "on-chain revert (thrown) — oracle may not have settled yet",
        error: msg,
      });
      return "reverted";
    }

    log.error("REDEEM_FAILED", { conditionId, label, error: msg });
    return "failed";
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Called after a RESOLUTION_WIN in trader.ts.
 *
 * Waits REDEEM_INITIAL_DELAY_MS for the oracle to settle on-chain, then retries
 * on revert up to REDEEM_MAX_ATTEMPTS times (REDEEM_RETRY_DELAY_MS apart).
 * Non-blocking — trader.ts fire-and-forgets this so the slot is free immediately.
 */
export async function redeemAfterWin(
  conditionId: string,
  marketQuestion: string
): Promise<void> {
  if (CONFIG.shadowMode) {
    log.info("REDEEM_SKIPPED_SHADOW", { conditionId, marketQuestion });
    return;
  }

  log.info("REDEEM_SUBMITTING", {
    conditionId,
    label: marketQuestion,
    note: `Waiting ${REDEEM_INITIAL_DELAY_MS / 1000}s for oracle settlement...`,
  });
  await sleep(REDEEM_INITIAL_DELAY_MS);

  for (let attempt = 1; attempt <= REDEEM_MAX_ATTEMPTS; attempt++) {
    const outcome = await submitRedeem(conditionId, marketQuestion);

    if (outcome === "confirmed") return;
    if (outcome === "failed") return; // relayer/network error — no point retrying

    // "reverted" — oracle not settled yet
    if (attempt < REDEEM_MAX_ATTEMPTS) {
      log.info("REDEEM_SUBMITTING", {
        conditionId,
        label: marketQuestion,
        note: `Attempt ${attempt}/${REDEEM_MAX_ATTEMPTS} reverted. Retrying in ${REDEEM_RETRY_DELAY_MS / 1000}s...`,
      });
      await sleep(REDEEM_RETRY_DELAY_MS);
    } else {
      log.error("REDEEM_FAILED", {
        conditionId,
        label: marketQuestion,
        error: `All ${REDEEM_MAX_ATTEMPTS} attempts reverted. Position needs manual redemption on polymarket.com.`,
      });
    }
  }
}

/**
 * Called once on startup to reclaim USDC from positions won in previous sessions.
 * These markets are already fully settled so no oracle delay is needed —
 * but we still retry briefly in case of transient chain issues.
 */
export async function sweepUnredeemedPositions(): Promise<void> {
  if (CONFIG.shadowMode) return;

  const proxyAddress = CONFIG.polymarketFunderAddress;
  let positions: RedeemablePosition[] = [];

  try {
    const url = `${DATA_API}/positions?user=${proxyAddress}&redeemable=true&sizeThreshold=0.01&limit=500`;
    const res = await fetch(url);
    if (!res.ok) {
      log.warn("REDEEM_SWEEP_FETCH_ERROR", { status: res.status, url });
      return;
    }
    const raw = (await res.json()) as Array<{
      conditionId: string;
      outcomeIndex: number;
      size: number;
      title: string;
    }>;
    positions = raw.map((p) => ({
      conditionId: p.conditionId,
      outcomeIndex: p.outcomeIndex,
      size: p.size,
      title: p.title ?? p.conditionId,
    }));
  } catch (err) {
    log.error("REDEEM_SWEEP_ERROR", { error: (err as Error).message });
    return;
  }

  if (positions.length === 0) {
    log.info("REDEEM_SWEEP_NONE", { message: "No unredeemed positions found." });
    return;
  }

  // Group by conditionId — API may return multiple outcome rows per market
  const byCondition = new Map<string, RedeemablePosition>();
  for (const p of positions) {
    if (!byCondition.has(p.conditionId)) byCondition.set(p.conditionId, p);
  }

  log.info("REDEEM_SWEEP_START", {
    count: byCondition.size,
    positions: [...byCondition.values()].map((p) => ({
      conditionId: p.conditionId,
      title: p.title,
      size: p.size,
    })),
  });

  let redeemed = 0;
  let failed = 0;

  for (const [conditionId, pos] of byCondition) {
    // Sweep positions are from settled markets — submit directly.
    // Still retry briefly on revert for transient chain issues.
    let ok = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const outcome = await submitRedeem(conditionId, pos.title);
      if (outcome === "confirmed") { ok = true; break; }
      if (outcome === "failed") break;
      if (attempt < 3) await sleep(15_000);
    }

    if (ok) redeemed++;
    else failed++;

    // Brief pause between positions to avoid nonce collisions
    if (byCondition.size > 1) await sleep(2000);
  }

  log.info("REDEEM_SWEEP_DONE", { redeemed, failed, total: byCondition.size });
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
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
    localBuilderConfig: {
      apiKey: builderApiKey,
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

// ─── Core: build & submit a single redeemPositions transaction ────────────────

function buildRedeemTx(conditionId: string): Transaction {
  const calldata = encodeFunctionData({
    abi: CTF_REDEEM_ABI,
    functionName: "redeemPositions",
    // indexSets [1, 2] = outcome slot 0 (YES) and slot 1 (NO) in binary markets.
    // The CTF will simply no-op on whichever slot has no winning tokens.
    args: [USDC_ADDRESS as Hex, zeroHash, conditionId as Hex, [BigInt(1), BigInt(2)]],
  });

  return { to: CTF_ADDRESS, data: calldata, value: "0" };
}

async function submitRedeem(
  conditionId: string,
  label: string
): Promise<boolean> {
  const client = getRelayClient();
  const tx = buildRedeemTx(conditionId);

  try {
    log.info("REDEEM_SUBMITTING", { conditionId, label });
    const response = await client.execute([tx], `Redeem: ${label}`);
    const result = await response.wait();

    log.info("REDEEM_CONFIRMED", {
      conditionId,
      label,
      txHash: (result as any)?.transactionHash ?? "unknown",
    });
    return true;
  } catch (err) {
    log.error("REDEEM_FAILED", {
      conditionId,
      label,
      error: (err as Error).message,
    });
    return false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Call this immediately after a RESOLUTION_WIN in trader.ts.
 * The conditionId comes from market.conditionId that your scanner already fetches.
 */
export async function redeemAfterWin(
  conditionId: string,
  marketQuestion: string
): Promise<void> {
  if (CONFIG.shadowMode) {
    log.info("REDEEM_SKIPPED_SHADOW", { conditionId, marketQuestion });
    return;
  }

  await submitRedeem(conditionId, marketQuestion);
}

/**
 * Call once on startup (after shadowMode check).
 * Queries the Polymarket Data API for any positions that are marked redeemable
 * — these are positions from previous sessions that were won but never claimed.
 * Redeems them all so their USDC becomes available immediately.
 */
export async function sweepUnredeemedPositions(): Promise<void> {
  if (CONFIG.shadowMode) return;

  const proxyAddress = CONFIG.polymarketFunderAddress;

  let positions: RedeemablePosition[] = [];
  try {
    const url =
      `${DATA_API}/positions?user=${proxyAddress}&redeemable=true&sizeThreshold=0.01&limit=500`;
    const res = await fetch(url);
    if (!res.ok) {
      log.warn("REDEEM_SWEEP_FETCH_ERROR", {
        status: res.status,
        url,
      });
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

  log.info("REDEEM_SWEEP_START", {
    count: positions.length,
    positions: positions.map((p) => ({
      conditionId: p.conditionId,
      title: p.title,
      size: p.size,
    })),
  });

  // Group by conditionId in case the API returns multiple outcome rows per market
  const byCondition = new Map<string, RedeemablePosition>();
  for (const p of positions) {
    if (!byCondition.has(p.conditionId)) byCondition.set(p.conditionId, p);
  }

  let redeemed = 0;
  let failed = 0;

  for (const [conditionId, pos] of byCondition) {
    const ok = await submitRedeem(conditionId, pos.title);
    if (ok) redeemed++;
    else failed++;

    // Brief pause between transactions to avoid nonce collisions
    if (byCondition.size > 1) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  log.info("REDEEM_SWEEP_DONE", { redeemed, failed, total: byCondition.size });
}
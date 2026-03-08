import { createPublicClient, http, encodeFunctionData, zeroHash, type Hex } from "viem";
import { polygon } from "viem/chains";
import { RelayClient, RelayerTxType, type Transaction } from "@polymarket/builder-relayer-client";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient } from "viem";

import { CONFIG } from "./config.js";
import { log } from "./logger.js";
import type { Market } from "./types.js";

// ─── Contract Constants ──────────────────────────────────────────────────────
const CTF_ADDRESS = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
const NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// ─── ABIs ───────────────────────────────────────────────────────────────────
const CTF_ABI = [
  { name: "redeemPositions", type: "function", inputs: [{ name: "collateralToken", type: "address" }, { name: "parentCollectionId", type: "bytes32" }, { name: "conditionId", type: "bytes32" }, { name: "indexSets", type: "uint256[]" }] },
  { name: "payoutNumerators", type: "function", inputs: [{ name: "conditionId", type: "bytes32" }], outputs: [{ type: "uint256[]" }] },
  { name: "balanceOf", type: "function", inputs: [{ name: "account", type: "address" }, { name: "id", type: "uint256" }], outputs: [{ type: "uint256" }] }
] as const;

const NEG_RISK_ABI = [
  { name: "redeemPositions", type: "function", inputs: [{ name: "ctf", type: "address" }, { name: "collateralToken", type: "address" }, { name: "parentCollectionId", type: "bytes32" }, { name: "conditionId", type: "bytes32" }, { name: "indexSets", type: "uint256[]" }] }
] as const;

const publicClient = createPublicClient({ 
  chain: polygon, 
  transport: http(process.env.POLYGON_RPC_URL ?? "https://polygon-rpc.com") 
});

// ─── Helper: Get Relayer Client ──────────────────────────────────────────────
let _relayClient: RelayClient | null = null;
function getRelayClient(): RelayClient {
  if (_relayClient) return _relayClient;
  const account = privateKeyToAccount(CONFIG.privateKey as Hex);
  const wallet = createWalletClient({ account, chain: polygon, transport: http() });
  const builderConfig = new BuilderConfig({
    localBuilderCreds: {
      key: process.env.POLY_BUILDER_API_KEY!,
      secret: process.env.POLY_BUILDER_SECRET!,
      passphrase: process.env.POLY_BUILDER_PASSPHRASE!,
    },
  });
  _relayClient = new RelayClient(
    "https://relayer-v2.polymarket.com",
    137,
    wallet,
    builderConfig as any,
    CONFIG.signatureType === 1 ? RelayerTxType.PROXY : RelayerTxType.SAFE
  );
  return _relayClient;
}

// ─── Core: Settlement & Redemption ───────────────────────────────────────────

async function pollForSettlement(conditionId: string): Promise<boolean> {
  log.info("REDEEM_POLLING_SETTLEMENT", { conditionId });
  for (let i = 0; i < 12; i++) { // Poll for ~60 seconds
    try {
      const payouts = await publicClient.readContract({
        address: CTF_ADDRESS,
        abi: CTF_ABI,
        functionName: "payoutNumerators",
        args: [conditionId as Hex],
      }) as any;
      if (payouts.some((p: any) => p > 0n)) return true;
    } catch (e) { /* ignore network blips */ }
    await new Promise(r => setTimeout(r, 5000));
  }
  return false;
}

export async function redeemAfterWin(market: Market): Promise<void> {
  if (CONFIG.shadowMode) return;

  const settled = await pollForSettlement(market.conditionId);
  if (!settled) {
    log.error("REDEEM_FAILED_SETTLEMENT_TIMEOUT", { market: market.question });
    return;
  }

  const walletAddress = CONFIG.polymarketFunderAddress as Hex;
  
  // Verify which token we actually hold to build indexSets
  const [yesBal, noBal] = await Promise.all([
    publicClient.readContract({ address: CTF_ADDRESS, abi: CTF_ABI, functionName: "balanceOf", args: [walletAddress, BigInt(market.yesTokenId)] }),
    publicClient.readContract({ address: CTF_ADDRESS, abi: CTF_ABI, functionName: "balanceOf", args: [walletAddress, BigInt(market.noTokenId)] })
  ]);

  const indexSets: bigint[] = [];
  if ((yesBal as any) > 0n) indexSets.push(1n);
  if ((noBal as any) > 0n) indexSets.push(2n);

  if (indexSets.length === 0) {
    log.warn("REDEEM_SKIPPED_NO_BALANCE", { market: market.question });
    return;
  }

  const tx: Transaction = market.negRisk 
    ? {
        to: NEG_RISK_ADAPTER,
        data: encodeFunctionData({
          abi: NEG_RISK_ABI,
          functionName: "redeemPositions",
          args: [CTF_ADDRESS, USDC_ADDRESS, zeroHash, market.conditionId as Hex, indexSets]
        }),
        value: "0"
      }
    : {
        to: CTF_ADDRESS,
        data: encodeFunctionData({
          abi: CTF_ABI,
          functionName: "redeemPositions",
          args: [USDC_ADDRESS, zeroHash, market.conditionId as Hex, indexSets]
        }),
        value: "0"
      };

  try {
    const response = await getRelayClient().execute([tx], `Redeem: ${market.question}`);
    const receipt = await response.wait();
    log.info("REDEEM_CONFIRMED", { txHash: (receipt as any).transactionHash, market: market.question });
  } catch (err) {
    log.error("REDEEM_ERROR", { market: market.question, error: (err as Error).message });
  }
}
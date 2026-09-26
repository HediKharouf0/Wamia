/**
 * Levee on the mainnet fork: deploys LeveeQuoter and LeveeArb from the Foundry build, and ships
 * LP strategies to the deployed Aqua with the deployed AquaSwapVMRouter, through the SDK helpers
 * in levee.ts. Test-harness code: wallets are funded with anvil cheats; the strategy logic is not.
 */
import { readFileSync, existsSync } from "fs";
import { encodeDeployData, encodeFunctionData, getAddress, keccak256, toBytes, parseAbi, type Abi } from "viem";
import type { Order } from "@1inch/swap-vm-sdk";
import type { Client } from "../chain/client.js";
import addresses from "../../config/addresses.json" with { type: "json" };
import { dealErc20AtSlot } from "../replay/dealErc20.js";
import { buildLeveeOrder, shipTx, strategyHash, type LeveeParams } from "./levee.js";

type Hex = `0x${string}`;

export const SY_BALANCE_SLOT = 2;
export const AQUA = getAddress(addresses.aqua.registry) as Hex;
export const ROUTER = getAddress(addresses.aqua.swapVmRouter) as Hex;
export const PENDLE_ROUTER = getAddress(addresses.pendle.router) as Hex;
export const MARKET = getAddress(addresses.pendle.market) as Hex;
export const PT = getAddress(addresses.pendle.pt) as Hex;
export const SY = getAddress(addresses.pendle.sy) as Hex;
export const CURVE_REUSD = getAddress(addresses.reusdMarketPrice.curvePool) as Hex;

export const erc20Abi = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function exchangeRate() view returns (uint256)",
]);
const aquaAbi = parseAbi([
  "function safeBalances(address maker,address app,bytes32 strategyHash,address token0,address token1) view returns (uint256,uint256)",
]);

export function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const path = `contracts/out/${file}/${name}.json`;
  if (!existsSync(path)) throw new Error(`${path} missing: run (cd contracts && forge build) first`);
  const j = JSON.parse(readFileSync(path, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

/** Deterministic test wallet from a label. */
export function walletFor(label: string): Hex {
  return getAddress(`0x${keccak256(toBytes(label)).slice(-40)}`) as Hex;
}

/** Sends a transaction as `from` (impersonated), optionally at a given block timestamp. */
export async function sendAs(
  client: Client,
  from: Hex,
  tx: { to?: Hex; data: Hex },
  opts: { gas?: bigint; timestamp?: number | undefined } = {}
) {
  await client.request({ method: "anvil_impersonateAccount" as any, params: [from] });
  await client.request({ method: "anvil_setBalance" as any, params: [from, "0x56BC75E2D63100000"] });
  if (opts.timestamp !== undefined) {
    await client.request({ method: "evm_setNextBlockTimestamp" as any, params: [opts.timestamp] as any });
  }
  const hash = await client.request({
    method: "eth_sendTransaction" as any,
    params: [{ from, ...tx, gas: `0x${(opts.gas ?? 3_000_000n).toString(16)}` }],
  });
  const receipt = await client.waitForTransactionReceipt({ hash: hash as Hex });
  await client.request({ method: "anvil_stopImpersonatingAccount" as any, params: [from] });
  return receipt;
}

/** `nextTs` gives each setup transaction an explicit timestamp, so setup never runs into the replay. */
export async function deployLevee(client: Client, deployer: Hex, nextTs?: () => number) {
  const quoterArt = artifact("LeveeQuoter.sol", "LeveeQuoter");
  const arbArt = artifact("LeveeArb.sol", "LeveeArb");
  const deploy = async (art: { abi: Abi; bytecode: Hex }, args: unknown[]) => {
    const receipt = await sendAs(client, deployer, { data: encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args }) }, { gas: 8_000_000n, timestamp: nextTs?.() });
    if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("deployment failed");
    return getAddress(receipt.contractAddress) as Hex;
  };
  const quoter = await deploy(quoterArt, []);
  const arb = await deploy(arbArt, [ROUTER, PENDLE_ROUTER, MARKET, PT, SY]);
  // Custom errors from both contracts, to name reverts seen by the searcher.
  const errorAbi = [...quoterArt.abi, ...arbArt.abi].filter((x: any) => x.type === "error") as Abi;
  return { quoter, arb, quoterAbi: quoterArt.abi, arbAbi: arbArt.abi, errorAbi };
}

/** Spec 7.3 defaults, the same as contracts/test/utils/LeveeTestParams.sol. */
export function defaultParams(shippedSy: bigint, minSyRate: bigint): LeveeParams {
  return {
    pt: PT,
    sy: SY,
    market: MARKET,
    curvePool: CURVE_REUSD,
    refYieldWad: 105_830_000_000_000_000n, // pre-attack implied APY, 10.583%
    discountMinBps: 10,
    discountMaxBps: 60,
    shippedSy,
    minSyRate,
    maxDepegBps: 100, // reUSD at most 1% below NAV on Curve
    maxDeviationBps: 450, // Pendle spot at most 4.5% below fair (Aug 25: ~2.45%)
    flags: 0, // reUSD is coins[0] in the Curve pool
  };
}

export type LeveeLp = { wallet: Hex; params: LeveeParams; order: Order; hash: Hex; shippedSy: bigint };

/** Funds an LP wallet with SY, approves Aqua once and ships a Levee strategy built with the SDK. */
export async function shipLevee(
  client: Client,
  quoter: Hex,
  wallet: Hex,
  shippedSy: bigint,
  minSyRate: bigint,
  opts: { discountMaxBps?: number | undefined; nextTs?: () => number } = {}
): Promise<LeveeLp> {
  const ok = await dealErc20AtSlot(client, SY, wallet, shippedSy, SY_BALANCE_SLOT);
  if (!ok) throw new Error("SY funding failed");
  await sendAs(
    client,
    wallet,
    { to: SY, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [AQUA, 2n ** 256n - 1n] }) },
    { timestamp: opts.nextTs?.() }
  );

  const params = defaultParams(shippedSy, minSyRate);
  if (opts.discountMaxBps !== undefined) params.discountMaxBps = opts.discountMaxBps;
  const order = buildLeveeOrder(wallet, quoter, params);
  const receipt = await sendAs(client, wallet, shipTx(AQUA, ROUTER, order, SY, PT, shippedSy), { timestamp: opts.nextTs?.() });
  if (receipt.status !== "success") throw new Error(`ship failed for ${wallet}`);
  return { wallet, params, order, hash: strategyHash(order), shippedSy };
}

/** SY still available to the strategy in Aqua (its virtual balance). */
export async function aquaSyBalance(client: Client, lp: LeveeLp): Promise<bigint> {
  const [sy] = await client.readContract({
    address: AQUA,
    abi: aquaAbi,
    functionName: "safeBalances",
    args: [lp.wallet, ROUTER, lp.hash, lp.params.sy, lp.params.pt],
  });
  return sy;
}

export async function balanceOf(client: Client, token: Hex, who: Hex): Promise<bigint> {
  return client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
}

export async function syExchangeRate(client: Client): Promise<bigint> {
  return client.readContract({ address: SY, abi: erc20Abi, functionName: "exchangeRate" });
}

/** Levee's fair value and marginal bid (USD per PT, wad) for a strategy; null if it refuses. */
export async function leveeBid(client: Client, quoter: Hex, quoterAbi: Abi, lp: LeveeLp, balanceSy: bigint) {
  try {
    const [fairWad] = (await client.readContract({ address: quoter, abi: quoterAbi, functionName: "checkMarket", args: [lp.params] })) as [bigint, bigint, bigint];
    const bidWad = (await client.readContract({ address: quoter, abi: quoterAbi, functionName: "marginalBid", args: [lp.params, fairWad, balanceSy] })) as bigint;
    return { fair: Number(fairWad) / 1e18, bid: Number(bidWad) / 1e18 };
  } catch {
    return null;
  }
}

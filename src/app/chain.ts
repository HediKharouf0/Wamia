/**
 * The chain behind the app's live screens. Two modes, picked from what runs on 127.0.0.1:8545:
 *
 *   fork   anvil forked from mainnet at block 25829822 (Aqua, the router, Pendle, Morpho, Curve are
 *          the deployed contracts). Wamia's contracts are deployed on top.
 *   local  a plain anvil (no RPC key needed): Aqua v1.0.0 and AquaSwapVMRouter v1.0.2 built from
 *          their release tags, Wamia, and mock PT/SY/market/Curve/Pendle router, as in localDemo.ts.
 *
 * Transactions are sent from impersonated test wallets, one block per action, 12 s apart, so the
 * fork keeps living on Aug 25 instead of jumping to today's date.
 */
import { readFileSync, existsSync } from "fs";
import {
  createPublicClient,
  http,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  keccak256,
  toBytes,
  parseAbi,
  maxUint256,
  type Abi,
  type PublicClient,
} from "viem";
import addresses from "../../config/addresses.json" with { type: "json" };
import { dealErc20AtSlot } from "../replay/dealErc20.js";

type Hex = `0x${string}`;
export type Mode = "fork" | "local";

export const RPC = process.env.WAMIA_RPC ?? "http://127.0.0.1:8545";
export const EXPIRY = BigInt(Math.floor(new Date(addresses.pendle.expiry).getTime() / 1000));
export const REF_YIELD_WAD = 105_830_000_000_000_000n;
const SY_BALANCE_SLOT = 2;

export const erc20Abi = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function exchangeRate() view returns (uint256)",
  "function mint(address,uint256)",
  "function setExchangeRate(uint256)",
]);
export const marketAbi = parseAbi([
  "function _storage() view returns (int128,int128,uint96,uint16,uint16,uint16)",
  "function setSpot(uint256)",
]);
export const mockRouterAbi = parseAbi(["function setPrice(uint256)", "function priceWad() view returns (uint256)"]);
export const mockCurveAbi = parseAbi(["function set(uint256,uint256)"]);

export type Artifact = { abi: Abi; bytecode: Hex; deployedBytecode: Hex; immutableRanges: { start: number; length: number }[] };

export function artifact(file: string, name: string): Artifact {
  const path = `contracts/out/${file}/${name}.json`;
  if (!existsSync(path)) throw new Error(`${path} missing: run (cd contracts && forge build) first`);
  const j = JSON.parse(readFileSync(path, "utf8"));
  const refs = (j.deployedBytecode?.immutableReferences ?? {}) as Record<string, { start: number; length: number }[]>;
  return { abi: j.abi, bytecode: j.bytecode.object, deployedBytecode: j.deployedBytecode.object, immutableRanges: Object.values(refs).flat() };
}

export const walletFor = (label: string) => getAddress(`0x${keccak256(toBytes(label)).slice(-40)}`) as Hex;

export type Chain = {
  mode: Mode;
  client: PublicClient;
  aqua: Hex;
  router: Hex;
  pt: Hex;
  sy: Hex;
  market: Hex;
  curve: Hex;
  pendleRouter: Hex;
  quoter: Hex;
  arb: Hex;
  rateGuard: Hex;
  spendLimit: Hex;
  lp: Hex;
  searcher: Hex;
  attacker: Hex;
  admin: Hex; // deploys and drives the mocks in local mode
  art: { quoter: Artifact; arb: Artifact; rateGuard: Artifact; spendLimit: Artifact };
  errorAbi: Abi;
  startRate: bigint;
  /** One block per action, 12 s apart; `gapSec` 1 for same-block-style follow-ups (arb rounds). */
  send: (from: Hex, tx: { to?: Hex; data: Hex }, opts?: { gas?: bigint; gapSec?: number }) => Promise<{ hash: Hex; status: "success" | "reverted"; gasUsed: bigint; contractAddress: Hex | null; blockNumber: bigint }>;
  dealSy: (to: Hex, amount: bigint) => Promise<void>;
};

export async function detectMode(client: PublicClient): Promise<Mode> {
  const code = await client.getCode({ address: getAddress(addresses.aqua.registry) as Hex }).catch(() => undefined);
  return code && code.length > 2 ? "fork" : "local";
}

export async function connect(): Promise<Chain> {
  const client = createPublicClient({ transport: http(RPC) });
  try {
    await client.getBlockNumber();
  } catch {
    throw new Error(`no chain at ${RPC}. Start anvil first: anvil --fork-url $ARCHIVE_RPC_URL --fork-block-number 25829822 (or plain anvil for local mode)`);
  }
  const mode = process.env.WAMIA_MODE === "local" || process.env.WAMIA_MODE === "fork" ? process.env.WAMIA_MODE : await detectMode(client);

  const send: Chain["send"] = async (from, tx, opts = {}) => {
    const latest = await client.getBlock({ blockTag: "latest" });
    await client.request({ method: "anvil_impersonateAccount" as any, params: [from] });
    await client.request({ method: "anvil_setBalance" as any, params: [from, "0x56BC75E2D63100000"] });
    await client.request({ method: "evm_setNextBlockTimestamp" as any, params: [Number(latest.timestamp) + (opts.gapSec ?? 12)] as any });
    const hash = (await client.request({
      method: "eth_sendTransaction" as any,
      params: [{ from, ...tx, gas: `0x${(opts.gas ?? 3_000_000n).toString(16)}` }],
    })) as Hex;
    const r = await client.waitForTransactionReceipt({ hash, pollingInterval: 50 });
    await client.request({ method: "anvil_stopImpersonatingAccount" as any, params: [from] });
    return { hash, status: r.status, gasUsed: r.gasUsed, contractAddress: r.contractAddress ? (getAddress(r.contractAddress) as Hex) : null, blockNumber: r.blockNumber };
  };

  const deploy = async (from: Hex, art: Artifact, args: unknown[]) => {
    const r = await send(from, { data: encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args }) }, { gas: 12_000_000n, gapSec: 1 });
    if (r.status !== "success" || !r.contractAddress) throw new Error("deployment failed");
    return r.contractAddress;
  };

  const art = {
    quoter: artifact("WamiaQuoter.sol", "WamiaQuoter"),
    arb: artifact("WamiaArb.sol", "WamiaArb"),
    rateGuard: artifact("WamiaRateGuard.sol", "WamiaRateGuard"),
    spendLimit: artifact("WamiaSpendLimit.sol", "WamiaSpendLimit"),
  };
  const errorAbi = [...art.quoter.abi, ...art.arb.abi, ...art.rateGuard.abi, ...art.spendLimit.abi].filter((x: any) => x.type === "error") as Abi;
  const admin = walletFor("wamia-app-admin");
  const lp = walletFor("wamia-app-lp");
  const searcher = walletFor("wamia-app-searcher");

  let aqua: Hex, router: Hex, pt: Hex, sy: Hex, market: Hex, curve: Hex, pendleRouter: Hex, attacker: Hex;
  let dealSy: Chain["dealSy"];

  if (mode === "fork") {
    aqua = getAddress(addresses.aqua.registry) as Hex;
    router = getAddress(addresses.aqua.swapVmRouter) as Hex;
    pt = getAddress(addresses.pendle.pt) as Hex;
    sy = getAddress(addresses.pendle.sy) as Hex;
    market = getAddress(addresses.pendle.market) as Hex;
    curve = getAddress(addresses.reusdMarketPrice.curvePool) as Hex;
    pendleRouter = getAddress(addresses.pendle.router) as Hex;
    attacker = getAddress(JSON.parse(readFileSync("fixtures/attack-transactions.json", "utf8")).manipulator[0].from) as Hex;
    dealSy = async (to, amount) => {
      const held = await client.readContract({ address: sy, abi: erc20Abi, functionName: "balanceOf", args: [to] });
      if (!(await dealErc20AtSlot(client, sy, to, held + amount, SY_BALANCE_SLOT))) throw new Error("SY funding failed");
    };
  } else {
    const mocks = (name: string) => artifact("Mocks.sol", name);
    aqua = await deploy(admin, artifact("Aqua.sol", "Aqua"), []);
    router = await deploy(admin, artifact("AquaSwapVMRouter.sol", "AquaSwapVMRouter"), [aqua, admin, admin, "AquaSwapVMRouter", "1.0.2"]);
    pt = await deploy(admin, mocks("MockToken"), ["PT", 6]);
    sy = await deploy(admin, mocks("MockSY"), [1_096_798n]);
    market = await deploy(admin, mocks("MockPendleMarket"), [EXPIRY, sy, pt]);
    curve = await deploy(admin, mocks("MockCurvePool"), []);
    pendleRouter = await deploy(admin, mocks("MockPendleRouter"), [pt, sy, 971_000_000_000_000_000n]);
    attacker = walletFor("wamia-app-attacker");
    dealSy = async (to, amount) => {
      await send(admin, { to: sy, data: encodeFunctionData({ abi: erc20Abi, functionName: "mint", args: [to, amount] }) }, { gapSec: 1 });
    };
  }

  const quoter = await deploy(admin, art.quoter, []);
  const arb = await deploy(admin, art.arb, [router, pendleRouter, market, pt, sy]);
  const rateGuard = await deploy(admin, art.rateGuard, [router]);
  const spendLimit = await deploy(admin, art.spendLimit, [router]);
  const startRate = await client.readContract({ address: sy, abi: erc20Abi, functionName: "exchangeRate" });

  // The LP approves Aqua once; ship then only promises SY, it never moves it.
  await send(lp, { to: sy, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [aqua, maxUint256] }) }, { gapSec: 1 });

  return { mode, client, aqua, router, pt, sy, market, curve, pendleRouter, quoter, arb, rateGuard, spendLimit, lp, searcher, attacker, admin, art, errorAbi, startRate, send, dealSy };
}

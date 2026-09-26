/**
 * Local API behind the app's live screens (Protect a market, Is it protected?, Inspect a strategy).
 * It drives the chain from chain.ts with the same helpers the tests and replays use: the SDK order
 * builders, the searcher's planArb, the attacker's adaptive push and the fork state edits.
 *
 *   anvil --fork-url "$ARCHIVE_RPC_URL" --fork-block-number 25829822   # or plain `anvil` for local mode
 *   npm run app:server                                                    # then npm run app
 */
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { readFileSync } from "fs";
import { encodeFunctionData, decodeFunctionResult, keccak256, maxUint256, parseAbi, type Abi } from "viem";
import { ABI } from "@1inch/swap-vm-sdk";
import type { Order } from "@1inch/swap-vm-sdk";
import addresses from "../../config/addresses.json" with { type: "json" };
import { buildWamiaOrder, dockTx, quoteSellPtTx, shipTx, strategyHash, type WamiaGuards, type WamiaParams } from "../aqua/wamia.js";
import { arbCalldata, planArb, revertReason, type ArbSource } from "../strategies/searcher.js";
import { attackInput } from "../replay/attacker.js";
import { scaleValueBehind, setPackedFieldBehind } from "../replay/stateCheats.js";
import { computePositionHealth } from "../health/morphoHealth.js";
import { connect, erc20Abi, marketAbi, mockCurveAbi, mockRouterAbi, EXPIRY, REF_YIELD_WAD, RPC, type Artifact, type Chain } from "./chain.js";

type Hex = `0x${string}`;
const PORT = Number(process.env.WAMIA_API_PORT ?? 8787);
const YEAR = 365 * 86_400;
const WAD = 10n ** 18n;

const aquaAbi = parseAbi(["function safeBalances(address,address,bytes32,address,address) view returns (uint256,uint256)"]);
const oracleAbi = parseAbi(["function price() view returns (uint256)"]);
const morphoAbi = parseAbi(["function market(bytes32) view returns (uint128,uint128,uint128,uint128,uint128,uint128)"]);
const rateGuardAbi = parseAbi(["function highWaterMark(bytes32) view returns (uint256)"]);

type Fill = { at: number; block: number; tx: Hex; ptBought: number; syPaid: number; price: number };
type Strategy = {
  hash: Hex;
  order: Order;
  params: WamiaParams;
  guards: WamiaGuards | null;
  shippedSy: bigint;
  shippedAt: number;
  shipTx: Hex;
  docked: boolean;
  fills: Fill[];
};
type Activity = { at: number; kind: "ship" | "dock" | "push" | "fill" | "nofill" | "faucet" | "scenario" | "reset" | "error"; text: string; tx?: Hex };

let chain: Chain;
let strategies: Strategy[] = [];
let activity: Activity[] = [];
let baseSnapshot: Hex = "0x0";
let scenarioSnapshot: { id: Hex; block: number; strategies: Strategy[]; activity: Activity[]; name: string } | null = null;
let busy: string | null = null;
let startError: string | null = null;

const num = (x: bigint, decimals: number) => Number(x) / 10 ** decimals;
const now = async () => Number((await chain.client.getBlock({ blockTag: "latest" })).timestamp);
let history: { block: number; spot: number; fair: number; oracle: number | null }[] = [];
const log = async (kind: Activity["kind"], text: string, tx?: Hex) => {
  activity.push({ at: await now(), kind, text, ...(tx ? { tx } : {}) });
  if (activity.length > 200) activity = activity.slice(-200);
  await sample();
};

/** One price sample per block that an action produced, for the monitor's chart. */
async function sample() {
  const block = Number(await chain.client.getBlockNumber());
  if (history.length && history[history.length - 1]!.block >= block) history = history.filter((h) => h.block < block);
  const { spot, fair } = await spotAndFair(await now());
  const oracle = chain.mode === "fork" ? Number(await chain.client.readContract({ address: addresses.morphoMarkets.usdc.oracle as Hex, abi: oracleAbi, functionName: "price" })) / 1e36 : null;
  history.push({ block, spot, fair, oracle });
  if (history.length > 120) history = history.slice(-120);
}

/** Plain-words version of a refusal, for the activity log. */
function plain(reason: string) {
  const name = reason.split("(")[0] ?? reason;
  const map: Record<string, string> = {
    UnderlyingDepegged: "Wamia refuses: reUSD trades more than 1% below its NAV",
    SyBelowFloor: "Wamia refuses: SY's exchange rate is below the floor",
    SpotTooFarBelowFair: "Wamia refuses: Pendle is more than 4.5% below fair value, which looks like news",
    RateBelowHighWaterMark: "Wamia refuses: SY's rate dropped below its high-water mark",
    SpendLimitExceeded: "the spend limit for this block is used up",
    MarketExpired: "the market has matured",
  };
  return map[name] ?? reason;
}

// ---------------------------------------------------------------------------------------------
// Reads

function paramsFor(shippedSy: bigint, discountMaxBps = 30): WamiaParams {
  return {
    pt: chain.pt,
    sy: chain.sy,
    market: chain.market,
    curvePool: chain.curve,
    refYieldWad: REF_YIELD_WAD,
    discountMinBps: 10,
    discountMaxBps,
    shippedSy,
    minSyRate: (chain.startRate * 99n) / 100n,
    maxDepegBps: 100,
    maxDeviationBps: 450,
    flags: 0,
  };
}

async function syRate() {
  return chain.client.readContract({ address: chain.sy, abi: erc20Abi, functionName: "exchangeRate" });
}

async function spotAndFair(ts: number) {
  const tau = Math.max(0, Number(EXPIRY) - ts) / YEAR;
  const [, , lnRate] = await chain.client.readContract({ address: chain.market, abi: marketAbi, functionName: "_storage" });
  const spot = Math.exp((-Number(lnRate) / 1e18) * tau);
  const fair = Math.pow(1 + Number(REF_YIELD_WAD) / 1e18, -tau);
  return { spot, fair, tau, impliedYield: Math.exp(Number(lnRate) / 1e18) - 1 };
}

async function readMarket() {
  const ts = await now();
  const block = Number(await chain.client.getBlockNumber());
  const rate = await syRate();
  const { spot, fair, tau, impliedYield } = await spotAndFair(ts);
  const p = paramsFor(1n);
  const marketToNav = num(
    (await chain.client.readContract({ address: chain.quoter, abi: chain.art.quoter.abi, functionName: "marketToNav", args: [p] })) as bigint,
    18
  );
  let verdict = "accepts";
  try {
    await chain.client.readContract({ address: chain.quoter, abi: chain.art.quoter.abi, functionName: "checkMarket", args: [p] });
  } catch (e) {
    verdict = revertReason(e, chain.errorAbi);
  }
  let highWater = 0n;
  for (const s of strategies.filter((s) => s.guards && !s.docked)) {
    const m = (await chain.client.readContract({ address: chain.rateGuard, abi: rateGuardAbi, functionName: "highWaterMark", args: [s.hash] })) as bigint;
    const mark = m > s.guards!.rateGuardParams.rateAtShip ? m : s.guards!.rateGuardParams.rateAtShip;
    if (mark > highWater) highWater = mark;
  }
  const rules = [
    { id: "maturity", name: "Before maturity", ok: ts < Number(EXPIRY), detail: `${Math.round((tau * YEAR) / 86_400)} days left` },
    {
      id: "syFloor",
      name: "SY exchange rate above the floor",
      ok: rate >= p.minSyRate,
      detail: `${num(rate, 6).toFixed(6)} vs floor ${num(p.minSyRate, 6).toFixed(6)}`,
    },
    { id: "depeg", name: "reUSD within 1% of NAV on Curve (EMA)", ok: marketToNav >= 0.99, detail: `${marketToNav.toFixed(4)} of NAV` },
    {
      id: "deviation",
      name: "Pendle spot within 4.5% of fair value",
      ok: spot >= fair * 0.955,
      detail: `${(((fair - spot) / fair) * 100).toFixed(2)}% below fair`,
    },
    {
      id: "highWater",
      name: "SY rate at or above its high-water mark (guard)",
      ok: highWater === 0n || rate >= highWater,
      detail: highWater === 0n ? "no guarded strategy yet" : `${num(rate, 6).toFixed(6)} vs mark ${num(highWater, 6).toFixed(6)}`,
    },
  ];
  return { ts, block, syRate: num(rate, 6), spot, fair, impliedYield, marketToNav, verdict, rules, morpho: chain.mode === "fork" ? await readMorpho() : null };
}

const positionsFixture = (["usdc", "usdt"] as const).flatMap((m) =>
  (JSON.parse(readFileSync(`fixtures/health-${m}-forkblock.json`, "utf8")) as { user: Hex; collateral: string; borrowShares: string }[]).map((h) => ({
    market: m,
    user: h.user,
    collateral: BigInt(h.collateral),
    borrowShares: BigInt(h.borrowShares),
  }))
);

async function readMorpho() {
  const morpho = addresses.morphoBlue as Hex;
  const oracle = addresses.morphoMarkets.usdc.oracle as Hex;
  const oraclePrice = await chain.client.readContract({ address: oracle, abi: oracleAbi, functionName: "price" });
  const markets: Record<string, { totalBorrowAssets: bigint; totalBorrowShares: bigint }> = {};
  for (const m of ["usdc", "usdt"] as const) {
    const [, , tba, tbs] = await chain.client.readContract({ address: morpho, abi: morphoAbi, functionName: "market", args: [addresses.morphoMarkets[m].id as Hex] });
    markets[m] = { totalBorrowAssets: tba, totalBorrowShares: tbs };
  }
  const lltv = BigInt(addresses.morphoMarkets.usdc.lltv);
  const positions = positionsFixture
    .filter((p) => p.borrowShares > 0n)
    .map((p) => {
      const h = computePositionHealth(p, { ...markets[p.market]!, oraclePrice, lltv });
      const debt = num(h.borrowAssets, 6);
      return { market: p.market.toUpperCase(), user: p.user, debt, healthFactor: h.healthFactor, liquidatable: h.liquidatable, liqPrice: debt / (num(p.collateral, 6) * 0.915) };
    })
    .sort((a, b) => a.healthFactor - b.healthFactor);
  const sum = (xs: { debt: number }[]) => xs.reduce((s, x) => s + x.debt, 0);
  return {
    oracle: Number(oraclePrice) / 1e36,
    liquidatableDebt: sum(positions.filter((p) => p.liquidatable)),
    within3pct: sum(positions.filter((p) => p.healthFactor < 1.03)),
    firstLiqPrice: Math.max(...positions.filter((p) => !p.liquidatable).map((p) => p.liqPrice)),
    positions: positions.slice(0, 24),
  };
}

async function syLeft(s: Strategy): Promise<bigint> {
  if (s.docked) return 0n;
  try {
    const [sy] = await chain.client.readContract({ address: chain.aqua, abi: aquaAbi, functionName: "safeBalances", args: [chain.lp, chain.router, s.hash, chain.sy, chain.pt] });
    return sy;
  } catch {
    return 0n;
  }
}

async function readLp() {
  const [walletSy, walletPt, allowance, rate] = await Promise.all([
    chain.client.readContract({ address: chain.sy, abi: erc20Abi, functionName: "balanceOf", args: [chain.lp] }),
    chain.client.readContract({ address: chain.pt, abi: erc20Abi, functionName: "balanceOf", args: [chain.lp] }),
    chain.client.readContract({ address: chain.sy, abi: erc20Abi, functionName: "allowance", args: [chain.lp, chain.aqua] }),
    syRate(),
  ]);
  const ts = await now();
  const { fair } = await spotAndFair(ts);
  const list = [];
  let promised = 0n;
  for (const s of strategies) {
    const left = await syLeft(s);
    if (!s.docked) promised += left;
    let bid: number | null = null;
    if (!s.docked && left > 0n) {
      const fairWad = BigInt(Math.round(fair * 1e18));
      bid = num((await chain.client.readContract({ address: chain.quoter, abi: chain.art.quoter.abi, functionName: "marginalBid", args: [s.params, fairWad, left] })) as bigint, 18);
    }
    list.push({
      hash: s.hash,
      shippedSy: num(s.shippedSy, 18),
      syLeft: num(left, 18),
      discountMaxBps: s.params.discountMaxBps,
      guards: s.guards !== null,
      docked: s.docked,
      shippedAt: s.shippedAt,
      shipTx: s.shipTx,
      bid,
      fills: s.fills,
    });
  }
  const real = [promised, walletSy, allowance].reduce((a, b) => (b < a ? b : a));
  const fills = strategies.flatMap((s) => s.fills);
  const ptBought = fills.reduce((a, f) => a + f.ptBought, 0);
  const paidUsd = fills.reduce((a, f) => a + f.ptBought * f.price, 0);
  const daysLeft = Math.max(0, Number(EXPIRY) - ts) / 86_400;
  const pnl = ptBought - paidUsd; // PT redeems at 1 USD at maturity
  return {
    wallet: chain.lp,
    walletSy: num(walletSy, 18),
    walletPt: num(walletPt, 6),
    walletUsd: num(walletSy, 18) * num(rate, 6),
    allowanceUnlimited: allowance === maxUint256,
    promisedSy: num(promised, 18),
    realSy: num(real, 18),
    syRate: num(rate, 6),
    strategies: list,
    pnl: {
      ptBought,
      paidUsd,
      atMaturityUsd: pnl,
      annualized: paidUsd > 0 && daysLeft > 0 ? Math.pow(ptBought / paidUsd, 365 / daysLeft) - 1 : null,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Actions

async function faucet(amountSy: number) {
  const amount = BigInt(Math.round(amountSy)) * WAD;
  await chain.dealSy(chain.lp, amount);
  await log("faucet", `LP wallet funded with ${amountSy.toLocaleString("en-US")} SY (${chain.mode === "fork" ? "fork storage edit" : "mock mint"})`);
}

async function ship(amountSy: number, discountMaxBps: number, withGuards: boolean) {
  const shipped = BigInt(Math.round(amountSy)) * WAD;
  const params = paramsFor(shipped, discountMaxBps);
  const ts = (await now()) + 12;
  const guards: WamiaGuards | null = withGuards
    ? {
        rateGuard: chain.rateGuard,
        rateGuardParams: { sy: chain.sy, rateAtShip: await syRate(), shipTimestamp: BigInt(ts), maxDropBps: 0, minElapsed: 3 * 86_400, refYieldWad: REF_YIELD_WAD, maxYieldGapBps: 1000 },
        spendLimit: chain.spendLimit,
        spendLimitParams: { shippedSy: shipped, windowSec: 12, minCapBps: 2000, horizonSec: 30 * 86_400, expiry: EXPIRY },
      }
    : null;
  const order = buildWamiaOrder(chain.lp, chain.quoter, params, guards ?? undefined);
  const hash = strategyHash(order);
  if (strategies.some((s) => s.hash === hash && !s.docked)) throw new Error("the same strategy is already shipped; change the size or the discount");
  const r = await chain.send(chain.lp, shipTx(chain.aqua, chain.router, order, chain.sy, chain.pt, shipped));
  if (r.status !== "success") throw new Error(`ship reverted (${r.hash})`);
  strategies.push({ hash, order, params, guards, shippedSy: shipped, shippedAt: ts, shipTx: r.hash, docked: false, fills: [] });
  await log("ship", `Shipped ${amountSy.toLocaleString("en-US")} SY to Aqua${withGuards ? " with the v2 guards" : ""}. No SY left the wallet.`, r.hash);
}

async function dock(hash: Hex) {
  const s = strategies.find((x) => x.hash === hash && !x.docked);
  if (!s) throw new Error("no live strategy with that hash");
  const r = await chain.send(chain.lp, dockTx(chain.aqua, chain.router, s.order, chain.sy, chain.pt));
  if (r.status !== "success") throw new Error(`dock reverted (${r.hash})`);
  s.docked = true;
  await log("dock", `Docked strategy ${hash.slice(0, 10)}. It no longer buys.`, r.hash);
}

async function setMockSpot(price: number, gapSec = 1) {
  const wad = BigInt(Math.round(price * 1e18));
  await chain.send(chain.admin, { to: chain.market, data: encodeFunctionData({ abi: marketAbi, functionName: "setSpot", args: [wad] }) }, { gapSec });
  await chain.send(chain.admin, { to: chain.pendleRouter, data: encodeFunctionData({ abi: mockRouterAbi, functionName: "setPrice", args: [wad] }) }, { gapSec: 1 });
}

const attackTemplate = (() => {
  try {
    const txs = JSON.parse(readFileSync("fixtures/attack-transactions.json", "utf8")).manipulator as { input: Hex }[];
    return txs[txs.length - 1]!.input; // the last push fills no limit orders, so it can be reused
  } catch {
    return null;
  }
})();

async function push(sySize: number) {
  const before = await spotAndFair(await now());
  if (chain.mode === "fork") {
    if (!attackTemplate) throw new Error("fixtures/attack-transactions.json missing");
    const syIn = BigInt(Math.round(sySize)) * WAD;
    await chain.dealSy(chain.attacker, syIn);
    await chain.send(chain.attacker, { to: chain.sy, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [chain.pendleRouter, maxUint256] }) }, { gapSec: 1 });
    const r = await chain.send(chain.attacker, { to: chain.pendleRouter, data: attackInput(attackTemplate, "adaptive", syIn) }, { gas: 6_000_000n });
    if (r.status !== "success") throw new Error("Pendle rejected the push (its pool caps how far one trade can move the rate); try a smaller size");
    const after = await spotAndFair(await now());
    await log("push", `Attacker bought YT with ${sySize.toLocaleString("en-US")} SY: Pendle spot ${before.spot.toFixed(4)} → ${after.spot.toFixed(4)}`, r.hash);
  } else {
    // Local mocks: a push is a price move on the mock market and the mock Pendle router.
    const drop = Math.min(0.04, 0.009 * (sySize / 50_000));
    const target = before.spot * (1 - drop);
    await setMockSpot(target, 12); // the push lands in its own block
    await log("push", `Mock push: Pendle spot ${before.spot.toFixed(4)} → ${target.toFixed(4)} (local mode moves the mock price directly)`);
  }
  await runSearcher();
}

async function runSearcher() {
  for (let round = 1; round <= 10; round++) {
    const live = strategies.filter((s) => !s.docked);
    const lefts = await Promise.all(live.map(syLeft));
    const sources: ArbSource[] = live.map((s, i) => ({ order: s.order, balanceSy: lefts[i]! })).filter((s) => s.balanceSy > 0n);
    if (sources.length === 0) {
      if (round === 1) await log("nofill", "Searcher: no live Wamia strategy to sell to.");
      break;
    }
    const rate = await syRate();
    const syTotal = sources.reduce((a, s) => a + s.balanceSy, 0n);
    const maxPt = (syTotal * rate * 10n) / WAD / 9n;
    const plan = await planArb(chain.client, chain.arb, chain.art.arb.abi, chain.errorAbi, chain.searcher, sources, {
      maxPt,
      probePt: 1_000n * 10n ** 6n,
      minProfitPt: 50n * 10n ** 6n,
      tolPt: 100n * 10n ** 6n,
    });
    if (plan.ptAmount === 0n) {
      if (plan.reason.startsWith("SpendLimitExceeded")) {
        // The guard capped this block; the searcher simulates again once the next block is mined.
        await log("nofill", "Spend limit reached for this block: the searcher waits for the next one.");
        const latest = await chain.client.getBlock({ blockTag: "latest" });
        await chain.client.request({ method: "evm_mine" as any, params: [Number(latest.timestamp) + 12] as any });
        continue;
      }
      if (round === 1) await log("nofill", `Searcher checked in ${plan.ms} ms (${plan.evals} simulations): no arb, ${plain(plan.reason)}.`);
      break;
    }
    const liveBefore = new Map(live.map((s, i) => [s.hash, lefts[i]!]));
    const r = await chain.send(chain.searcher, { to: chain.arb, data: arbCalldata(chain.art.arb.abi, sources, plan.ptAmount, 50n * 10n ** 6n, chain.searcher) }, { gas: 15_000_000n, gapSec: round === 1 ? 12 : 1 });
    if (r.status !== "success") {
      await log("error", `Arb reverted on chain after simulating ${num(plan.ptAmount, 6).toFixed(0)} PT`, r.hash);
      break;
    }
    const at = await now();
    const paidBy = new Map<Hex, bigint>();
    for (const s of live) paidBy.set(s.hash, liveBefore.get(s.hash)! - (await syLeft(s)));
    const paidTotal = [...paidBy.values()].reduce((a, x) => (x > 0n ? a + x : a), 0n);
    for (const s of live) {
      const paid = paidBy.get(s.hash)!;
      if (paid <= 0n) continue;
      const pt = (Number(plan.ptAmount) * Number(paid)) / Number(paidTotal) / 1e6;
      const syPaid = num(paid, 18);
      s.fills.push({ at, block: Number(r.blockNumber), tx: r.hash, ptBought: pt, syPaid, price: (syPaid * num(rate, 6)) / pt });
    }
    if (chain.mode === "local") {
      // The mock Pendle router has a fixed price; after the arb the market trades at Wamia's bid.
      const s0 = live.find((s) => (paidBy.get(s.hash) ?? 0n) > 0n)!;
      const fairNow = (await spotAndFair(at)).fair;
      const bid = num((await chain.client.readContract({ address: chain.quoter, abi: chain.art.quoter.abi, functionName: "marginalBid", args: [s0.params, BigInt(Math.round(fairNow * 1e18)), await syLeft(s0)] })) as bigint, 18);
      await setMockSpot(Math.min(bid, fairNow));
    }
    const after = await spotAndFair(await now());
    await log(
      "fill",
      `Searcher arb ${round}: Wamia bought ${(num(plan.ptAmount, 6)).toLocaleString("en-US", { maximumFractionDigits: 0 })} PT for ${num(paidTotal, 18).toLocaleString("en-US", { maximumFractionDigits: 0 })} SY, searcher kept ${num(plan.profitPt, 6).toFixed(0)} PT (${plan.evals} simulations, ${plan.ms} ms). Spot now ${after.spot.toFixed(4)}.`,
      r.hash
    );
    if (chain.mode === "local") break; // one fill per push against the fixed-price mock
  }
}

async function scenario(name: "run" | "loss" | "repricing" | "restore") {
  if (name === "restore") {
    if (!scenarioSnapshot) throw new Error("no scenario to undo");
    await chain.client.request({ method: "evm_revert" as any, params: [scenarioSnapshot.id] as any });
    strategies = scenarioSnapshot.strategies;
    activity = scenarioSnapshot.activity;
    history = history.filter((h) => h.block <= scenarioSnapshot!.block);
    const undone = scenarioSnapshot.name;
    scenarioSnapshot = null;
    await log("scenario", `Undid "${undone}": chain state restored.`);
    return;
  }
  if (scenarioSnapshot) throw new Error(`undo "${scenarioSnapshot.name}" first`);
  const id = (await chain.client.request({ method: "evm_snapshot" as any })) as Hex;
  scenarioSnapshot = { id, name, block: Number(await chain.client.getBlockNumber()), strategies: strategies.map((s) => ({ ...s, fills: [...s.fills] })), activity: [...activity] };
  const ts = await now();
  if (name === "loss") {
    if (chain.mode === "fork") {
      const call = { to: chain.sy, data: encodeFunctionData({ abi: erc20Abi, functionName: "exchangeRate" }) };
      const slot = await scaleValueBehind(chain.client, call, syRate, 95n, 100n);
      if (!slot) throw new Error("could not find the stored rate behind SY.exchangeRate()");
    } else {
      await chain.send(chain.admin, { to: chain.sy, data: encodeFunctionData({ abi: erc20Abi, functionName: "setExchangeRate", args: [(chain.startRate * 95n) / 100n] }) }, { gapSec: 1 });
    }
    await log("scenario", "Scenario: reUSD's vault reports a 5% loss (SY exchange rate down 5%).");
  } else if (name === "repricing") {
    const { fair, tau } = await spotAndFair(ts);
    const lnRate = BigInt(Math.round((-Math.log(fair * 0.94) / tau) * 1e18));
    if (chain.mode === "fork") {
      const read = async () => (await chain.client.readContract({ address: chain.market, abi: marketAbi, functionName: "_storage" }))[2];
      const call = { to: chain.market, data: encodeFunctionData({ abi: marketAbi, functionName: "_storage" }) };
      if (!(await setPackedFieldBehind(chain.client, call, read, lnRate, 96))) throw new Error("could not find the market's stored implied rate");
    } else {
      await setMockSpot(fair * 0.94);
    }
    await log("scenario", "Scenario: news reprices the market, Pendle spot 6% below fair value.");
  } else {
    if (chain.mode === "fork") {
      await chain.client.request({ method: "evm_revert" as any, params: [id] as any });
      scenarioSnapshot = null;
      throw new Error("the run case needs 20 minutes of real Curve trading on the fork; npm run scenario:collapse -- run replays it");
    }
    await chain.send(chain.admin, { to: chain.curve, data: encodeFunctionData({ abi: mockCurveAbi, functionName: "set", args: [1_015_228_426_395_939_086n, 1_015_228_426_395_939_086n] }) }, { gapSec: 1 });
    await log("scenario", "Scenario: a run on reUSD, trading 1.5% below its NAV on Curve (EMA).");
  }
}

async function reset() {
  await chain.client.request({ method: "evm_revert" as any, params: [baseSnapshot] as any });
  baseSnapshot = (await chain.client.request({ method: "evm_snapshot" as any })) as Hex;
  strategies = [];
  activity = [];
  history = [];
  scenarioSnapshot = null;
  await log("reset", "Chain reset to the start.");
}

// ---------------------------------------------------------------------------------------------
// Inspect: decode the program and check each Extruction target

function parseProgram(data: Hex) {
  const bytes = Buffer.from(data.slice(2), "hex");
  const steps: { opcode: number; target: Hex; args: Hex }[] = [];
  for (let i = 0; i < bytes.length; ) {
    const opcode = bytes[i]!;
    const len = bytes[i + 1]!;
    const args = bytes.subarray(i + 2, i + 2 + len);
    steps.push({ opcode, target: `0x${args.subarray(0, 20).toString("hex")}` as Hex, args: `0x${args.subarray(20).toString("hex")}` as Hex });
    i += 2 + len;
  }
  return steps;
}

/** Opcodes a resolver would not want in a pricing target, found by walking the code (PUSH data skipped, metadata cut). */
function scanCode(code: Hex) {
  const b = Buffer.from(code.slice(2), "hex");
  const metaLen = b.length >= 2 ? b.readUInt16BE(b.length - 2) + 2 : 0;
  const end = metaLen < b.length ? b.length - metaLen : b.length;
  const found = new Set<string>();
  for (let i = 0; i < end; i++) {
    const op = b[i]!;
    if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
    else if (op === 0xf4) found.add("DELEGATECALL");
    else if (op === 0xff) found.add("SELFDESTRUCT");
    else if (op === 0xf2) found.add("CALLCODE");
  }
  return [...found];
}

function sameBuild(onchain: Hex, art: Artifact) {
  const a = Buffer.from(onchain.slice(2), "hex");
  const b = Buffer.from(art.deployedBytecode.slice(2), "hex");
  if (a.length !== b.length) return false;
  for (const { start, length } of art.immutableRanges) {
    a.fill(0, start, start + length);
    b.fill(0, start, start + length);
  }
  return a.equals(b);
}

async function inspect(hash: Hex) {
  const s = strategies.find((x) => x.hash === hash);
  if (!s) throw new Error("unknown strategy");
  const built = s.order.build();
  const steps = parseProgram(built.data as Hex);
  const out = [];
  for (const step of steps) {
    const target = step.target.toLowerCase();
    const which = target === chain.quoter.toLowerCase() ? "quoter" : target === chain.rateGuard.toLowerCase() ? "rateGuard" : target === chain.spendLimit.toLowerCase() ? "spendLimit" : null;
    const code = (await chain.client.getCode({ address: step.target })) ?? "0x";
    const impl = await chain.client.getStorageAt({ address: step.target, slot: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" });
    let decoded: Record<string, string> = {};
    if (which) {
      const art = chain.art[which];
      const p = (await chain.client.readContract({ address: step.target, abi: art.abi, functionName: "decodeParams", args: [step.args] })) as Record<string, unknown>;
      decoded = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)]));
    }
    out.push({
      opcode: `0x${step.opcode.toString(16).padStart(2, "0")}`,
      instruction: step.opcode === 0x20 ? "Extruction" : "unknown",
      target: step.target,
      contract: which === "quoter" ? "WamiaQuoter" : which === "rateGuard" ? "WamiaRateGuard" : which === "spendLimit" ? "WamiaSpendLimit" : "unknown",
      argsBytes: (step.args.length - 2) / 2,
      params: decoded,
      checks: {
        codeSize: (code.length - 2) / 2,
        codeHash: keccak256(code),
        matchesRepoBuild: which ? sameBuild(code, chain.art[which]) : false,
        noProxy: !impl || BigInt(impl) === 0n,
        riskyOpcodes: scanCode(code),
      },
    });
  }
  return { hash, maker: built.maker, traits: `0x${built.traits.toString(16)}`, programBytes: ((built.data as string).length - 2) / 2, steps: out, router: chain.router, aqua: chain.aqua };
}

async function quote(hash: Hex, ptAmount: number) {
  const s = strategies.find((x) => x.hash === hash);
  if (!s) throw new Error("unknown strategy");
  const amount = BigInt(Math.round(ptAmount * 1e6));
  const c = quoteSellPtTx(chain.router, s.order, chain.pt, chain.sy, amount);
  try {
    const { data } = await chain.client.call({ account: chain.searcher, to: c.to, data: c.data });
    const [amountIn, amountOut] = decodeFunctionResult({ abi: ABI.SWAP_VM_ABI as Abi, functionName: "quote", data: data! }) as [bigint, bigint, Hex];
    const rate = await syRate();
    const syOut = num(amountOut, 18);
    return { ok: true, ptIn: num(amountIn, 6), syOut, usdPerPt: (syOut * num(rate, 6)) / num(amountIn, 6) };
  } catch (e) {
    return { ok: false, reason: revertReason(e, chain.errorAbi) };
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
};

async function body(req: IncomingMessage): Promise<any> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    busy = label;
    try {
      return await fn();
    } finally {
      busy = null;
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  if (startError) return json(res, 503, { error: startError });
  if (!chain) return json(res, 503, { error: "starting: deploying Wamia on the chain…" });
  try {
    if (req.method === "GET" && path === "/api/state") {
      const [market, lp] = await Promise.all([readMarket(), readLp()]);
      return json(res, 200, {
        chain: { mode: chain.mode, rpc: RPC, block: market.block, ts: market.ts, busy, scenario: scenarioSnapshot?.name ?? null },
        contracts: { aqua: chain.aqua, router: chain.router, quoter: chain.quoter, arb: chain.arb, rateGuard: chain.rateGuard, spendLimit: chain.spendLimit, pt: chain.pt, sy: chain.sy, market: chain.market },
        market,
        lp,
        activity: activity.slice(-60),
        history,
      });
    }
    if (req.method === "GET" && path === "/api/ladder") {
      const size = Number(url.searchParams.get("sy") ?? "5000000");
      const dmax = Number(url.searchParams.get("dmax") ?? "30");
      const shipped = BigInt(Math.round(size)) * WAD;
      const p = paramsFor(shipped, dmax);
      const { fair, spot } = await spotAndFair(await now());
      const fairWad = BigInt(Math.round(fair * 1e18));
      const points = [];
      for (let k = 0; k <= 20; k++) {
        const used = (shipped * BigInt(k)) / 20n;
        const bid = (await chain.client.readContract({ address: chain.quoter, abi: chain.art.quoter.abi, functionName: "marginalBid", args: [p, fairWad, shipped - used] })) as bigint;
        points.push({ usedSy: num(used, 18), bid: num(bid, 18) });
      }
      return json(res, 200, { fair, spot, points });
    }
    if (req.method === "GET" && path === "/api/inspect") return json(res, 200, await inspect(url.searchParams.get("hash") as Hex));
    if (req.method === "POST") {
      const b = await body(req);
      if (path === "/api/faucet") await exclusive("Funding the LP wallet", () => faucet(Number(b.sy ?? 5_000_000)));
      else if (path === "/api/ship") await exclusive("Shipping to Aqua", () => ship(Number(b.sy), Number(b.discountMaxBps ?? 30), Boolean(b.guards)));
      else if (path === "/api/dock") await exclusive("Docking", () => dock(b.hash));
      else if (path === "/api/push") await exclusive("Attacker pushing, searcher arbing", () => push(Number(b.sy ?? 50_000)));
      else if (path === "/api/scenario") await exclusive("Applying scenario", () => scenario(b.name));
      else if (path === "/api/reset") await exclusive("Resetting", reset);
      else if (path === "/api/quote") return json(res, 200, await quote(b.hash, Number(b.pt)));
      else return json(res, 404, { error: "not found" });
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: "not found" });
  } catch (e: any) {
    const message = e?.shortMessage ?? e?.message ?? String(e);
    if (req.method === "POST") await log("error", message).catch(() => undefined);
    return json(res, 400, { error: message });
  }
}

createServer((req, res) => void handle(req, res)).listen(PORT, "127.0.0.1", () => console.log(`Wamia app server on http://127.0.0.1:${PORT} (chain ${RPC})`));

connect()
  .then(async (c) => {
    chain = c;
    baseSnapshot = (await chain.client.request({ method: "evm_snapshot" as any })) as Hex;
    console.log(`${chain.mode} mode: quoter ${chain.quoter}, arb ${chain.arb}, LP ${chain.lp}`);
    await log("reset", chain.mode === "fork" ? "Connected to the mainnet fork. Wamia deployed next to the real Aqua and router." : "Local mode: Aqua, the router, Wamia and mock Pendle/Curve deployed on a plain anvil.");
  })
  .catch((e) => {
    startError = e.message;
    console.error(e.message);
  });

/**
 * Levee maker scenario (spec 7.6) on the mainnet fork at block 25829822.
 *
 *   1. Deploy LeveeQuoter and LeveeArb; ship Levee strategies (the LP capital) to the deployed
 *      Aqua with the deployed AquaSwapVMRouter.
 *   2. Replay the Aug 25 plan: the 11 manipulator trades (historical or adaptive calldata, see
 *      attacker.ts) and the background transactions, skipping historical liquidations
 *      (state-only mode, as the taker runs).
 *   3. After each Pendle-moving trade, a searcher sizes and sends a LeveeArb backrun: latency 0
 *      lands it right behind the trade (same block on mainnet; +1 s here since anvil needs
 *      increasing timestamps), latency 1 in the next block (+12 s). A trade scheduled before the
 *      arb goes first, which is the conservative order for Levee.
 *   4. Measure like the taker: spot, oracle and eligible debt at every step, plus every fill,
 *      the SY used, the LP's PnL and the manipulator's tx statuses.
 *
 * Needs anvil forked at the fork block on port 8545 and `forge build` in contracts/.
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { encodeFunctionData, maxUint256 } from "viem";
import { fork } from "../chain/client.js";
import { resetFork, sendHistoricalTx, mineEmptyBlockAt } from "./actions.js";
import { measurePoint, readAllPositions } from "../measure/measure.js";
import { readPendleSnapshot } from "../snapshot/pendle.js";
import { dealErc20AtSlot } from "./dealErc20.js";
import { attackInput, extraAttackEvents, type AttackerMode } from "./attacker.js";
import { planArb, arbCalldata } from "../strategies/searcher.js";
import { tauFromTimestamps } from "../pricing/fairValue.js";
import {
  deployLevee,
  shipLevee,
  walletFor,
  sendAs,
  aquaSyBalance,
  balanceOf,
  syExchangeRate,
  leveeBid,
  SY_BALANCE_SLOT,
  PENDLE_ROUTER,
  erc20Abi,
  MARKET,
  PT,
  SY,
  type LeveeLp,
} from "../aqua/forkLevee.js";
import addresses from "../../config/addresses.json" with { type: "json" };

type Hex = `0x${string}`;

const FORK_BLOCK = 25829822n;
const TICK_SECONDS = 60;
const POST_TICKS = 30;
const FAIR_AT_T0 = 0.971; // PT spot at the fork block, USD per PT
const EXTRA_PUSH_CHUNK = 50_000n * 10n ** 18n; // the manipulator's largest trade
const ARB = {
  probePt: 1_000n * 10n ** 6n,
  minProfitPt: 50n * 10n ** 6n, // skip dust: ~$50, well above an arb's gas cost
  tolPt: 100n * 10n ** 6n,
};

export type MakerRunConfig = {
  label: string;
  capitalSy: bigint; // total SY shipped, split equally across `lps` wallets
  lps: number;
  latencyBlocks: 0 | 1;
  attacker: AttackerMode;
  extraAttackSy: bigint; // persistent attacker: more SY pushed after the last historical trade
};

function gasLimitFor(mainnetGas: bigint) {
  return mainnetGas * 2n > 1_000_000n ? mainnetGas * 2n : 1_000_000n;
}

const fmt = (raw: bigint, decimals: number, digits = 0) =>
  (Number(raw) / 10 ** decimals).toLocaleString(undefined, { maximumFractionDigits: digits });

export async function runMakerScenario(config: MakerRunConfig) {
  await resetFork(fork, FORK_BLOCK);
  const expiry = Math.floor(new Date(addresses.pendle.expiry).getTime() / 1000);

  // 1. Levee contracts and LP strategies.
  const deployer = walletFor("levee-deployer");
  const searcher = walletFor("levee-searcher");
  const levee = await deployLevee(fork, deployer);
  const rateAtShip = await syExchangeRate(fork);
  const minSyRate = (rateAtShip * 99n) / 100n;

  const lps: LeveeLp[] = [];
  const nLps = config.capitalSy > 0n ? config.lps : 0; // zero capital: the no-backstop baseline
  for (let i = 0; i < nLps; i++) {
    const share = i === nLps - 1 ? config.capitalSy - (config.capitalSy / BigInt(nLps)) * BigInt(i) : config.capitalSy / BigInt(nLps);
    lps.push(await shipLevee(fork, levee.quoter, walletFor(`levee-lp-${i}`), share, minSyRate));
  }
  console.log(`[${config.label}] quoter ${levee.quoter}, arb ${levee.arb}, ${lps.length} LP(s) shipped ${fmt(config.capitalSy, 18)} SY`);

  // 2. Events: the replay plan, plus extra pushes for a persistent attacker.
  const plan: any[] = JSON.parse(readFileSync("fixtures/replay-plan.json", "utf8"));
  const manipulator = plan.find((e) => e.role === "manipulator").from as Hex;
  let events = plan;
  if (config.extraAttackSy > 0n) {
    const lastPush = [...plan].reverse().find((e) => e.role === "manipulator");
    const extra = extraAttackEvents(lastPush, config.extraAttackSy, EXTRA_PUSH_CHUNK);
    events = [...plan, ...extra].sort((a, b) => Number(a.timeStamp) - Number(b.timeStamp)); // stable: ties keep plan order
    const held = await balanceOf(fork, SY, manipulator);
    await dealErc20AtSlot(fork, SY, manipulator, held + config.extraAttackSy, SY_BALANCE_SLOT);
    // The attacker's own setup: its historical approvals may cover only what it spent then.
    await sendAs(fork, manipulator, { to: SY, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PENDLE_ROUTER, maxUint256] }) });
  }

  let block = await fork.getBlockNumber({ cacheTime: 0 });
  let positions = await readAllPositions(fork, block);
  const points: any[] = [];
  const arbs: any[] = [];
  const pushes: { label: string; extra: boolean; status: string }[] = [];
  let skippedLiquidations = 0;

  const t0 = await measurePoint(fork, "t0", block, positions);
  points.push(t0);
  let lastTs: number = t0.timestamp;
  console.log(`[${config.label}] t0: PT ${t0.ptSpotPrice.toFixed(4)}, oracle ${t0.oraclePrice.toFixed(4)}`);

  // 3. The searcher's backrun.
  const delay = config.latencyBlocks === 0 ? 1 : 12;
  let pending: { dueTs: number; after: string } | null = null;

  async function runArb(ts: number) {
    const after = pending!.after;
    pending = null;

    const sources = await Promise.all(lps.map(async (lp) => ({ lp, order: lp.order, balanceSy: await aquaSyBalance(fork, lp) })));
    const syLeft = sources.reduce((s, x) => s + x.balanceSy, 0n);
    if (syLeft === 0n) return;
    const rate = await syExchangeRate(fork);
    // Upper bound on PT Levee could buy: all its SY at a price no lower than 0.9 USD per PT.
    const maxPt = (syLeft * rate * 10n) / 10n ** 18n / 9n;

    const plan = await planArb(fork, levee.arb, levee.arbAbi, levee.errorAbi, searcher, sources, { ...ARB, maxPt });
    if (plan.ptAmount === 0n) {
      console.log(`    [no arb after ${after}] ${plan.reason} (${plan.evals} sims, ${plan.ms} ms)`);
      return;
    }

    const spotBefore = (await readPendleSnapshot(fork, MARKET, block)).ptSpotPrice;
    const searcherPtBefore = await balanceOf(fork, PT, searcher);
    const receipt = await sendAs(
      fork,
      searcher,
      { to: levee.arb, data: arbCalldata(levee.arbAbi, sources, plan.ptAmount, ARB.minProfitPt, searcher) },
      { gas: 15_000_000n, timestamp: ts }
    );
    block = receipt.blockNumber;
    lastTs = ts;
    if (receipt.status !== "success") {
      console.log(`    [arb after ${after} REVERTED] simulated ${fmt(plan.ptAmount, 6)} PT`);
      arbs.push({ after, block: block.toString(), status: "reverted", ptAmount: plan.ptAmount.toString() });
      return;
    }

    const balancesAfter = await Promise.all(lps.map((lp) => aquaSyBalance(fork, lp)));
    const syPaid = sources.reduce((s, x, i) => s + x.balanceSy - balancesAfter[i]!, 0n);
    const profitPt = (await balanceOf(fork, PT, searcher)) - searcherPtBefore;
    const spotAfter = (await readPendleSnapshot(fork, MARKET, block)).ptSpotPrice;
    const bid = await leveeBid(fork, levee.quoter, levee.quoterAbi, lps[0]!, balancesAfter[0]!);
    const paidUsdPerPt = Number(syPaid * rate) / 1e18 / 1e6 / (Number(plan.ptAmount) / 1e6);

    console.log(
      `  [arb after ${after}] Levee bought ${fmt(plan.ptAmount, 6)} PT for ${fmt(syPaid, 18)} SY (${paidUsdPerPt.toFixed(4)} USD/PT), ` +
        `searcher +${fmt(profitPt, 6)} PT, spot ${spotBefore.toFixed(4)} -> ${spotAfter.toFixed(4)}, ` +
        `bid now ${bid ? bid.bid.toFixed(4) : "refused"} (${plan.evals} sims, ${plan.ms} ms, gas ${receipt.gasUsed})`
    );
    arbs.push({
      after,
      block: block.toString(),
      timestamp: ts,
      status: "success",
      ptBought: plan.ptAmount.toString(),
      syPaid: syPaid.toString(),
      syRate: rate.toString(),
      paidUsdPerPt,
      searcherProfitPt: profitPt.toString(),
      spotBefore,
      spotAfter,
      fairAfter: bid?.fair ?? null,
      bidAfter: bid?.bid ?? null,
      sims: plan.evals,
      searchMs: plan.ms,
      gasUsed: receipt.gasUsed.toString(),
    });
    points.push(await measurePoint(fork, `arb after ${after}`, block, positions));
  }

  /** Mines ticks and runs a pending arb, in time order, for everything strictly before `ts`. */
  async function advanceBefore(ts: number) {
    for (;;) {
      const nextTick = lastTs + TICK_SECONDS;
      const arbTs = pending ? Math.max(pending.dueTs, lastTs + 1) : Infinity;
      if (arbTs < ts && arbTs <= nextTick) {
        await runArb(arbTs);
      } else if (nextTick < ts) {
        block = await mineEmptyBlockAt(fork, nextTick);
        lastTs = nextTick;
        points.push(await measurePoint(fork, "tick", block, positions));
      } else {
        return;
      }
    }
  }

  const counters: Record<string, number> = {};
  for (const ev of events) {
    const ts = Number(ev.timeStamp);
    await advanceBefore(ts);

    if (ev.kind.startsWith("liquidation")) {
      skippedLiquidations++;
      lastTs = Math.max(lastTs, ts);
      continue;
    }

    let tx = ev;
    let gas = gasLimitFor(BigInt(ev.gasUsed));
    if (ev.role === "manipulator" && (config.attacker === "adaptive" || ev.extra)) {
      tx = ev.extra ? ev : { ...ev, input: attackInput(ev.input, "adaptive") };
      gas = gas > 3_000_000n ? gas : 3_000_000n; // Pendle's open solver search costs more gas than tight bounds
    }
    const receipt = await sendHistoricalTx(fork, tx, gas);
    block = receipt.blockNumber;
    lastTs = Math.max(lastTs, ts);

    const role = ev.extra ? "extra" : ev.role;
    counters[role] = (counters[role] ?? 0) + 1;
    if (ev.kind === "morpho-other") positions = await readAllPositions(fork, block);

    const tag = receipt.status === "success" ? "ok" : "REV";
    const label = `${role.slice(0, 5)}-${counters[role]} ${tag}`;
    if (ev.role === "manipulator") pushes.push({ label, extra: !!ev.extra, status: receipt.status });
    points.push({ ...(await measurePoint(fork, label, block, positions)), txHash: ev.hash, txStatus: receipt.status });
    if (ev.role === "manipulator") console.log(`  ${label}: spot ${points[points.length - 1].ptSpotPrice.toFixed(4)}`);

    if ((ev.kind === "attack" || ev.kind === "pendle-trade") && receipt.status === "success" && !pending) {
      pending = { dueTs: ts + delay, after: label };
    }
  }
  if (pending) await runArb(Math.max((pending as { dueTs: number }).dueTs, lastTs + 1));

  for (let k = 0; k < POST_TICKS; k++) {
    lastTs += TICK_SECONDS;
    block = await mineEmptyBlockAt(fork, lastTs);
    points.push(await measurePoint(fork, "post-tick", block, positions));
  }

  // 4. Summary.
  const rateEnd = await syExchangeRate(fork);
  const spotEnd = (await readPendleSnapshot(fork, MARKET, block)).ptSpotPrice;
  let syUsed = 0n;
  let ptHeld = 0n;
  for (const lp of lps) {
    syUsed += lp.shippedSy - (await aquaSyBalance(fork, lp));
    ptHeld += await balanceOf(fork, PT, lp.wallet);
  }
  const costUsd = Number(syUsed * rateEnd) / 1e18 / 1e6;
  const pt = Number(ptHeld) / 1e6;
  const firstFillTs = arbs.find((a) => a.status === "success")?.timestamp ?? lastTs;
  const tau = tauFromTimestamps(firstFillTs, expiry);
  const hold = costUsd > 0 ? pt / costUsd - 1 : 0;

  const peak = (f: (p: any) => number) => Math.max(...points.map(f));
  const summary = {
    label: config.label,
    config: { ...config, capitalSy: config.capitalSy.toString(), extraAttackSy: config.extraAttackSy.toString() },
    skippedLiquidations,
    manipulator: {
      historicalOk: pushes.filter((p) => !p.extra && p.status === "success").length,
      historicalReverted: pushes.filter((p) => !p.extra && p.status !== "success").length,
      extraOk: pushes.filter((p) => p.extra && p.status === "success").length,
      extraReverted: pushes.filter((p) => p.extra && p.status !== "success").length,
    },
    arbs: arbs.filter((a) => a.status === "success").length,
    arbsReverted: arbs.filter((a) => a.status !== "success").length,
    shippedSy: Number(config.capitalSy) / 1e18,
    syUsed: Number(syUsed) / 1e18,
    usedShare: config.capitalSy > 0n ? Number(syUsed) / Number(config.capitalSy) : 0,
    ptBought: pt,
    searcherProfitPt: Number(await balanceOf(fork, PT, searcher)) / 1e6,
    spotMin: Math.min(...points.map((p) => p.ptSpotPrice)),
    oracleMin: Math.min(...points.map((p) => p.oraclePrice)),
    peakEligible: {
      usdcCount: peak((p) => p.markets.usdc.liquidatableCount),
      usdcDebt: peak((p) => Number(p.markets.usdc.liquidatableDebt)) / 1e6,
      usdtCount: peak((p) => p.markets.usdt.liquidatableCount),
      usdtDebt: peak((p) => Number(p.markets.usdt.liquidatableDebt)) / 1e6,
    },
    lp: {
      costUsd,
      avgPaidUsdPerPt: pt > 0 ? costUsd / pt : null,
      holdToMaturity: hold,
      holdToMaturityAnnualized: costUsd > 0 && tau > 0 ? Math.pow(1 + hold, 1 / tau) - 1 : 0,
      markToMarketAtFair: costUsd > 0 ? (pt * FAIR_AT_T0) / costUsd - 1 : 0,
      markToMarketAtEndSpot: costUsd > 0 ? (pt * spotEnd) / costUsd - 1 : 0,
      daysToMaturity: tau * 365,
    },
  };

  const dir = `results/scenario-${config.label}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/timeseries.json`, JSON.stringify(points, null, 2));
  writeFileSync(`${dir}/arbs.json`, JSON.stringify(arbs, null, 2));
  writeFileSync(`${dir}/summary.json`, JSON.stringify(summary, null, 2));

  const e = summary.peakEligible;
  console.log(`\n[${config.label}] Summary (state-only: ${skippedLiquidations} historical liquidation txs skipped by design)`);
  console.log(
    `  Manipulator: ${summary.manipulator.historicalOk}/11 historical pushes ok` +
      (config.extraAttackSy > 0n ? `, ${summary.manipulator.extraOk} extra pushes ok, ${summary.manipulator.extraReverted} reverted` : "")
  );
  console.log(`  Levee: ${summary.arbs} fills, ${fmt(syUsed, 18)} of ${fmt(config.capitalSy, 18)} SY used (${(summary.usedShare * 100).toFixed(1)}%), ${pt.toLocaleString(undefined, { maximumFractionDigits: 0 })} PT bought`);
  console.log(`  Spot min ${summary.spotMin.toFixed(4)}, oracle min ${summary.oracleMin.toFixed(4)}`);
  console.log(`  Peak eligible: USDC ${e.usdcCount} pos / $${e.usdcDebt.toLocaleString(undefined, { maximumFractionDigits: 0 })}, USDT ${e.usdtCount} pos / $${e.usdtDebt.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  if (costUsd > 0) {
    console.log(
      `  LP: paid ${summary.lp.avgPaidUsdPerPt!.toFixed(4)} USD/PT, hold to maturity ${(hold * 100).toFixed(2)}% ` +
        `(${(summary.lp.holdToMaturityAnnualized * 100).toFixed(1)}% annualized; fair-value buyers 10.58%), ` +
        `mark to market at 0.971 ${(summary.lp.markToMarketAtFair * 100).toFixed(2)}%`
    );
  }
  console.log(`  Searcher profit: ${summary.searcherProfitPt.toLocaleString(undefined, { maximumFractionDigits: 0 })} PT`);
  return summary;
}

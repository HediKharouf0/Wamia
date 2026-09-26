/**
 * P1nch maker scenario (spec 7.6) on the mainnet fork at block 25829822.
 *
 *   1. Deploy P1nchQuoter and P1nchArb; ship P1nch strategies (the LP capital) to the deployed
 *      Aqua with the deployed AquaSwapVMRouter.
 *   2. Replay the Aug 25 plan: the 11 manipulator trades (historical or adaptive calldata, see
 *      attacker.ts) and the background transactions, skipping historical liquidations
 *      (state-only mode, as the taker runs).
 *   3. After each Pendle-moving trade, a searcher sizes and sends a P1nchArb backrun: latency 0
 *      lands it right behind the trade (same block on mainnet; +1 s here since anvil needs
 *      increasing timestamps), latency 1 in the next block (+12 s). A trade scheduled before the
 *      arb goes first, which is the conservative order for P1nch.
 *   4. Measure like the taker: spot, oracle and eligible debt at every step, plus every fill,
 *      the SY used, the LP's PnL and the manipulator's tx statuses.
 *
 * Needs anvil forked at the fork block on port 8545 and `forge build` in contracts/.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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
  deployP1nch,
  shipP1nch,
  walletFor,
  sendAs,
  aquaSyBalance,
  balanceOf,
  syExchangeRate,
  p1nchBid,
  SY_BALANCE_SLOT,
  PENDLE_ROUTER,
  erc20Abi,
  MARKET,
  PT,
  SY,
  type P1nchLp,
} from "../aqua/forkP1nch.js";
import addresses from "../../config/addresses.json" with { type: "json" };

type Hex = `0x${string}`;

const FORK_BLOCK = 25829822n;
const TICK_SECONDS = 60;
const POST_TICKS = 30;
const MAX_ARB_ROUNDS = 10;
const SPEND_WINDOW_SEC = 12; // P1nchSpendLimit window in the demo guards (one mainnet block)
const MAX_SPEND_RETRIES = 100; // safety stop for the loop after the last event
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
  discountMaxBps?: number; // override the strategy's deepest discount (default 60 bp)
  guards?: boolean; // ship [RateGuard][Quoter][SpendLimit] instead of the quoter alone
};

function gasLimitFor(mainnetGas: bigint) {
  return mainnetGas * 2n > 1_000_000n ? mainnetGas * 2n : 1_000_000n;
}

const fmt = (raw: bigint, decimals: number, digits = 0) =>
  (Number(raw) / 10 ** decimals).toLocaleString(undefined, { maximumFractionDigits: digits });

/**
 * Every run starts from the fork block. The first run resets the fork and takes an anvil snapshot;
 * later runs revert to it. Unlike anvil_reset, a revert keeps the mainnet state anvil has already
 * fetched, so later runs skip most upstream requests. The state they start from is identical.
 * (A snapshot is used up by its revert, so a new one is taken each time.) The id is kept in a temp
 * file so separate `npm run` commands share it; if anvil was restarted, the revert fails and the
 * run falls back to a reset.
 */
const SNAPSHOT_FILE = join(tmpdir(), "p1nch-anvil-fork-snapshot");
export async function freshFork() {
  const saved = existsSync(SNAPSHOT_FILE) ? readFileSync(SNAPSHOT_FILE, "utf8").trim() : "";
  let reverted = false;
  if (saved) {
    try {
      reverted = (await fork.request({ method: "evm_revert" as any, params: [saved] as any })) === true;
    } catch {
      reverted = false;
    }
  }
  if (!reverted || (await fork.getBlockNumber({ cacheTime: 0 })) !== FORK_BLOCK) {
    await resetFork(fork, FORK_BLOCK);
  }
  writeFileSync(SNAPSHOT_FILE, (await fork.request({ method: "evm_snapshot" as any })) as string);
}

export async function runMakerScenario(config: MakerRunConfig) {
  await freshFork();
  const expiry = Math.floor(new Date(addresses.pendle.expiry).getTime() / 1000);

  // 1. P1nch contracts and LP strategies. Setup transactions get timestamps 1 s apart from the
  //    fork block, so they are all mined before the first replayed trade (12 s later).
  const plan: any[] = JSON.parse(readFileSync("fixtures/replay-plan.json", "utf8"));
  let setupTs = Number((await fork.getBlock({ blockNumber: FORK_BLOCK })).timestamp);
  const nextTs = () => {
    setupTs += 1;
    if (setupTs >= Number(plan[0].timeStamp)) throw new Error("setup does not fit before the first replayed trade: use fewer LPs");
    return setupTs;
  };
  const deployer = walletFor("p1nch-deployer");
  const searcher = walletFor("p1nch-searcher");
  const p1nch = await deployP1nch(fork, deployer, nextTs, config.guards === true);
  const guardAddresses = p1nch.rateGuard && p1nch.spendLimit ? { rateGuard: p1nch.rateGuard, spendLimit: p1nch.spendLimit } : undefined;
  const rateAtShip = await syExchangeRate(fork);
  const minSyRate = (rateAtShip * 99n) / 100n;

  const lps: P1nchLp[] = [];
  const nLps = config.capitalSy > 0n ? config.lps : 0; // zero capital: the no-backstop baseline
  for (let i = 0; i < nLps; i++) {
    const share = i === nLps - 1 ? config.capitalSy - (config.capitalSy / BigInt(nLps)) * BigInt(i) : config.capitalSy / BigInt(nLps);
    lps.push(await shipP1nch(fork, p1nch.quoter, walletFor(`p1nch-lp-${i}`), share, minSyRate, { discountMaxBps: config.discountMaxBps, nextTs, guards: guardAddresses }));
  }
  console.log(`[${config.label}] quoter ${p1nch.quoter}, arb ${p1nch.arb}, ${lps.length} LP(s) shipped ${fmt(config.capitalSy, 18)} SY`);

  // 2. Events: the replay plan, plus extra pushes for a persistent attacker.
  const manipulator = plan.find((e) => e.role === "manipulator").from as Hex;
  let events = plan;
  if (config.extraAttackSy > 0n) {
    const lastPush = [...plan].reverse().find((e) => e.role === "manipulator");
    const extra = extraAttackEvents(lastPush, config.extraAttackSy, EXTRA_PUSH_CHUNK);
    events = [...plan, ...extra].sort((a, b) => Number(a.timeStamp) - Number(b.timeStamp)); // stable: ties keep plan order
    const held = await balanceOf(fork, SY, manipulator);
    await dealErc20AtSlot(fork, SY, manipulator, held + config.extraAttackSy, SY_BALANCE_SLOT);
    // The attacker's own setup: its historical approvals may cover only what it spent then.
    await sendAs(fork, manipulator, { to: SY, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PENDLE_ROUTER, maxUint256] }) }, { timestamp: nextTs() });
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
  let lastSpot = t0.ptSpotPrice;
  console.log(`[${config.label}] #${block}  t0   PT spot ${t0.ptSpotPrice.toFixed(4)}, oracle ${t0.oraclePrice.toFixed(4)}  (replay starts here)`);

  /**
   * Block-by-block log. Every block that carries a decision (a push landing, an arb buying or
   * refusing, the spend limit pausing the searcher) gets its own line, printed at the moment it
   * happens. Blocks that carry no decision (empty ticks mined only to advance time) are silent as
   * they occur and collapsed into one summary line, flushed the moment something real follows.
   */
  let idle: { fromBlock: bigint; toBlock: bigint; seconds: number } | null = null;
  function noteIdleTick(b: bigint, seconds: number) {
    if (!idle) idle = { fromBlock: b, toBlock: b, seconds };
    else {
      idle.toBlock = b;
      idle.seconds += seconds;
    }
  }
  function flushIdle(reason = "waiting for the next scheduled event") {
    if (!idle) return;
    const span = idle.toBlock === idle.fromBlock ? `#${idle.fromBlock}` : `#${idle.fromBlock}..${idle.toBlock}`;
    const n = Number(idle.toBlock - idle.fromBlock) + 1;
    console.log(`${span}  (${n} empty block${n > 1 ? "s" : ""}, ${idle.seconds}s)  idle: ${reason}`);
    idle = null;
  }

  // 3. The searcher's backrun.
  const delay = config.latencyBlocks === 0 ? 1 : 12;
  /** `newWindow`: a retry after the spend limit, which must first reach the next spending window. */
  let pending: { dueTs: number; after: string; newWindow?: boolean } | null = null;
  let stopReason = "";

  /**
   * The searcher keeps arbing while it pays. Pendle prices a whole swap at its post-trade rate, so
   * one arb stops well short of P1nch's bid and leaves a new opportunity behind; a real searcher
   * takes it in the same block (a bundle). Rounds are 1 s apart here and never pass `limitTs`,
   * the next scheduled transaction.
   */
  async function runArb(ts: number, limitTs: number) {
    const { after, newWindow } = pending!;
    pending = null;
    stopReason = "";
    if (newWindow) {
      // The searcher simulates with eth_call on the latest block, so that block must already be in
      // the new window, or it keeps seeing the old window's spending. Mine an empty one there first.
      block = await mineEmptyBlockAt(fork, ts);
      lastTs = ts;
      points.push(await measurePoint(fork, "tick", block, positions));
      ts++;
      if (ts >= limitTs) {
        pending = { dueTs: ts, after };
        return;
      }
    }
    for (let round = 1; round <= MAX_ARB_ROUNDS && ts < limitTs; round++, ts++) {
      if (!(await arbRound(ts, after, round))) break;
    }
    // The spend limit stopped the searcher for this block: it comes back in the next one.
    if (stopReason.startsWith("SpendLimitExceeded") && !pending) {
      flushIdle();
      const next = (Math.floor(lastTs / SPEND_WINDOW_SEC) + 1) * SPEND_WINDOW_SEC;
      console.log(`#${block} spend-limit  DEFER   P1nch pauses arbing for this block`);
      console.log(`         why: this block's spend cap is used up; retries once the next ${SPEND_WINDOW_SEC}s window opens (t+${next - lastTs}s)`);
      pending = { dueTs: next, after, newWindow: true };
    }
  }

  /** One arb transaction at `ts`; false when there is nothing worth doing. */
  async function arbRound(ts: number, after: string, round: number): Promise<boolean> {
    const sources = await Promise.all(lps.map(async (lp) => ({ lp, order: lp.order, balanceSy: await aquaSyBalance(fork, lp) })));
    const syLeft = sources.reduce((s, x) => s + x.balanceSy, 0n);
    if (syLeft === 0n) {
      flushIdle();
      console.log(`#${block} arb #${round}  SKIP    no trade sent`);
      console.log(`         why: this strategy has no SY left to sell`);
      return false;
    }
    const rate = await syExchangeRate(fork);
    // Upper bound on PT P1nch could buy: all its SY at a price no lower than 0.9 USD per PT.
    const maxPt = (syLeft * rate * 10n) / 10n ** 18n / 9n;

    const plan = await planArb(fork, p1nch.arb, p1nch.arbAbi, p1nch.errorAbi, searcher, sources, { ...ARB, maxPt });
    if (plan.ptAmount === 0n) {
      stopReason = plan.reason;
      flushIdle();
      console.log(`#${block} arb #${round}  SKIP    no trade sent`);
      console.log(`         why: ${plan.reason} (${plan.evals} sims, ${plan.ms} ms)`);
      return false;
    }

    const spotBefore = (await readPendleSnapshot(fork, MARKET, block)).ptSpotPrice;
    const searcherPtBefore = await balanceOf(fork, PT, searcher);
    const receipt = await sendAs(
      fork,
      searcher,
      { to: p1nch.arb, data: arbCalldata(p1nch.arbAbi, sources, plan.ptAmount, ARB.minProfitPt, searcher) },
      { gas: 15_000_000n, timestamp: ts }
    );
    block = receipt.blockNumber;
    lastTs = ts;
    if (receipt.status !== "success") {
      flushIdle();
      console.log(`#${block} arb #${round}  REVERTED   simulated ${fmt(plan.ptAmount, 6)} PT, but the transaction failed on-chain`);
      arbs.push({ after, round, block: block.toString(), status: "reverted", ptAmount: plan.ptAmount.toString() });
      return false;
    }

    const balancesAfter = await Promise.all(lps.map((lp) => aquaSyBalance(fork, lp)));
    const syPaid = sources.reduce((s, x, i) => s + x.balanceSy - balancesAfter[i]!, 0n);
    const profitPt = (await balanceOf(fork, PT, searcher)) - searcherPtBefore;
    const spotAfter = (await readPendleSnapshot(fork, MARKET, block)).ptSpotPrice;
    const bid = await p1nchBid(fork, p1nch.quoter, p1nch.quoterAbi, lps[0]!, balancesAfter[0]!);
    const paidUsdPerPt = Number(syPaid * rate) / 1e18 / 1e6 / (Number(plan.ptAmount) / 1e6);

    flushIdle();
    console.log(`#${block} arb #${round}  BUY     ${fmt(syPaid, 18)} SY -> ${fmt(plan.ptAmount, 6)} PT @ ${paidUsdPerPt.toFixed(4)}/PT (searcher +${fmt(profitPt, 6)} PT)`);
    console.log(
      `         why: quoter's bid ${bid ? bid.bid.toFixed(4) : "n/a"} clears the ${fmt(ARB.minProfitPt, 6)} PT profit floor; ` +
        `spot ${spotBefore.toFixed(4)} -> ${spotAfter.toFixed(4)} (${plan.evals} sims, ${plan.ms} ms, gas ${receipt.gasUsed.toLocaleString()})`
    );
    arbs.push({
      after,
      round,
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
    points.push(await measurePoint(fork, `arb ${round} after ${after}`, block, positions));
    return true;
  }

  /** Mines ticks and runs a pending arb, in time order, for everything strictly before `ts`. */
  async function advanceBefore(ts: number) {
    for (;;) {
      const nextTick = lastTs + TICK_SECONDS;
      const arbTs = pending ? Math.max(pending.dueTs, lastTs + 1) : Infinity;
      if (arbTs < ts && arbTs <= nextTick) {
        await runArb(arbTs, ts);
      } else if (nextTick < ts) {
        block = await mineEmptyBlockAt(fork, nextTick);
        lastTs = nextTick;
        points.push(await measurePoint(fork, "tick", block, positions));
        noteIdleTick(block, TICK_SECONDS);
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

    const ok = receipt.status === "success";
    const label = `${role.slice(0, 5)}-${counters[role]} ${ok ? "ok" : "REV"}`;
    if (ev.role === "manipulator") pushes.push({ label, extra: !!ev.extra, status: receipt.status });
    const point = { ...(await measurePoint(fork, label, block, positions)), txHash: ev.hash, txStatus: receipt.status };
    points.push(point);

    flushIdle();
    let headline: string;
    if (!ok) {
      headline =
        role === "manipulator"
          ? `historical push ${counters.manipulator}/11 did not land`
          : role === "extra"
            ? `extra push ${counters.extra} (persistent attacker) did not land`
            : `background tx replayed for state did not land`;
    } else if (role === "manipulator") {
      headline = `historical push ${counters.manipulator}/11: spot ${lastSpot.toFixed(4)} -> ${point.ptSpotPrice.toFixed(4)}`;
    } else if (role === "extra") {
      headline = `extra push ${counters.extra} (persistent attacker): spot ${lastSpot.toFixed(4)} -> ${point.ptSpotPrice.toFixed(4)}`;
    } else {
      headline = `background tx, replayed for state only (not a P1nch decision)`;
    }
    console.log(`#${block} ${role.slice(0, 5)}-${counters[role]}  ${ok ? "OK" : "REVERTED"}   ${headline}`);
    if (ok && (role === "manipulator" || role === "extra")) lastSpot = point.ptSpotPrice;

    if ((ev.kind === "attack" || ev.kind === "pendle-trade") && receipt.status === "success" && !pending) {
      pending = { dueTs: ts + delay, after: label };
    }
  }
  // After the last event, keep going while the spend limit sends the searcher to the next block.
  const pendingArb = () => pending as { dueTs: number } | null;
  for (let retries = 0; pendingArb() && retries < MAX_SPEND_RETRIES; retries++) {
    await runArb(Math.max(pendingArb()!.dueTs, lastTs + 1), Infinity);
  }

  for (let k = 0; k < POST_TICKS; k++) {
    lastTs += TICK_SECONDS;
    block = await mineEmptyBlockAt(fork, lastTs);
    points.push(await measurePoint(fork, "post-tick", block, positions));
    noteIdleTick(block, TICK_SECONDS);
  }
  flushIdle("settling period after the replay, no more scheduled events");

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
    pushesAnswered: new Set(arbs.filter((a) => a.status === "success").map((a) => a.after)).size,
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
  console.log(`  P1nch: ${summary.arbs} fills after ${summary.pushesAnswered} trades, ${fmt(syUsed, 18)} of ${fmt(config.capitalSy, 18)} SY used (${(summary.usedShare * 100).toFixed(1)}%), ${pt.toLocaleString(undefined, { maximumFractionDigits: 0 })} PT bought`);
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

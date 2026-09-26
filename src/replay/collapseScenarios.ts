/**
 * Genuine collapse (spec 7.6 step 6): Levee must not buy when the price drop is real news.
 * Each case starts from the fork block with the demo strategy (5M SY, discount 10 to 30 bp):
 *
 *   control  the attack's first 7 pushes, nothing else wrong: Levee buys (arb goes through)
 *   run      reUSD dumped on the real Curve reUSD/USDC pool until it trades >1% under NAV, the
 *            exchange rate unchanged, then the same pushes: Levee refuses (UnderlyingDepegged)
 *   loss     reUSD's NAV oracle reports 5% less, then the same pushes: Levee refuses
 *            (SyBelowFloor). Harness edit: the oracle's stored rate is scaled, as if its updater
 *            had posted a loss; there is no public path to do that on a fork.
 *   jump     Pendle falls more than 4.5% below fair before any arb reacts (large pushes in a row):
 *            Levee refuses (SpotTooFarBelowFair)
 *
 * In every case a zero-capital searcher then looks for the arb, exactly as in scenarioMaker.
 *
 *   npm run scenario:collapse      (anvil forked at block 25829822 on :8545, forge build done)
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { encodeFunctionData, parseAbi, maxUint256, getAddress } from "viem";
import { fork } from "../chain/client.js";
import { freshFork } from "./scenarioMaker.js";
import { attackInput } from "./attacker.js";
import { dealErc20AtSlot } from "./dealErc20.js";
import { dealAnyErc20, scaleValueBehind } from "./stateCheats.js";
import { planArb, arbCalldata } from "../strategies/searcher.js";
import { readPendleSnapshot } from "../snapshot/pendle.js";
import { ptPriceFromYield } from "../pricing/fairValue.js";
import {
  deployLevee,
  shipLevee,
  walletFor,
  sendAs,
  aquaSyBalance,
  balanceOf,
  syExchangeRate,
  erc20Abi,
  SY_BALANCE_SLOT,
  PENDLE_ROUTER,
  CURVE_REUSD,
  MARKET,
  SY,
  type LeveeLp,
} from "../aqua/forkLevee.js";
import addresses from "../../config/addresses.json" with { type: "json" };

type Hex = `0x${string}`;

const CAPITAL = 5_000_000n * 10n ** 18n;
const DISCOUNT_MAX_BPS = 30;
const PUSHES = 7; // the attack's first 7 trades take spot from 0.971 to ~0.959
const REF_YIELD = 0.10583;
const REUSD = getAddress(addresses.pendle.underlying) as Hex;
const ARB = { probePt: 1_000n * 10n ** 6n, minProfitPt: 50n * 10n ** 6n, tolPt: 100n * 10n ** 6n };

const curveAbi = parseAbi([
  "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
  "function price_oracle(uint256) view returns (uint256)",
  "function last_price(uint256) view returns (uint256)",
]);
const tokenAbi = parseAbi(["function decimals() view returns (uint8)"]);
const syAbi = parseAbi(["function exchangeRate() view returns (uint256)"]);

const plan: any[] = JSON.parse(readFileSync("fixtures/replay-plan.json", "utf8"));
const manipulatorTxs = plan.filter((e) => e.role === "manipulator");
const manipulator = manipulatorTxs[0].from as Hex;

type Ctx = Awaited<ReturnType<typeof setup>>;

async function setup() {
  await freshFork();
  const levee = await deployLevee(fork, walletFor("levee-deployer"));
  const rate = await syExchangeRate(fork);
  const lp = await shipLevee(fork, levee.quoter, walletFor("levee-lp-0"), CAPITAL, (rate * 99n) / 100n, { discountMaxBps: DISCOUNT_MAX_BPS });
  return { levee, lp, searcher: walletFor("levee-searcher") };
}

async function spotAndFair() {
  const block = await fork.getBlockNumber({ cacheTime: 0 });
  const snap = await readPendleSnapshot(fork, MARKET, block);
  return { spot: snap.ptSpotPrice, fair: ptPriceFromYield(REF_YIELD, snap.tau) };
}

/** Replays manipulator trades with adaptive calldata (same SY per trade, fresh bounds). */
async function push(count: number, syIn?: bigint) {
  for (let i = 0; i < count; i++) {
    const ev = syIn === undefined ? manipulatorTxs[i] : manipulatorTxs[manipulatorTxs.length - 1];
    const r = await sendAs(fork, manipulator, { to: ev.to, data: attackInput(ev.input, "adaptive", syIn) }, { gas: 3_000_000n });
    if (r.status !== "success") throw new Error(`push ${i + 1} reverted`);
  }
}

/** The searcher's view: arb if it pays, otherwise the reason (Levee's error when it refuses). */
async function leveeResponds(ctx: Ctx) {
  const balanceSy = await aquaSyBalance(fork, ctx.lp);
  const sources = [{ order: ctx.lp.order, balanceSy }];
  const maxPt = (balanceSy * (await syExchangeRate(fork)) * 10n) / 10n ** 18n / 9n;
  const plan = await planArb(fork, ctx.levee.arb, ctx.levee.arbAbi, ctx.levee.errorAbi, ctx.searcher, sources, { ...ARB, maxPt });
  if (plan.ptAmount > 0n) {
    const r = await sendAs(fork, ctx.searcher, { to: ctx.levee.arb, data: arbCalldata(ctx.levee.arbAbi, sources, plan.ptAmount, ARB.minProfitPt, ctx.searcher) }, { gas: 15_000_000n });
    if (r.status !== "success") return { bought: false, reason: "arb reverted on execution", syUsed: 0, ptAmount: 0 };
  }
  const used = CAPITAL - (await aquaSyBalance(fork, ctx.lp));
  return { bought: used > 0n, reason: plan.reason, syUsed: Number(used) / 1e18, ptAmount: Number(plan.ptAmount) / 1e6 };
}

async function marketToNav(ctx: Ctx, lp: LeveeLp) {
  return Number((await fork.readContract({ address: ctx.levee.quoter, abi: ctx.levee.quoterAbi, functionName: "marketToNav", args: [lp.params] })) as bigint) / 1e18;
}

async function control() {
  const ctx = await setup();
  await push(PUSHES);
  return { case: "control", ...(await spotAndFair()), ...(await leveeResponds(ctx)) };
}

async function reusdRun() {
  const ctx = await setup();
  const runner = walletFor("reusd-runner");
  const decimals = await fork.readContract({ address: REUSD, abi: tokenAbi, functionName: "decimals" });
  const unit = 10n ** BigInt(decimals);
  let funding = "storage deal";
  if (!(await dealAnyErc20(fork, REUSD, runner, 1_000_000n * unit))) {
    // Fallback: take it from the SY contract, which holds ~145M reUSD. Its exchange rate comes
    // from the NAV oracle, not its balance, so this does not move the rate Levee checks.
    const r = await sendAs(fork, SY, { to: REUSD, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [runner, 1_000_000n * unit] }) });
    if (r.status !== "success") throw new Error("could not fund reUSD");
    funding = "transfer from the SY contract";
  }
  await sendAs(fork, runner, { to: REUSD, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [CURVE_REUSD, maxUint256] }) });

  // Sell reUSD for USDC on Curve in 20k chunks until it trades more than 1% under NAV.
  let sold = 0n;
  let ratio = await marketToNav(ctx, ctx.lp);
  while (ratio >= 0.99 && sold < 600_000n * unit) {
    const r = await sendAs(fork, runner, { to: CURVE_REUSD, data: encodeFunctionData({ abi: curveAbi, functionName: "exchange", args: [0n, 1n, 20_000n * unit, 0n] }) });
    if (r.status !== "success") throw new Error("Curve exchange reverted");
    sold += 20_000n * unit;
    ratio = await marketToNav(ctx, ctx.lp);
  }
  const ema = Number(await fork.readContract({ address: CURVE_REUSD, abi: curveAbi, functionName: "price_oracle", args: [0n] })) / 1e18;
  const last = Number(await fork.readContract({ address: CURVE_REUSD, abi: curveAbi, functionName: "last_price", args: [0n] })) / 1e18;
  const rateUnchanged = (await syExchangeRate(fork)).toString();

  await push(PUSHES);
  return {
    case: "run",
    reusdFunding: funding,
    reusdSoldOnCurve: Number(sold / unit),
    marketToNav: ratio,
    curveEmaMarketToNav: 1 / ema,
    curveLastMarketToNav: 1 / last,
    syRate: rateUnchanged,
    ...(await spotAndFair()),
    ...(await leveeResponds(ctx)),
  };
}

async function reportedLoss() {
  const ctx = await setup();
  const before = await syExchangeRate(fork);
  const call = { to: SY, data: encodeFunctionData({ abi: syAbi, functionName: "exchangeRate" }) };
  const slot = await scaleValueBehind(fork, call, () => syExchangeRate(fork), 95n, 100n);
  if (!slot) throw new Error("could not find the stored rate behind SY.exchangeRate()");
  const after = await syExchangeRate(fork);
  await push(PUSHES);
  return {
    case: "loss",
    editedContract: slot.address,
    syRateBefore: before.toString(),
    syRateAfter: after.toString(),
    ...(await spotAndFair()),
    ...(await leveeResponds(ctx)),
  };
}

async function priceJump() {
  const ctx = await setup();
  const held = await balanceOf(fork, SY, manipulator);
  await dealErc20AtSlot(fork, SY, manipulator, held + 5_000_000n * 10n ** 18n, SY_BALANCE_SLOT);
  await sendAs(fork, manipulator, { to: SY, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PENDLE_ROUTER, maxUint256] }) });

  // Push in 250k SY trades, with no arb in between, until spot is 5% below fair.
  let pushes = 0;
  let { spot, fair } = await spotAndFair();
  while (spot > fair * 0.95 && pushes < 20) {
    await push(1, 250_000n * 10n ** 18n);
    pushes++;
    ({ spot, fair } = await spotAndFair());
  }
  return { case: "jump", pushes, syPushed: pushes * 250_000, deviationBps: ((fair - spot) / fair) * 10_000, spot, fair, ...(await leveeResponds(ctx)) };
}

async function main() {
  const results: any[] = [];
  for (const run of [control, reusdRun, reportedLoss, priceJump]) {
    const started = Date.now();
    const r: any = await run(); // one shape per case, printed below
    results.push(r);
    console.log(
      `${r.case.padEnd(8)} spot ${r.spot.toFixed(4)} (fair ${r.fair.toFixed(4)}) -> Levee ${r.bought ? `BOUGHT ${r.ptAmount.toLocaleString()} PT (${r.syUsed.toLocaleString()} SY)` : `refused: ${r.reason}`}` +
        `  [${((Date.now() - started) / 1000).toFixed(0)} s]`
    );
    if (r.case === "run") console.log(`         ${r.reusdSoldOnCurve.toLocaleString()} reUSD sold on Curve: market/NAV ${r.curveLastMarketToNav.toFixed(4)} last, ${r.curveEmaMarketToNav.toFixed(4)} EMA; SY rate unchanged at ${r.syRate}`);
    if (r.case === "loss") console.log(`         SY rate ${r.syRateBefore} -> ${r.syRateAfter} (stored rate edited in ${r.editedContract})`);
    if (r.case === "jump") console.log(`         ${r.syPushed.toLocaleString()} SY pushed with no arb in between: ${r.deviationBps.toFixed(0)} bp below fair`);
  }

  const expected = { control: true, run: false, loss: false, jump: false } as Record<string, boolean>;
  const ok = results.every((r) => r.bought === expected[r.case]);
  mkdirSync("results", { recursive: true });
  writeFileSync("results/collapse-scenarios.json", JSON.stringify(results, null, 2));
  console.log(ok ? "\nAll four cases behaved as designed." : "\nUNEXPECTED: a case did not behave as designed.");
  if (!ok) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAILED:", e);
    process.exit(1);
  });

/**
 * Genuine collapse (spec 7.6 step 6): Wamia must not buy when the price drop is real news.
 * Each case starts from the fork block with the demo strategy (5M SY, discount 10 to 30 bp):
 *
 *   control  the attack's first 7 pushes, nothing else wrong: Wamia buys (arb goes through)
 *   switchoff an attacker dumps reUSD on the real Curve pool until the last price is >1% under NAV,
 *            then pushes at once: Wamia must keep buying (its depeg stop reads the EMA, which one
 *            dump barely moves), so the attacker cannot switch the backstop off cheaply
 *   run      a genuine run: reUSD dumped to 2% under NAV and left there, minutes pass until the
 *            pool's EMA is >1% under NAV, exchange rate unchanged, then the same pushes: Wamia
 *            refuses (UnderlyingDepegged)
 *   loss     reUSD's NAV oracle reports 5% less, then the same pushes: Wamia refuses
 *            (SyBelowFloor). Harness edit: the oracle's stored rate is scaled, as if its updater
 *            had posted a loss; there is no public path to do that on a fork.
 *   jump     Pendle more than 4.5% below fair before any arb reacts: Wamia refuses
 *            (SpotTooFarBelowFair). First the attacker's trade is pushed in 50k SY steps with no arb in
 *            between, to find how far trades alone can move Pendle (its pool stops accepting them
 *            around 2.6% below fair). Since that is short of 4.5%, the market's stored implied rate
 *            is then edited to 6% below fair, as if Pendle had repriced on news (harness edit).
 *
 * In every case a zero-capital searcher then looks for the arb, exactly as in scenarioMaker.
 *
 *   npm run scenario:collapse               all five (anvil forked at block 25829822 on :8545, forge build done)
 *   npm run scenario:collapse -- jump       one case (results file is written only for a full run)
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { encodeFunctionData, parseAbi, maxUint256, getAddress } from "viem";
import { fork } from "../chain/client.js";
import { freshFork } from "./scenarioMaker.js";
import { attackInput } from "./attacker.js";
import { dealErc20AtSlot } from "./dealErc20.js";
import { dealAnyErc20, scaleValueBehind, setPackedFieldBehind } from "./stateCheats.js";
import { planArb, arbCalldata } from "../strategies/searcher.js";
import { readPendleSnapshot } from "../snapshot/pendle.js";
import { mineEmptyBlockAt } from "./actions.js";
import { ptPriceFromYield } from "../pricing/fairValue.js";
import {
  deployWamia,
  shipWamia,
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
  type WamiaLp,
} from "../aqua/forkWamia.js";
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
const marketAbi = parseAbi(["function _storage() view returns (int128,int128,uint96,uint16,uint16,uint16)"]);

const plan: any[] = JSON.parse(readFileSync("fixtures/replay-plan.json", "utf8"));
const manipulatorTxs = plan.filter((e) => e.role === "manipulator");
const manipulator = manipulatorTxs[0].from as Hex;

type Ctx = Awaited<ReturnType<typeof setup>>;

async function setup() {
  await freshFork();
  const wamia = await deployWamia(fork, walletFor("wamia-deployer"));
  const rate = await syExchangeRate(fork);
  const lp = await shipWamia(fork, wamia.quoter, walletFor("wamia-lp-0"), CAPITAL, (rate * 99n) / 100n, { discountMaxBps: DISCOUNT_MAX_BPS });
  return { wamia, lp, searcher: walletFor("wamia-searcher") };
}

async function spotAndFair() {
  const block = await fork.getBlockNumber({ cacheTime: 0 });
  const snap = await readPendleSnapshot(fork, MARKET, block);
  return { spot: snap.ptSpotPrice, fair: ptPriceFromYield(REF_YIELD, snap.tau) };
}

/** One manipulator trade with adaptive calldata (same SY per trade, fresh bounds); false if it reverts. */
async function tryPush(ev: any, syIn?: bigint): Promise<boolean> {
  const r = await sendAs(fork, manipulator, { to: ev.to, data: attackInput(ev.input, "adaptive", syIn) }, { gas: 3_000_000n });
  return r.status === "success";
}

/** The attack's first `count` trades. */
async function push(count: number) {
  for (let i = 0; i < count; i++) if (!(await tryPush(manipulatorTxs[i]))) throw new Error(`push ${i + 1} reverted`);
}

/** The searcher's view: arb if it pays, otherwise the reason (Wamia's error when it refuses). */
async function wamiaResponds(ctx: Ctx) {
  const balanceSy = await aquaSyBalance(fork, ctx.lp);
  const sources = [{ order: ctx.lp.order, balanceSy }];
  const maxPt = (balanceSy * (await syExchangeRate(fork)) * 10n) / 10n ** 18n / 9n;
  const plan = await planArb(fork, ctx.wamia.arb, ctx.wamia.arbAbi, ctx.wamia.errorAbi, ctx.searcher, sources, { ...ARB, maxPt });
  if (plan.ptAmount > 0n) {
    const r = await sendAs(fork, ctx.searcher, { to: ctx.wamia.arb, data: arbCalldata(ctx.wamia.arbAbi, sources, plan.ptAmount, ARB.minProfitPt, ctx.searcher) }, { gas: 15_000_000n });
    if (r.status !== "success") return { bought: false, reason: "arb reverted on execution", syUsed: 0, ptAmount: 0 };
  }
  const used = CAPITAL - (await aquaSyBalance(fork, ctx.lp));
  return { bought: used > 0n, reason: plan.reason, syUsed: Number(used) / 1e18, ptAmount: Number(plan.ptAmount) / 1e6 };
}

async function marketToNav(ctx: Ctx, lp: WamiaLp) {
  return Number((await fork.readContract({ address: ctx.wamia.quoter, abi: ctx.wamia.quoterAbi, functionName: "marketToNav", args: [lp.params] })) as bigint) / 1e18;
}

async function control() {
  const ctx = await setup();
  await push(PUSHES);
  return { case: "control", ...(await spotAndFair()), ...(await wamiaResponds(ctx)) };
}

/** reUSD market price over NAV on Curve (coins[0] = reUSD), by the EMA and by the last trade. */
async function curveMarketToNav() {
  const ema = Number(await fork.readContract({ address: CURVE_REUSD, abi: curveAbi, functionName: "price_oracle", args: [0n] })) / 1e18;
  const last = Number(await fork.readContract({ address: CURVE_REUSD, abi: curveAbi, functionName: "last_price", args: [0n] })) / 1e18;
  return { ema: 1 / ema, last: 1 / last };
}

/** Funds a wallet with 1M reUSD and sells it on Curve in 20k chunks until the last price is below `target`. */
async function dumpReusd(target: number) {
  const runner = walletFor("reusd-runner");
  const decimals = await fork.readContract({ address: REUSD, abi: tokenAbi, functionName: "decimals" });
  const unit = 10n ** BigInt(decimals);
  let funding = "storage deal";
  if (!(await dealAnyErc20(fork, REUSD, runner, 1_000_000n * unit))) {
    // Fallback: take it from the SY contract, which holds ~145M reUSD. Its exchange rate comes
    // from the NAV oracle, not its balance, so this does not move the rate Wamia checks.
    const r = await sendAs(fork, SY, { to: REUSD, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [runner, 1_000_000n * unit] }) });
    if (r.status !== "success") throw new Error("could not fund reUSD");
    funding = "transfer from the SY contract";
  }
  await sendAs(fork, runner, { to: REUSD, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [CURVE_REUSD, maxUint256] }) });
  let sold = 0n;
  while ((await curveMarketToNav()).last >= target && sold < 900_000n * unit) {
    const r = await sendAs(fork, runner, { to: CURVE_REUSD, data: encodeFunctionData({ abi: curveAbi, functionName: "exchange", args: [0n, 1n, 20_000n * unit, 0n] }) });
    if (r.status !== "success") throw new Error("Curve exchange reverted");
    sold += 20_000n * unit;
  }
  return { reusdFunding: funding, reusdSoldOnCurve: Number(sold / unit) };
}

async function switchOff() {
  const ctx = await setup();
  const dump = await dumpReusd(0.99);
  const curve = await curveMarketToNav();
  await push(PUSHES); // right away, same minute
  return { case: "switchoff", ...dump, curveEmaMarketToNav: curve.ema, curveLastMarketToNav: curve.last, ...(await spotAndFair()), ...(await wamiaResponds(ctx)) };
}

async function reusdRun() {
  const ctx = await setup();
  const dump = await dumpReusd(0.98);
  // Nobody buys the discount back: minutes pass (one block a minute) until the EMA is >1% under NAV.
  let minutes = 0;
  let ratio = await marketToNav(ctx, ctx.lp);
  while (ratio >= 0.99 && minutes < 120) {
    const block = await fork.getBlock({ blockTag: "latest" });
    await mineEmptyBlockAt(fork, Number(block.timestamp) + 60);
    minutes++;
    ratio = await marketToNav(ctx, ctx.lp);
  }
  const curve = await curveMarketToNav();
  const rateUnchanged = (await syExchangeRate(fork)).toString();
  await push(PUSHES);
  return {
    case: "run",
    ...dump,
    minutesHeld: minutes,
    curveEmaMarketToNav: curve.ema,
    curveLastMarketToNav: curve.last,
    syRate: rateUnchanged,
    ...(await spotAndFair()),
    ...(await wamiaResponds(ctx)),
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
    ...(await wamiaResponds(ctx)),
  };
}

async function priceJump() {
  const ctx = await setup();
  const held = await balanceOf(fork, SY, manipulator);
  await dealErc20AtSlot(fork, SY, manipulator, held + 5_000_000n * 10n ** 18n, SY_BALANCE_SLOT);
  await sendAs(fork, manipulator, { to: SY, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PENDLE_ROUTER, maxUint256] }) });

  // 1. Trades alone: 50k SY pushes with no arb in between, until 5% below fair or Pendle refuses.
  const template = manipulatorTxs[manipulatorTxs.length - 1];
  let pushes = 0;
  let stoppedBy = "reached 5% below fair";
  let { spot, fair } = await spotAndFair();
  while (spot > fair * 0.95) {
    if (pushes >= 40 || !(await tryPush(template, 50_000n * 10n ** 18n))) {
      stoppedBy = pushes >= 40 ? "40 pushes" : "Pendle rejected the next push";
      break;
    }
    pushes++;
    ({ spot, fair } = await spotAndFair());
  }
  const tradesFloorSpot = spot;
  const tradesFloorBps = ((fair - spot) / fair) * 10_000;

  // 2. If trades cannot open a gap beyond the 4.5% stop, reprice the market as if on news (harness edit).
  let marketRateEdited = false;
  if (spot > fair * (1 - 0.045)) {
    const block = await fork.getBlockNumber({ cacheTime: 0 });
    const { tau } = await readPendleSnapshot(fork, MARKET, block);
    const lnRate = BigInt(Math.round((-Math.log(fair * 0.94) / tau) * 1e18)); // spot = fair * 0.94
    const read = async () => (await fork.readContract({ address: MARKET, abi: marketAbi, functionName: "_storage" }))[2];
    const call = { to: MARKET, data: encodeFunctionData({ abi: marketAbi, functionName: "_storage" }) };
    if (!(await setPackedFieldBehind(fork, call, read, lnRate, 96))) throw new Error("could not find the market's stored implied rate");
    marketRateEdited = true;
    ({ spot, fair } = await spotAndFair());
  }
  return {
    case: "jump",
    pushes,
    syPushed: pushes * 50_000,
    stoppedBy,
    tradesFloorSpot,
    tradesFloorBps,
    marketRateEdited,
    deviationBps: ((fair - spot) / fair) * 10_000,
    spot,
    fair,
    ...(await wamiaResponds(ctx)),
  };
}

async function main() {
  // `npm run scenario:collapse -- jump` runs only the named case(s): control, switchoff, run, loss, jump.
  const cases = { control, switchoff: switchOff, run: reusdRun, loss: reportedLoss, jump: priceJump } as const;
  const only = process.argv.slice(2);
  const selected = Object.entries(cases).filter(([name]) => only.length === 0 || only.includes(name)).map(([, fn]) => fn);
  const results: any[] = [];
  for (const run of selected) {
    const started = Date.now();
    const r: any = await run(); // one shape per case, printed below
    results.push(r);
    console.log(
      `${r.case.padEnd(8)} spot ${r.spot.toFixed(4)} (fair ${r.fair.toFixed(4)}) -> Wamia ${r.bought ? `BOUGHT ${r.ptAmount.toLocaleString()} PT (${r.syUsed.toLocaleString()} SY)` : `refused: ${r.reason}`}` +
        `  [${((Date.now() - started) / 1000).toFixed(0)} s]`
    );
    if (r.case === "switchoff") console.log(`         ${r.reusdSoldOnCurve.toLocaleString()} reUSD dumped on Curve in one go: market/NAV ${r.curveLastMarketToNav.toFixed(4)} last, ${r.curveEmaMarketToNav.toFixed(4)} EMA (stop reads the EMA)`);
    if (r.case === "run") console.log(`         ${r.reusdSoldOnCurve.toLocaleString()} reUSD sold on Curve, held ${r.minutesHeld} min: market/NAV ${r.curveLastMarketToNav.toFixed(4)} last, ${r.curveEmaMarketToNav.toFixed(4)} EMA; SY rate unchanged at ${r.syRate}`);
    if (r.case === "loss") console.log(`         SY rate ${r.syRateBefore} -> ${r.syRateAfter} (stored rate edited in ${r.editedContract})`);
    if (r.case === "jump") {
      console.log(`         trades alone: ${r.syPushed.toLocaleString()} SY pushed with no arb, ${r.stoppedBy}, lowest spot ${r.tradesFloorSpot.toFixed(4)} (${r.tradesFloorBps.toFixed(0)} bp below fair)`);
      if (r.marketRateEdited) console.log(`         then the market's implied rate was edited (news repricing): ${r.deviationBps.toFixed(0)} bp below fair`);
    }
  }

  const expected = { control: true, switchoff: true, run: false, loss: false, jump: false } as Record<string, boolean>;
  const ok = results.every((r) => r.bought === expected[r.case]);
  mkdirSync("results", { recursive: true });
  if (only.length === 0) writeFileSync("results/collapse-scenarios.json", JSON.stringify(results, null, 2));
  console.log(ok ? `\nAll ${results.length} case(s) behaved as designed.` : "\nUNEXPECTED: a case did not behave as designed.");
  if (!ok) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAILED:", e);
    process.exit(1);
  });

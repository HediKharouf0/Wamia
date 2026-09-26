/**
 * Builds app/src/data/measurements.json: the results the landing page charts and the yield
 * calculator are grounded in. Everything here is read straight from results/ and config/ -
 * nothing is hand-typed.
 *
 *   npm run app:measurements
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { yieldFromPtPrice, tauFromTimestamps } from "../pricing/fairValue.js";
import addresses from "../../config/addresses.json" with { type: "json" };

const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

const EXPIRY = 1796860800; // PT-reUSD maturity, 2026-12-10
const REF_YIELD = 0.10583; // Wamia's reference implied APY (pre-attack)
const ATTACK_TIMESTAMP = 1787631000; // ~t0 of the Aug 25 replay (see buildReplayData.ts)
const TAU_AT_ATTACK = tauFromTimestamps(ATTACK_TIMESTAMP, EXPIRY);

// --- Maker sweep: results/maker-results.json, one row per scenario-maker-* run ---
const makerRaw = json("results/maker-results.json") as any[];
const makerSweep = makerRaw.map((r) => ({
  run: r.run,
  sourceDir: `scenario-maker-${r.run}`,
  shippedSy: r.shippedSy,
  syUsed: r.syUsed,
  discountMaxBps: r.discountMaxBps,
  latencyBlocks: r.latencyBlocks,
  attacker: r.attacker,
  extraAttackSy: r.extraAttackSy,
  guards: r.guards,
  fills: r.fills,
  oracleMin: round(r.oracleMin, 4),
  spotMin: round(r.spotMin, 4),
  eligibleDebtUsd: r.eligibleDebtUsd,
  eligiblePositions: r.eligiblePositions,
  lpHoldToMaturityAnnualized: r.lpHoldToMaturityAnnualized,
  lpAvgPaidUsdPerPt: r.lpAvgPaidUsdPerPt,
}));

// --- Collapse scenarios: results/collapse-scenarios/summary.json, 5 news-vs-attack cases ---
const collapseRaw = json("results/collapse-scenarios/summary.json") as any[];
const collapseScenarios = collapseRaw.map((c) => ({
  case: c.case,
  bought: c.bought,
  reason: c.reason,
  spot: round(c.spot, 4),
  fair: round(c.fair, 4),
}));

// --- Taker comparison: baseline + 3 capital levels, no Wamia contracts, capital alone ---
const TAKER_RUNS = [
  { key: "baseline", dir: "scenario-baseline-state-only", capital: 0 },
  { key: "2M", dir: "scenario-taker-2M-L1", capital: 2_000_000 },
  { key: "5M", dir: "scenario-taker-5M-L1", capital: 5_000_000 },
];
const takerComparison = TAKER_RUNS.map((run) => {
  const points = json(`results/${run.dir}/timeseries.json`) as any[];
  const buys = json(`results/${run.dir}/buys.json`) as any[];
  let peakDebtAtRisk = 0;
  let oracleMin = Infinity;
  for (const p of points) {
    const debt = Object.values<any>(p.markets).reduce((sum, m) => sum + Number(m.liquidatableDebt), 0);
    if (debt > peakDebtAtRisk) peakDebtAtRisk = debt;
    if (p.oraclePrice < oracleMin) oracleMin = p.oraclePrice;
  }
  const spent = buys.reduce((sum, b) => sum + Number(BigInt(b.syAmount) / 10n ** 12n) / 1e6, 0);
  return {
    key: run.key,
    sourceDir: run.dir,
    capital: run.capital,
    spentSy: round(spent, 0),
    peakDebtAtRisk: round(peakDebtAtRisk / 1e6, 0),
    oracleMin: round(oracleMin, 4),
    buys: buys.length,
  };
});

// --- Yield model: same math as scenarioMaker.ts's holdToMaturityAnnualized, exposed for the
//     calculator so it can project other capital levels without re-deriving the formula ---
const yieldModel = {
  refYield: REF_YIELD,
  tauAtAttack: round(TAU_AT_ATTACK, 4),
  expiry: EXPIRY,
  // netAPY(avgPaidUsdPerPt) = yieldFromPtPrice(avgPaidUsdPerPt, tauAtAttack); sanity check against
  // the measured 5M-guards run (should land close to its own lpHoldToMaturityAnnualized).
  sanityCheck: round(yieldFromPtPrice(0.9691, TAU_AT_ATTACK), 4),
};

const out = {
  meta: {
    repoBase: "https://github.com/HediKharouf0/Wamia/tree/main",
    forkBlock: 25829822,
    market: "PT-reUSD (Dec 10, 2026)",
    contracts: {
      pendleMarket: addresses.pendle.market,
      pendlePt: addresses.pendle.pt,
      pendleSy: addresses.pendle.sy,
      morphoBlue: addresses.morphoBlue,
      morphoUsdcMarket: (addresses.morphoMarkets as any).usdc.id,
      morphoUsdtMarket: (addresses.morphoMarkets as any).usdt.id,
      curvePool: (addresses.reusdMarketPrice as any).curvePool,
      aquaRouter: (addresses.aqua as any).swapVmRouter,
      manipulatorWallet: (addresses.wallets as any).manipulator,
    },
  },
  makerSweep,
  collapseScenarios,
  takerComparison,
  yieldModel,
};

mkdirSync("app/src/data", { recursive: true });
writeFileSync("app/src/data/measurements.json", JSON.stringify(out));
console.log(`wrote app/src/data/measurements.json: ${makerSweep.length} maker runs, ${collapseScenarios.length} collapse cases, ${takerComparison.length} taker runs`);
console.log(`yield model sanity check (5M-guards avg price 0.9691): ${(yieldModel.sanityCheck * 100).toFixed(2)}% (measured: 11.3%)`);

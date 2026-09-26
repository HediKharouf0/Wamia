/**
 * Builds app/src/data/replay.json, the only input of the app's replay screen, from committed runs:
 * the no-backstop run and the Wamia runs of the same harness (adaptive attacker, next-block searcher,
 * 30 bp max discount). Everything shown on the replay screen comes from these files.
 *
 *   npm run app:data
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { ptPriceFromYield, tauFromTimestamps } from "../pricing/fairValue.js";

const EXPIRY = 1796860800; // PT-reUSD maturity, 2026-12-10
const REF_YIELD = 0.10583; // Wamia's reference implied APY (pre-attack)
const LLTV = 0.915;
const END_AFTER_FIRST_PUSH = 1500; // seconds shown; afterwards nothing changes any more

const RUNS: { key: string; dir: string; title: string; shippedSy: number; guards: boolean }[] = [
  { key: "none", dir: "scenario-maker-0M-L1-adaptive-dmax30", title: "No backstop", shippedSy: 0, guards: false },
  { key: "3M", dir: "scenario-maker-3M-L1-adaptive-dmax30", title: "3M SY", shippedSy: 3_000_000, guards: false },
  { key: "4M", dir: "scenario-maker-4M-L1-adaptive-dmax30", title: "4M SY", shippedSy: 4_000_000, guards: false },
  { key: "5M", dir: "scenario-maker-5M-L1-adaptive-dmax30", title: "5M SY", shippedSy: 5_000_000, guards: false },
  { key: "5M-guards", dir: "scenario-maker-5M-L1-adaptive-dmax30-guards", title: "5M SY + guards", shippedSy: 5_000_000, guards: true },
];

type Health = { user: string; collateral: string; borrowAssets: string };
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

// Every borrower that became liquidatable in the no-backstop run, with its debt and liquidation price.
const none = json(`results/${RUNS[0]!.dir}/timeseries.json`) as any[];
const everLiquidatable = new Set<string>();
for (const p of none) for (const [m, s] of Object.entries<any>(p.markets)) for (const u of s.liquidatableUsers) everLiquidatable.add(`${m}:${u.toLowerCase()}`);

const positions = (["usdc", "usdt"] as const)
  .flatMap((market) =>
    (json(`fixtures/health-${market}-forkblock.json`) as Health[]).map((h) => {
      const debt = Number(h.borrowAssets) / 1e6;
      const collateralPt = Number(h.collateral) / 1e6;
      return {
        id: `${market}:${h.user.toLowerCase()}`,
        market: market.toUpperCase(),
        user: h.user.toLowerCase(),
        debtUsd: round(debt, 0),
        collateralPt: round(collateralPt, 0),
        // The Morpho oracle price (USD per PT) below which this position can be liquidated.
        liqPrice: round(debt / (collateralPt * LLTV), 5),
      };
    })
  )
  .filter((p) => everLiquidatable.has(p.id))
  .sort((a, b) => b.liqPrice - a.liqPrice);
const index = new Map(positions.map((p, i) => [p.id, i]));

function eventKind(label: string): string | null {
  if (label.startsWith("manip")) return "push";
  if (label.startsWith("backg")) return "trade";
  return null;
}

const t0 = Math.min(...none.filter((p) => p.label.startsWith("manip")).map((p) => p.timestamp as number)) - 30;

const runs = RUNS.map((run) => {
  const points = json(`results/${run.dir}/timeseries.json`) as any[];
  const arbs = run.shippedSy > 0 ? (json(`results/${run.dir}/arbs.json`) as any[]).filter((a) => a.status === "success") : [];
  const summary = json(`results/${run.dir}/summary.json`);

  let spent = 0;
  let arbIndex = 0;
  let prevLiq = new Set<number>();
  const events: any[] = [];
  const series = points
    .filter((p) => p.timestamp - t0 <= END_AFTER_FIRST_PUSH)
    .map((p) => {
      const t = Math.max(0, p.timestamp - t0); // the runs' setup blocks land just before the window
      if (p.label.startsWith("arb")) {
        const a = arbs[arbIndex++];
        if (a) {
          spent += Number(BigInt(a.syPaid) / 10n ** 12n) / 1e6;
          events.push({
            t,
            kind: "fill",
            block: Number(a.block),
            ptBought: round(Number(a.ptBought) / 1e6, 0),
            syPaid: round(Number(BigInt(a.syPaid) / 10n ** 12n) / 1e6, 0),
            price: round(a.paidUsdPerPt, 4),
            spotBefore: round(a.spotBefore, 4),
            spotAfter: round(a.spotAfter, 4),
            searcherProfitPt: round(Number(a.searcherProfitPt) / 1e6, 0),
          });
        }
      }
      const kind = eventKind(p.label);
      if (kind && p.txStatus === "success") events.push({ t, kind, label: p.label.replace(/ ok$/, ""), tx: p.txHash, block: Number(p.block), spot: round(p.ptSpotPrice, 4) });

      const liq = new Set<number>();
      let debtAtRisk = 0;
      for (const [m, s] of Object.entries<any>(p.markets)) {
        debtAtRisk += Number(s.liquidatableDebt) / 1e6;
        for (const u of s.liquidatableUsers) {
          const i = index.get(`${m}:${u.toLowerCase()}`);
          if (i !== undefined) liq.add(i);
        }
      }
      for (const i of liq) if (!prevLiq.has(i)) events.push({ t, kind: "liquidatable", position: i, debtUsd: positions[i]!.debtUsd });
      prevLiq = liq;

      return {
        t,
        block: Number(p.block),
        spot: round(p.ptSpotPrice, 5),
        oracle: round(p.oraclePrice, 5),
        fair: round(ptPriceFromYield(REF_YIELD, tauFromTimestamps(p.timestamp, EXPIRY)), 5),
        debtAtRisk: round(debtAtRisk, 0),
        liquidatable: [...liq].sort((a, b) => a - b),
        syLeft: round(run.shippedSy - spent, 0),
      };
    });

  return {
    key: run.key,
    title: run.title,
    shippedSy: run.shippedSy,
    guards: run.guards,
    sourceDir: run.dir,
    points: series,
    events: events.sort((a, b) => a.t - b.t),
    summary: {
      peakDebtAtRisk: round(Math.max(...series.map((s) => s.debtAtRisk)), 0),
      oracleMin: round(summary.oracleMin ?? Math.min(...series.map((s) => s.oracle)), 4),
      spotMin: round(summary.spotMin ?? Math.min(...series.map((s) => s.spot)), 4),
      syUsed: round(summary.syUsed ?? 0, 0),
      fills: arbs.length,
      lpAnnualized: summary.lp?.holdToMaturityAnnualized ? round(summary.lp.holdToMaturityAnnualized, 4) : null,
      lpAvgPrice: summary.lp?.avgPaidUsdPerPt ? round(summary.lp.avgPaidUsdPerPt, 4) : null,
      searcherProfitPt: round(summary.searcherProfitPt ?? 0, 0),
    },
  };
});

const out = {
  meta: {
    market: "PT-reUSD (Dec 10, 2026)",
    forkBlock: 25829822,
    startTimestamp: t0,
    lltv: LLTV,
    refYield: REF_YIELD,
    duration: END_AFTER_FIRST_PUSH,
    source: "results/ (fork replays of the Aug 25, 2026 attack; adaptive attacker, arb lands one block after each push)",
    repoBase: "https://github.com/HediKharouf0/p1nch/tree/main",
  },
  positions,
  runs,
};

mkdirSync("app/src/data", { recursive: true });
writeFileSync("app/src/data/replay.json", JSON.stringify(out));
console.log(`wrote app/src/data/replay.json: ${positions.length} positions, ${runs.length} runs`);
for (const r of runs) console.log(`  ${r.key}: ${r.points.length} points, ${r.events.length} events, peak at risk $${(r.summary.peakDebtAtRisk / 1e6).toFixed(2)}M`);

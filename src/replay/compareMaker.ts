/**
 * Levee capital sweep on the fork, compared with the no-backstop baseline and the taker runs.
 *
 *   npm run scenario:maker                                   # default sweep below
 *   npm run scenario:maker -- --capital 2,3 --latency 0,1    # millions of SY
 *   npm run scenario:maker -- --capital 3 --attacker historical
 *   npm run scenario:maker -- --capital 3 --extra-attack 1   # persistent attacker, +1M SY of pushes
 *   npm run scenario:maker -- --capital 3 --lps 4            # same capital across 4 LP wallets
 *   npm run scenario:maker -- --capital 5 --dmax 30          # flatter discount curve (default 60 bp)
 *
 * Capital 0 runs the same harness with no Levee strategy (the baseline for this attacker mode).
 * Needs anvil forked at block 25829822 on port 8545 and `forge build` in contracts/.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { runMakerScenario, type MakerRunConfig } from "./scenarioMaker.js";
import type { AttackerMode } from "./attacker.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const millions = (s: string) => BigInt(Math.round(Number(s) * 1e6)) * 10n ** 18n;
const usd = (x: number) => `$${(x / 1e6).toFixed(2)}M`;

/** Peak eligible debt and oracle min of an earlier taker or baseline run, from its timeseries. */
function readTakerRun(label: string) {
  const path = `results/scenario-${label}/timeseries.json`;
  if (!existsSync(path)) return null;
  const points: any[] = JSON.parse(readFileSync(path, "utf8"));
  const peak = (f: (p: any) => number) => Math.max(...points.map(f));
  const debt = peak((p) => Number(p.markets.usdc.liquidatableDebt)) / 1e6 + peak((p) => Number(p.markets.usdt.liquidatableDebt)) / 1e6;
  return { oracleMin: Math.min(...points.map((p) => p.oraclePrice)), debt };
}

async function main() {
  const capitals = arg("capital", "0,1,2,3,4,5").split(",");
  const latencies = arg("latency", "1").split(",").map(Number) as (0 | 1)[];
  const attacker = arg("attacker", "adaptive") as AttackerMode;
  const lps = Number(arg("lps", "1"));
  const extra = arg("extra-attack", "0");
  const dmax = arg("dmax", "");
  const suffix = (lps > 1 ? `-${lps}lps` : "") + (Number(extra) > 0 ? `-extra${extra}M` : "") + (dmax ? `-dmax${dmax}` : "");

  const summaries: any[] = [];
  for (const latency of latencies) {
    for (const c of capitals) {
      const label = `maker-${c}M-L${latency}-${attacker}${suffix}`;
      const config: MakerRunConfig = {
        label,
        capitalSy: millions(c),
        lps,
        latencyBlocks: latency,
        attacker,
        extraAttackSy: millions(extra),
        ...(dmax ? { discountMaxBps: Number(dmax) } : {}),
      };
      console.log(`\n=== ${label} ===`);
      const started = Date.now();
      summaries.push(await runMakerScenario(config));
      console.log(`  (run took ${((Date.now() - started) / 60000).toFixed(1)} min)`);
    }
  }

  console.log("\n\n=== Levee (maker) ===");
  console.log("run | SY used / shipped | fills | oracle min | peak eligible debt | LP hold (annualized) | manipulator ok");
  for (const s of summaries) {
    const e = s.peakEligible;
    const lp = s.lp.avgPaidUsdPerPt ? `${(s.lp.holdToMaturity * 100).toFixed(2)}% (${(s.lp.holdToMaturityAnnualized * 100).toFixed(1)}%)` : "n/a";
    console.log(
      `${s.label} | ${(s.syUsed / 1e6).toFixed(2)}M / ${(s.shippedSy / 1e6).toFixed(2)}M | ${s.arbs} | ${s.oracleMin.toFixed(4)} | ` +
        `${usd(e.usdcDebt + e.usdtDebt)} (USDC ${e.usdcCount}, USDT ${e.usdtCount}) | ${lp} | ` +
        `${s.manipulator.historicalOk}/11${s.manipulator.extraOk + s.manipulator.extraReverted > 0 ? ` +${s.manipulator.extraOk}` : ""}`
    );
  }

  console.log("\n=== Earlier runs, same harness (taker latency is +1 s per block) ===");
  for (const label of ["baseline-state-only", "taker-100k-L1", "taker-2M-L1", "taker-5M-L1"]) {
    const r = readTakerRun(label);
    if (r) console.log(`${label} | oracle min ${r.oracleMin.toFixed(4)} | peak eligible debt ${usd(r.debt)}`);
  }

  const protectedRuns = summaries.filter((s) => s.shippedSy > 0 && s.peakEligible.usdcDebt + s.peakEligible.usdtDebt === 0);
  const minimum = protectedRuns.sort((a, b) => a.shippedSy - b.shippedSy)[0];
  console.log(
    minimum
      ? `\nSmallest shipped capital with zero eligible debt: ${(minimum.shippedSy / 1e6).toFixed(2)}M SY (${minimum.label}), ` +
          `of which ${(minimum.syUsed / 1e6).toFixed(2)}M was used; LP hold to maturity ${(minimum.lp.holdToMaturityAnnualized * 100).toFixed(1)}% annualized`
      : "\nNo run in this sweep reached zero eligible debt."
  );

  const out = `results/maker-sweep-${attacker}${suffix}.json`;
  writeFileSync(out, JSON.stringify(summaries, null, 2));
  console.log(`Summaries written to ${out}`);
}

// Exit explicitly: the RPC client keeps connections open after the last request.
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAILED:", e);
    process.exit(1);
  });

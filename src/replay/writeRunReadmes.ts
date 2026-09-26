/**
 * Regenerates each maker-scenario result folder's README.md from its own summary.json, so the
 * reproduce command and the headline numbers can never drift from what the folder actually holds.
 *
 *   npm run results:readmes
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";

const usd = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const million = (raw: string) => Number(BigInt(raw) / 10n ** 18n) / 1e6; // whole-SY division first: avoids float error on values > 2^53
const fmtM = (n: number) => (n % 1 === 0 ? String(n) : n.toFixed(2));

function commandFor(cfg: any): string {
  const cap = million(cfg.capitalSy);
  const parts = [`--capital ${fmtM(cap)}`];
  if (cfg.latencyBlocks !== 1) parts.push(`--latency ${cfg.latencyBlocks}`);
  if (cfg.attacker !== "adaptive") parts.push(`--attacker ${cfg.attacker}`);
  if (cfg.lps && cfg.lps > 1) parts.push(`--lps ${cfg.lps}`);
  if (BigInt(cfg.extraAttackSy) > 0n) parts.push(`--extra-attack ${fmtM(million(cfg.extraAttackSy))}`);
  if (cfg.discountMaxBps) parts.push(`--dmax ${cfg.discountMaxBps}`);
  if (cfg.guards) parts.push("--guards");
  return `npm run scenario:maker -- ${parts.join(" ")}`;
}

function describe(cfg: any): string {
  const cap = million(cfg.capitalSy);
  const bits: string[] = [];
  bits.push(
    cap === 0
      ? "no Wamia strategy at all (the no-backstop baseline for this attacker mode)"
      : `a Wamia strategy holding ${fmtM(cap)}M SY (discount 10–${cfg.discountMaxBps ?? 60} bp)` +
        (cfg.lps > 1 ? `, split across ${cfg.lps} LP wallets` : "")
  );
  if (cap > 0) bits.push(cfg.guards ? "the v2 guards on (WamiaRateGuard + WamiaSpendLimit ahead of the quoter)" : "the v1 quoter alone, no v2 guards");
  if (cap > 0) bits.push(`a zero-capital searcher backrunning every Pendle-moving trade ${cfg.latencyBlocks === 0 ? "in the same block (latency 0)" : "one block later (latency 1)"}`);
  bits.push(
    cfg.attacker === "historical"
      ? "replaying the manipulator's exact historical calldata"
      : "replaying the attack with fresh slippage bounds each time (adaptive), same SY per trade"
  );
  if (BigInt(cfg.extraAttackSy) > 0n) bits.push(`a persistent attacker that keeps pushing ${fmtM(million(cfg.extraAttackSy))}M more SY of trades after the historical attack ends`);
  return `Replays the real Aug 25 attack on the mainnet fork (block 25829822) with ${bits.join(", ")}.`;
}

/** The one folder that also has a raw run.log gets a fixed appendix explaining it. */
function logAppendix(): string {
  const lines = [
    "",
    "## `run.log`",
    "",
    "This folder also has the complete console output of a real run (on a MacBook, against an anvil fork of",
    "mainnet at block 25829822). It predates both project renames, so it still says Levee where the code now",
    "says Wamia; left as-is, it's a historical transcript, not our prose.",
    "",
    "Reading it: `manip-N ok` is the attacker's Nth push landing; `[arb N after manip-M]` is the searcher's Nth",
    "backrun after that push (Wamia bought PT, the searcher bought it back on Pendle in the same transaction and",
    "kept the difference); `[no arb ...]` is the searcher checking and finding nothing worth doing;",
    "`[spend limit reached ...]` is WamiaSpendLimit refusing because the block's cap is used up (the searcher",
    "resumes next block). The current harness prints a clearer, block-numbered version of this same log; see",
    "`docs/MEASUREMENTS.md`.",
    "",
    "Why a multi-minute run is mostly waiting: the searcher's own decisions take about a second of it. The rest is",
    "anvil fetching mainnet storage it hasn't seen yet, one slot at a time over the network, while the harness",
    "replays 25 historical transactions and mines a tick every simulated minute. None of that applies to a real",
    "searcher next to a live node.",
    "",
  ];
  return lines.join("\n");
}

function main() {
  const dirs = readdirSync("results", { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("scenario-maker-"))
    .map((d) => d.name);

  for (const dir of dirs) {
    const summaryPath = `results/${dir}/summary.json`;
    if (!existsSync(summaryPath)) continue;
    const s = JSON.parse(readFileSync(summaryPath, "utf8"));
    const cfg = s.config;
    const e = s.peakEligible;
    const debt = e.usdcDebt + e.usdtDebt;
    const lp = s.lp.avgPaidUsdPerPt
      ? `LP paid ${s.lp.avgPaidUsdPerPt.toFixed(4)} USD/PT, hold to maturity ${(s.lp.holdToMaturityAnnualized * 100).toFixed(1)}% annualized (fair-value buyers get 10.58%)`
      : null;

    const md = `# ${s.label}

${describe(cfg)}

## Reproduce

\`\`\`bash
anvil --fork-url "$ARCHIVE_RPC_URL" --fork-block-number 25829822   # separate terminal, needs contracts/ built
${commandFor(cfg)}
\`\`\`

Writes exactly the three JSON files in this folder; nothing here is hand-edited.

## Result

- Oracle min: ${s.oracleMin.toFixed(4)} (spot min ${s.spotMin.toFixed(4)})
- Eligible debt at the worst point: ${usd(debt)} (USDC ${e.usdcCount} pos / ${usd(e.usdcDebt)}, USDT ${e.usdtCount} pos / ${usd(e.usdtDebt)})
- Manipulator: ${s.manipulator.historicalOk}/11 historical pushes landed${cfg.extraAttackSy !== "0" ? `, ${s.manipulator.extraOk} of the extra pushes landed` : ""}
- Wamia: ${s.arbs} fills after ${s.pushesAnswered} pushes, ${(s.syUsed / 1e6).toFixed(2)}M of ${(s.shippedSy / 1e6).toFixed(2)}M SY used
${lp ? `- ${lp}\n` : ""}
## Files

- \`summary.json\`: the numbers above, machine-readable (also rolled up into \`results/maker-results.md\`)
- \`arbs.json\`: every arb transaction the searcher sent (bought, reverted, or skipped; size, price, gas)
- \`timeseries.json\`: one measurement (spot, oracle, fair value, every position's health) after every block of the replay

Generated by \`npm run results:readmes\` from this folder's own \`summary.json\`.
`;
    const appendix = existsSync(`results/${dir}/run.log`) ? logAppendix() : "";
    writeFileSync(`results/${dir}/README.md`, md + appendix);
    console.log(`wrote results/${dir}/README.md`);
  }
}

main();

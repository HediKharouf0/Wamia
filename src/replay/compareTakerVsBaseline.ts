import { runTakerScenario } from "./scenarioTaker.js";

async function main() {
  console.log("=== Running state-only baseline (zero capital, for apples-to-apples comparison) ===");
  const baseline = await runTakerScenario({ latencyBlocks: 0, capitalSy: 0n, label: "baseline-state-only" });

  const capitalLevels = [
    { label: "taker-100k-L1", capital: 100_000n },
    { label: "taker-2M-L1", capital: 2_000_000n },
    { label: "taker-5M-L1", capital: 5_000_000n },
  ];

  const results = [];
  for (const { label, capital } of capitalLevels) {
    console.log(`\n=== Running taker with $${capital.toLocaleString()}, latency 1 ===`);
    const result = await runTakerScenario({ latencyBlocks: 1, capitalSy: capital * 10n ** 18n, label });
    results.push({ label, capital, ...result });
  }

  console.log("\n\n=== Comparison ===");
  console.log(
    `baseline (no capital): oracle min ${baseline.minOracle.toFixed(4)}, ` +
    `USDC ${baseline.peakLiqUsdc} pos / $${(baseline.peakDebtUsdc / 1e6).toLocaleString()}, ` +
    `USDT ${baseline.peakLiqUsdt} pos / $${(baseline.peakDebtUsdt / 1e6).toLocaleString()}`
  );
  for (const r of results) {
    const debtDeltaUsdc = baseline.peakDebtUsdc - r.peakDebtUsdc;
    const debtDeltaUsdt = baseline.peakDebtUsdt - r.peakDebtUsdt;
    console.log(
      `${r.label}: spent $${(Number(r.totalSpent) / 1e18).toLocaleString()}, oracle min ${r.minOracle.toFixed(4)}, ` +
      `USDC ${r.peakLiqUsdc} pos / $${(r.peakDebtUsdc / 1e6).toLocaleString()} (saved $${(debtDeltaUsdc / 1e6).toLocaleString()}), ` +
      `USDT ${r.peakLiqUsdt} pos / $${(r.peakDebtUsdt / 1e6).toLocaleString()} (saved $${(debtDeltaUsdt / 1e6).toLocaleString()})`
    );
  }
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
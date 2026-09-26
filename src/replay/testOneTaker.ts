import { runTakerScenario } from "./scenarioTaker.js";

runTakerScenario({ latencyBlocks: 1, capitalSy: 100_000n * 10n ** 18n, label: "test-100k-L1" }).catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
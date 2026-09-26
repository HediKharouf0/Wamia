import { archive } from "../chain/client.js";
import addresses from "../../config/addresses.json" with { type: "json" };

const marketAbi = [
  {
    type: "function",
    name: "getPtToAssetRate",
    stateMutability: "view",
    inputs: [{ name: "duration", type: "uint32" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

async function main() {
  const market = addresses.pendle.market as `0x${string}`;
  const forkBlock = 25829822n;
  const knownOracleRate = 970990973037376182000000000000000000n; // confirmed earlier, 1e36-scaled

  console.log("Testing candidate TWAP durations against the known oracle rate...\n");
  const candidates = [1, 60, 300, 600, 900, 1200, 1800, 3600];

  for (const duration of candidates) {
    try {
      const rate = await archive.readContract({
        address: market,
        abi: marketAbi,
        functionName: "getPtToAssetRate",
        args: [duration],
        blockNumber: forkBlock,
      });
      const scaledTo1e36 = rate * 10n ** 18n; // getPtToAssetRate returns 1e18-scaled; oracle is 1e36-scaled
      const diff = scaledTo1e36 > knownOracleRate ? scaledTo1e36 - knownOracleRate : knownOracleRate - scaledTo1e36;
      const diffBps = (Number(diff) / Number(knownOracleRate)) * 10_000;
      console.log(`  duration=${duration}s: rate=${rate}, diff from known oracle = ${diffBps.toFixed(4)} bps`);
    } catch (e: any) {
      console.log(`  duration=${duration}s: FAILED (${e?.shortMessage ?? e?.message})`);
    }
  }
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
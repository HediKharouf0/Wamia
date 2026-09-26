import { sizeBuy } from "./sizing.js";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  console.log(`OK: ${msg}`);
}

// Offline stand-in for Pendle's quote, fitted to the three recorded buys after manip-11
// (spot 0.9472, SY rate 1.0968): average price paid in reUSD/PT vs size in SY.
const RATE = 1_096_800n;
const DEC = { sy: 18, pt: 6 };
const SPOT = 0.9472;
const TARGET = 0.9663; // risk.targetSpot recorded in results/scenario-taker-*/buys.json
const points: [number, number][] = [
  [0, SPOT],
  [100_000, 0.94906],
  [2_000_000, 0.96104],
  [5_000_000, 0.9727],
  [10_000_000, 0.99],
];

function avgPriceAt(sy: number): number {
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]!;
    const [x1, y1] = points[i]!;
    if (sy <= x1) return y0 + ((y1 - y0) * (sy - x0)) / (x1 - x0);
  }
  return points[points.length - 1]![1];
}

let calls = 0;
const quotePt = async (syRaw: bigint) => {
  calls++;
  const sy = Number(syRaw) / 1e18;
  const reUsd = sy * 1.0968;
  return BigInt(Math.floor((reUsd / avgPriceAt(sy)) * 1e6));
};

const M = 10n ** 18n;

async function main() {
  calls = 0;
  const small = await sizeBuy(quotePt, RATE, TARGET, SPOT, 100_000n * M, DEC);
  assert(small.reason === "full-budget" && small.syAmount === 100_000n * M && calls === 1, "$100K: buys everything with one quote");

  calls = 0;
  const mid = await sizeBuy(quotePt, RATE, TARGET, SPOT, 2_000_000n * M, DEC);
  assert(mid.reason === "full-budget" && mid.effectivePriceAsset <= TARGET, "$2M: 0.961 < 0.9663, buys everything");

  calls = 0;
  const big = await sizeBuy(quotePt, RATE, TARGET, SPOT, 5_000_000n * M, DEC);
  const bought = Number(big.syAmount / M);
  console.log(`   $5M budget -> buys ${bought.toLocaleString()} SY at ${big.effectivePriceAsset.toFixed(5)} in ${big.quotes} quotes`);
  assert(big.reason === "partial", "$5M: old code bought all at 0.9727, now buys part");
  assert(big.effectivePriceAsset <= TARGET, "$5M: average price stays under the target");
  assert(bought > 2_000_000 && bought < 5_000_000, "$5M: size lands between the $2M and $5M runs");
  assert(big.quotes <= 4, "at most 4 quotes on the hot path");

  const done = await sizeBuy(quotePt, RATE, TARGET, 0.97, 5_000_000n * M, DEC);
  assert(done.syAmount === 0n && done.reason === "spot-already-at-target", "no buy when spot is already above target");

  const broke = await sizeBuy(quotePt, RATE, TARGET, SPOT, 0n, DEC);
  assert(broke.syAmount === 0n, "no buy without capital");

  console.log("\nAll sizing tests passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

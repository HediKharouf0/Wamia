import { readPendleSnapshot } from "./pendle.js";

async function main() {
  const market = "0x13285bcbc27f92b47b4edb99d744c07b48c977c0" as const;
  const snap = await readPendleSnapshot(market, 25829822n);

  console.log("Pendle snapshot at fork block:");
  console.log(`  totalPt:  ${snap.totalPt.toFixed(2)}`);
  console.log(`  totalSy:  ${snap.totalSy.toFixed(2)}`);
  console.log(`  implied yield: ${(snap.impliedYield * 100).toFixed(3)}%`);
  console.log(`  tau: ${snap.tau.toFixed(4)} years`);
  console.log(`  PT spot price: ${snap.ptSpotPrice.toFixed(4)}`);

  if (snap.totalPt < 1 || snap.totalPt > 1e12) throw new Error("totalPt looks wrong after decimals conversion");
  if (snap.totalSy < 1 || snap.totalSy > 1e12) throw new Error("totalSy looks wrong after decimals conversion");
  console.log("\nMagnitudes look sane after decimals normalization.");
}

main();
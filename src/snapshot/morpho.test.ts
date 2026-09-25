import { archive } from "../chain/client.js";
import { readMorphoSnapshot } from "./morpho.js";
import addresses from "../../config/addresses.json" with { type: "json" };

async function main() {
  const forkBlock = 25829822n;
  const morphoBlue = addresses.morphoBlue as `0x${string}`;

  for (const [name, m] of Object.entries(addresses.morphoMarkets)) {
    const snap = await readMorphoSnapshot(
      archive,
      morphoBlue,
      m.id as `0x${string}`,
      m.oracle as `0x${string}`,
      forkBlock
    );
    console.log(`\n${name.toUpperCase()} market:`);
    console.log(`  oracle price (scaled): ${snap.oraclePriceScaled.toFixed(6)}`);
    console.log(`  totalSupplyAssets: ${snap.totalSupplyAssets.toString()}`);
    console.log(`  totalBorrowAssets: ${snap.totalBorrowAssets.toString()}`);
    console.log(`  totalBorrowShares: ${snap.totalBorrowShares.toString()}`);
    console.log(`  lastUpdate: ${snap.lastUpdate.toString()}`);
  }
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
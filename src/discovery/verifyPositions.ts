import { readFileSync, writeFileSync, existsSync } from "fs";
import addresses from "../../config/addresses.json" with { type: "json" };
import { readPosition } from "../snapshot/position.js";
import { readMorphoSnapshot } from "../snapshot/morpho.js";
import { archive } from "../chain/client.js";

const forkBlock = 25829822n;
const DELAY_MS = 150; // spread requests out to stay under rate limits

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const morphoBlue = addresses.morphoBlue as `0x${string}`;
  const positions: any[] = JSON.parse(readFileSync("fixtures/positions.json", "utf8"));
  const uniqueUsers = [...new Set(positions.map((p) => p.user.address.toLowerCase()))];

  console.log(`${uniqueUsers.length} unique addresses across both markets.`);

  for (const [name, m] of Object.entries(addresses.morphoMarkets)) {
    const outPath = `fixtures/positions-${name}-forkblock.json`;
    if (existsSync(outPath)) {
      console.log(`\n${name}: already done (${outPath} exists), skipping.`);
      continue;
    }

    const mkt = m as any;
    const results = [];
    let sumBorrowShares = 0n;

    for (let i = 0; i < uniqueUsers.length; i++) {
      const user = uniqueUsers[i] as `0x${string}`;
      const pos = await readPosition(archive, morphoBlue, mkt.id as `0x${string}`, user, forkBlock);
      if (pos.borrowShares > 0n || pos.collateral > 0n) {
        results.push(pos);
        sumBorrowShares += pos.borrowShares;
      }
      if ((i + 1) % 50 === 0) console.log(`  ${name}: checked ${i + 1}/${uniqueUsers.length}`);
      await sleep(DELAY_MS);
    }

    const snap = await readMorphoSnapshot(archive, morphoBlue, mkt.id, mkt.oracle, forkBlock);

    console.log(`\n${name.toUpperCase()} market at fork block:`);
    console.log(`  active positions found: ${results.length}`);
    console.log(`  sum(borrowShares):     ${sumBorrowShares.toString()}`);
    console.log(`  totalBorrowShares:     ${snap.totalBorrowShares.toString()}`);
    console.log(`  MATCH: ${sumBorrowShares === snap.totalBorrowShares}`);

    writeFileSync(
      outPath,
      JSON.stringify(
        results.map((r) => ({ ...r, borrowShares: r.borrowShares.toString(), supplyShares: r.supplyShares.toString(), collateral: r.collateral.toString() })),
        null,
        2
      )
    );
  }
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
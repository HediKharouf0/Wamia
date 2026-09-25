import { readFileSync, writeFileSync } from "fs";
import addresses from "../../config/addresses.json" with { type: "json" };
import { readMorphoSnapshot } from "../snapshot/morpho.js";
import { computePositionHealth } from "../health/morphoHealth.js";

const forkBlock = 25829822n;

function serialize(h: any) {
  return {
    ...h,
    collateral: h.collateral.toString(),
    borrowShares: h.borrowShares.toString(),
    borrowAssets: h.borrowAssets.toString(),
    maxBorrow: h.maxBorrow.toString(),
    healthFactor: Number.isFinite(h.healthFactor) ? h.healthFactor : null,
  };
}

async function main() {
  const morphoBlue = addresses.morphoBlue as `0x${string}`;

  for (const [name, m] of Object.entries(addresses.morphoMarkets)) {
    const mkt = m as any;
    const positions: any[] = JSON.parse(readFileSync(`fixtures/positions-${name}-forkblock.json`, "utf8"));
    const snap = await readMorphoSnapshot(morphoBlue, mkt.id, mkt.oracle, forkBlock);

    const healths = positions.map((p) =>
      computePositionHealth(
        { user: p.user, collateral: BigInt(p.collateral), borrowShares: BigInt(p.borrowShares) },
        { totalBorrowAssets: snap.totalBorrowAssets, totalBorrowShares: snap.totalBorrowShares, oraclePrice: snap.oraclePrice, lltv: BigInt(mkt.lltv) }
      )
    );

    const liquidatable = healths.filter((h) => h.liquidatable);
    const borderline = healths.filter((h) => h.borderline);
    const totalLiquidatableDebt = liquidatable.reduce((sum, h) => sum + h.borrowAssets, 0n);

    console.log(`\n${name.toUpperCase()} market at fork block (t0, before the attack):`);
    console.log(`  positions checked: ${healths.length}`);
    console.log(`  liquidatable at t0: ${liquidatable.length}`);
    console.log(`  borderline (|HF-1| < 1bp): ${borderline.length}`);
    console.log(`  total liquidatable debt: ${totalLiquidatableDebt.toString()}`);

    if (liquidatable.length > 0) {
      console.log(`  WARNING: positions liquidatable BEFORE the attack even started — check these first, they may indicate a bug.`);
      for (const h of liquidatable) console.log(`    ${h.user} HF=${h.healthFactor.toFixed(4)}`);
    }
    if (borderline.length > 0) {
      console.log(`  Borderline positions (worth extra scrutiny in task 7.5):`);
      for (const h of borderline) console.log(`    ${h.user} HF=${h.healthFactor.toFixed(6)}`);
    }

    writeFileSync(`fixtures/health-${name}-forkblock.json`, JSON.stringify(healths.map(serialize), null, 2));
  }
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
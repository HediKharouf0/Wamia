import { readFileSync, writeFileSync } from "fs";
import { archive } from "../chain/client.js";
import addresses from "../../config/addresses.json" with { type: "json" };

// Inferred from our own liquidator receipts: topics = [sig, marketId, caller, borrower]
const LIQUIDATE_TOPIC = "0xa4946ede45d0c6f06a0f5ce92c9ad3b4751452d2fe0e25010783bcab57a67e41";

async function main() {
  const fixture = JSON.parse(readFileSync("fixtures/attack-transactions.json", "utf8"));
  const background = JSON.parse(readFileSync("fixtures/background-transactions.json", "utf8"));
  const morphoBlue = addresses.morphoBlue.toLowerCase();
  const pendleMarket = addresses.pendle.market.toLowerCase();
  const marketNames: Record<string, string> = {};
  for (const [name, m] of Object.entries(addresses.morphoMarkets)) marketNames[(m as any).id.toLowerCase()] = name;

  const morphoBg = JSON.parse(readFileSync("fixtures/morpho-background.json", "utf8"));
  const seen = new Set<string>();
  const all = [
    ...fixture.manipulator.map((t: any) => ({ ...t, role: "manipulator" })),
    ...fixture.liquidator.map((t: any) => ({ ...t, role: "liquidator" })),
    ...background.map((t: any) => ({ ...t, role: "background" })),
    ...morphoBg.map((t: any) => ({ ...t, role: "background" })),
  ].filter((t) => {
    const h = t.hash.toLowerCase();
    if (seen.has(h)) return false;
    seen.add(h);
    return true;
  });

  const plan = [];
  for (const tx of all) {
    const r = await archive.getTransactionReceipt({ hash: tx.hash });
    if (r.status !== "success") {
      console.log(`  skipping ${tx.hash.slice(0, 10)} (reverted on mainnet, changes no state)`);
      continue;
    }

    const liquidatedMarkets = r.logs
      .filter((l) => l.address.toLowerCase() === morphoBlue && l.topics[0]?.toLowerCase() === LIQUIDATE_TOPIC)
      .map((l) => marketNames[l.topics[1]!.toLowerCase()] ?? "other-market");
    const touchedPendle = r.logs.some((l) => l.address.toLowerCase() === pendleMarket);
    const kind = liquidatedMarkets.length
      ? `liquidation(${[...new Set(liquidatedMarkets)].join(",")})`
      : tx.role === "manipulator"
        ? "attack"
        : touchedPendle
          ? "pendle-trade"
          : "morpho-other";
    plan.push({
      role: tx.role,
      kind,
      hash: tx.hash,
      from: tx.from,
      to: tx.to,
      input: tx.input,
      blockNumber: r.blockNumber.toString(),
      transactionIndex: r.transactionIndex,
      timeStamp: tx.timeStamp,
      gasUsed: r.gasUsed.toString(),
    });
  }

  plan.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || a.transactionIndex - b.transactionIndex);
  writeFileSync("fixtures/replay-plan.json", JSON.stringify(plan, null, 2));

  for (const p of plan) {
    console.log(`  block ${p.blockNumber} #${String(p.transactionIndex).padEnd(3)} ${p.role.padEnd(12)} ${p.kind.padEnd(24)} ${p.hash.slice(0, 12)}`);
  }
  console.log(`\n${plan.length} transactions written to fixtures/replay-plan.json`);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
}); 
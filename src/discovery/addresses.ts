import { writeFileSync, readFileSync, existsSync } from "fs";

type Receipt = { hash: string; role: string; logAddresses: string[] };

function main() {
  if (!existsSync("fixtures/attack-receipts.json")) {
    throw new Error("Run receipts.ts first");
  }
  const receipts: Receipt[] = JSON.parse(readFileSync("fixtures/attack-receipts.json", "utf8"));

  const counts = new Map<string, { count: number; roles: Set<string> }>();
  for (const r of receipts) {
    for (const addr of r.logAddresses) {
      const entry = counts.get(addr) ?? { count: 0, roles: new Set() };
      entry.count++;
      entry.roles.add(r.role);
      counts.set(addr, entry);
    }
  }

  const ranked = [...counts.entries()]
    .map(([address, v]) => ({ address, ...v, roles: [...v.roles] }))
    .sort((a, b) => b.count - a.count);

  console.log("Addresses that emitted logs across the fixture, most frequent first:\n");
  for (const r of ranked) {
    console.log(`  ${r.address}  seen in ${r.count}/${receipts.length} txs  roles: ${r.roles.join(",")}`);
  }

  writeFileSync("fixtures/log-emitters.json", JSON.stringify(ranked, null, 2));
  console.log("\nWritten to fixtures/log-emitters.json.");
  console.log("Next: cross-check the top few against:");
  console.log("  - Pendle market list: https://api-v2.pendle.finance/core/v1/1/markets/active");
  console.log("  - Morpho markets: https://blue-api.morpho.org/graphql");
  console.log("to label which address is the PT-reUSD market and which is Morpho Blue itself");
  console.log("(Morpho Blue's canonical mainnet address is 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb —");
  console.log("confirm it appears in this list rather than trusting that from memory).");
}

main();
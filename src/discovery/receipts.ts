import { writeFileSync, readFileSync } from "fs";
import { archive } from "../chain/client.js";

type FixtureTx = { hash: `0x${string}`; from: string; to: string };
type Fixture = { forkBlock: number; manipulator: FixtureTx[]; liquidator: FixtureTx[] };

async function main() {
  const fixture: Fixture = JSON.parse(readFileSync("fixtures/attack-transactions.json", "utf8"));
  const all = [
    ...fixture.manipulator.map((t) => ({ ...t, role: "manipulator" })),
    ...fixture.liquidator.map((t) => ({ ...t, role: "liquidator" })),
  ];

  console.log(`Fetching ${all.length} receipts from mainnet...`);

  const receipts = [];
  for (const tx of all) {
    const r = await archive.getTransactionReceipt({ hash: tx.hash });
    receipts.push({
      hash: tx.hash,
      role: tx.role,
      status: r.status,           // "success" | "reverted"
      gasUsed: r.gasUsed.toString(),
      blockNumber: r.blockNumber.toString(),
      logAddresses: [...new Set(r.logs.map((l) => l.address))],
      logCount: r.logs.length,
    });
    console.log(`  ${tx.role} ${tx.hash.slice(0, 10)}... -> ${r.status} (${r.logs.length} logs)`);
  }

  writeFileSync("fixtures/attack-receipts.json", JSON.stringify(receipts, null, 2));

  const reverted = receipts.filter((r) => r.status === "reverted");
  console.log(`\n${reverted.length} reverted on mainnet:`);
  for (const r of reverted) console.log(`  ${r.hash}`);
  console.log(
    reverted.length === 4
      ? "\n=> Matches the 4 local reverts. The replay is faithful; no bug to chase."
      : `\n=> Local reverts were 4; mainnet reverts are ${reverted.length}. These need to line up — investigate the mismatched ones next.`
  );
}

main();
import { readFileSync, writeFileSync } from "fs";
import { toHex } from "viem";
import { archive } from "../chain/client.js";
import addresses from "../../config/addresses.json" with { type: "json" };

const CHUNK = 10n;
const FROM = 25829821n;
const TO = 25829929n;

async function main() {
  const morphoBlue = addresses.morphoBlue as `0x${string}`;
  const ids = Object.values(addresses.morphoMarkets).map((m: any) => m.id);
  const plan: any[] = JSON.parse(readFileSync("fixtures/replay-plan.json", "utf8"));
  const inPlan = new Set(plan.map((p) => p.hash.toLowerCase()));

  const byTx = new Map<string, { block: bigint; index: number; topics: Set<string> }>();
  for (let start = FROM; start <= TO; start += CHUNK) {
    const end = start + CHUNK - 1n > TO ? TO : start + CHUNK - 1n;
    const logs: any[] = await archive.request({
      method: "eth_getLogs" as any,
      params: [{ address: morphoBlue, fromBlock: toHex(start), toBlock: toHex(end), topics: [null, ids] }],
    });
    for (const l of logs) {
      const entry = byTx.get(l.transactionHash) ?? { block: BigInt(l.blockNumber), index: Number(l.transactionIndex), topics: new Set() };
      entry.topics.add(l.topics[0].slice(0, 10));
      byTx.set(l.transactionHash, entry);
    }
  }

  const missing = [...byTx.entries()].filter(([h]) => !inPlan.has(h.toLowerCase()));
  console.log(`${byTx.size} txs touched our two Morpho markets; ${missing.length} are not in the replay plan:\n`);

  const out = [];
  for (const [hash, e] of missing.sort((a, b) => Number(a[1].block - b[1].block) || a[1].index - b[1].index)) {
    const tx = await archive.getTransaction({ hash: hash as `0x${string}` });
    const block = await archive.getBlock({ blockNumber: e.block });
    console.log(`  block ${e.block} #${e.index} | ${hash} | from ${tx.from} | to ${tx.to} | events ${[...e.topics].join(",")}`);
    out.push({ hash, from: tx.from, to: tx.to, input: tx.input, blockNumber: e.block.toString(), timeStamp: block.timestamp.toString() });
  }

  writeFileSync("fixtures/morpho-background.json", JSON.stringify(out, null, 2));
  console.log(`\nWritten to fixtures/morpho-background.json`);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
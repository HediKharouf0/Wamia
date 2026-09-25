import { archive } from "../chain/client.js";
import { readFileSync, writeFileSync } from "fs";

async function main() {
  const receipts: any[] = JSON.parse(readFileSync("fixtures/attack-receipts.json", "utf8"));
  const liquidatorHashes = receipts.filter((r) => r.role === "liquidator").map((r) => r.hash);
  const morphoBlue = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb";

  const allTopics: string[][] = [];
  for (const hash of liquidatorHashes) {
    const r = await archive.getTransactionReceipt({ hash });
    const morphoLogs = r.logs.filter((l) => l.address.toLowerCase() === morphoBlue);
    for (const log of morphoLogs) {
      console.log(`${hash.slice(0, 10)}...  topics: ${JSON.stringify(log.topics)}`);
      allTopics.push(log.topics as string[]);
    }
  }

  // find topic positions that are constant across every log
  const maxTopics = Math.max(...allTopics.map((t) => t.length));
  for (let i = 0; i < maxTopics; i++) {
    const values = new Set(allTopics.map((t) => t[i]).filter(Boolean));
    console.log(`\ntopic[${i}]: ${values.size} distinct value(s) across ${allTopics.length} logs`);
    if (values.size <= 3) console.log([...values]);
  }

  writeFileSync("fixtures/morpho-log-topics.json", JSON.stringify(allTopics, null, 2));
}

main();
import { archive } from "../chain/client.js";
import { writeFileSync, readFileSync } from "fs";

const CHUNK = 10;
const MAX_REQUESTS = 100; // hard stop — will not exceed this no matter what

async function main() {
  const receipts: any[] = JSON.parse(readFileSync("fixtures/attack-receipts.json", "utf8"));
  const blocks = receipts.map((r) => BigInt(r.blockNumber));
  const fromBlock = blocks.reduce((a, b) => (a < b ? a : b)) - 2n;
  const toBlock = blocks.reduce((a, b) => (a > b ? a : b)) + 2n;
  const totalBlocks = toBlock - fromBlock + 1n;
  const requestCount = Math.ceil(Number(totalBlocks) / CHUNK);

  console.log(`Range: block ${fromBlock} to ${toBlock} (${totalBlocks} blocks)`);
  console.log(`This would take ${requestCount} requests at ${CHUNK} blocks/request.`);

  if (requestCount > MAX_REQUESTS) {
    console.log(`\nAborting: ${requestCount} exceeds the safety cap of ${MAX_REQUESTS}.`);
    console.log("Either narrow the window or raise MAX_REQUESTS deliberately.");
    return;
  }

  if (process.argv[2] !== "--go") {
    console.log("\nDry run only. Re-run with --go to actually make the requests.");
    return;
  }

  const morphoBlue = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as const;
  const logs = [];
  let start = fromBlock;
  let n = 0;
  while (start <= toBlock) {
    const end = start + BigInt(CHUNK - 1) > toBlock ? toBlock : start + BigInt(CHUNK - 1);
    const chunk = await archive.getLogs({ address: morphoBlue, fromBlock: start, toBlock: end });
    logs.push(...chunk);
    n++;
    console.log(`  request ${n}/${requestCount} done (${chunk.length} logs)`);
    start = end + 1n;
  }

  const knownHashes = new Set(receipts.map((r) => r.hash.toLowerCase()));
  const txHashes = [...new Set(logs.map((l) => l.transactionHash!.toLowerCase()))];
  const unknown = txHashes.filter((h) => !knownHashes.has(h));

  console.log(`\n${txHashes.length} distinct txs touched Morpho Blue in this window.`);
  console.log(`${unknown.length} are NOT in your fixture:`);
  for (const h of unknown) console.log(`  ${h}`);

  writeFileSync(
    "fixtures/background-candidates.json",
    JSON.stringify({ fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), unknownHashes: unknown }, null, 2)
  );
  console.log("\nWritten to fixtures/background-candidates.json.");
}

main();
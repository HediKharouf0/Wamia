import { readFileSync, writeFileSync } from "fs";
import { archive } from "../chain/client.js";
import addresses from "../../config/addresses.json" with { type: "json" };

const CHUNK = 10n;
const FROM = 25829868n; // first liquidator tx
const TO = 25829929n;   // end of the attack window

async function main() {
  const market = addresses.pendle.market as `0x${string}`;
  const fixture = JSON.parse(readFileSync("fixtures/attack-transactions.json", "utf8"));
  const known = new Set([...fixture.manipulator, ...fixture.liquidator].map((t: any) => t.hash.toLowerCase()));

  const labels: Record<string, string> = {};
  for (const [name, addr] of Object.entries(addresses.wallets)) labels[(addr as string).toLowerCase()] = name;
  labels[addresses.liquidationProxy.toLowerCase()] = "liquidationProxy";
  labels[addresses.trueLiquidationCaller.toLowerCase()] = "trueLiquidationCaller";

  const hashes = new Set<string>();
  for (let start = FROM; start <= TO; start += CHUNK) {
    const end = start + CHUNK - 1n > TO ? TO : start + CHUNK - 1n;
    const logs = await archive.getLogs({ address: market, fromBlock: start, toBlock: end });
    for (const l of logs) hashes.add(l.transactionHash!.toLowerCase());
  }

  const unknown = [...hashes].filter((h) => !known.has(h));
  console.log(`${hashes.size} txs touched the Pendle market in blocks ${FROM}-${TO}; ${unknown.length} are not in the fixture:\n`);

  const background = [];
  for (const hash of unknown) {
    const tx = await archive.getTransaction({ hash: hash as `0x${string}` });
    const block = await archive.getBlock({ blockNumber: tx.blockNumber! });
    const label = labels[tx.from.toLowerCase()] ?? "unknown";
    console.log(`  block ${tx.blockNumber} | ${hash} | from ${tx.from} (${label}) | to ${tx.to}`);
    background.push({
      hash,
      from: tx.from,
      to: tx.to,
      input: tx.input,
      blockNumber: tx.blockNumber!.toString(),
      timeStamp: block.timestamp.toString(),
    });
  }

  background.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber));
  writeFileSync("fixtures/background-transactions.json", JSON.stringify(background, null, 2));
  console.log(`\nWritten to fixtures/background-transactions.json`);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
import { fork } from "../chain/client.js";
import { resetFork, sendHistoricalTx } from "../replay/actions.js";
import addresses from "../../config/addresses.json" with { type: "json" };
import { getAddress, keccak256, encodeAbiParameters } from "viem";
import { readFileSync } from "fs";

async function main() {
  await resetFork(fork, 25829822n);

  const syToken = addresses.pendle.sy as `0x${string}`;
  const holder = getAddress("0x854e3f3b521dbae34cb111ebef0dce41d8b5690d");

  const candidateKeys: { base: number; key: `0x${string}` }[] = [];
  for (let base = 0; base < 20; base++) {
    candidateKeys.push({
      base,
      key: keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, BigInt(base)])),
    });
  }

  const before: string[] = [];
  for (const { key } of candidateKeys) {
    before.push(await fork.request({ method: "eth_getStorageAt" as any, params: [syToken, key, "latest"] }));
  }

  const fixture = JSON.parse(readFileSync("fixtures/attack-transactions.json", "utf8"));
  await sendHistoricalTx(fork, fixture.manipulator[0], 4_000_000n);

  console.log("Checking mapping-derived keys for a change (this is the reliable indicator, not sequential slots):");
  let found = false;
  for (let i = 0; i < candidateKeys.length; i++) {
    const after = await fork.request({ method: "eth_getStorageAt" as any, params: [syToken, candidateKeys[i]!.key, "latest"] });
    if (after !== before[i]) {
      console.log(`  MATCH at base slot ${candidateKeys[i]!.base}: ${before[i]} -> ${after}`);
      found = true;
    }
  }
  if (!found) console.log("  No match in base slots 0-19 — may need a wider range or the layout uses a non-standard mapping position.");
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
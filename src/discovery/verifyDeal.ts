import { fork } from "../chain/client.js";
import { resetFork } from "../replay/actions.js";
import { dealErc20 } from "../replay/dealErc20.js";
import addresses from "../../config/addresses.json" with { type: "json" };
import { getAddress } from "viem";

async function main() {
  await resetFork(fork, 25829822n);

  const reUsd = addresses.pendle.underlying as `0x${string}`;
  const testHolder = getAddress("0x000000000000000000000000000000000000dead"); // lowercase in, checksummed out
  const testAmount = 1_000_000_000_000_000_000_000n; // 1000 tokens at 18 decimals

  console.log("Brute-forcing reUSD balance slot...");
  const result = await dealErc20(fork, reUsd, testHolder as `0x${string}`, testAmount);
  console.log(result.verified ? `Found at slot ${result.slot}` : "Not found in standard layout — token may be non-standard");
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
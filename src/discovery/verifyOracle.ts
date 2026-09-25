import { archive } from "../chain/client.js";

const oracle = "0x217d6DdCDB95112C51657F6270e8C079CFDB51f0" as const;
const forkBlock = 25829822n;

const abi = [
  { type: "function", name: "price", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

async function main() {
  const price = await archive.readContract({ address: oracle, abi, functionName: "price", blockNumber: forkBlock });
  console.log(`Oracle price at fork block: ${price.toString()}`);
  console.log(`As 1e36-scaled: ${(Number(price) / 1e36).toFixed(6)}`);
  console.log(`As 1e18-scaled: ${(Number(price) / 1e18).toFixed(6)}`);
  console.log(`\nCross-check: PT spot price from Pendle snapshot was 0.9710.`);
  console.log(`Whichever scaling above lands closest to a number consistent with that (adjusted for loan/collateral decimals) is likely correct.`);
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
import { archive } from "../chain/client.js";
import { writeFileSync } from "fs";

const marketIdCandidates = [
  "0x1e9d614631a7df0ec07fb05b2c8cb2491575fd1a63a33bf187a6afb295a4fc64",
  "0x6acd18854e43f93f5a90446004c35c72a68af1ad99f08cb247782ce6457914ca",
] as const;

const morphoBlue = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as const;

const abi = [
  {
    type: "function",
    name: "idToMarketParams",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "loanToken", type: "address" },
      { name: "collateralToken", type: "address" },
      { name: "oracle", type: "address" },
      { name: "irm", type: "address" },
      { name: "lltv", type: "uint256" },
    ],
  },
] as const;

async function main() {
  const results = [];
  for (const id of marketIdCandidates) {
    try {
      const params = await archive.readContract({
        address: morphoBlue,
        abi,
        functionName: "idToMarketParams",
        args: [id as `0x${string}`],
      });
      console.log(`\nMarket ${id}:`);
      console.log(`  loanToken:       ${params[0]}`);
      console.log(`  collateralToken: ${params[1]}`);
      console.log(`  oracle:          ${params[2]}`);
      console.log(`  irm:             ${params[3]}`);
      console.log(`  lltv:            ${params[4].toString()}`);
      results.push({ id, loanToken: params[0], collateralToken: params[1], oracle: params[2], irm: params[3], lltv: params[4].toString() });
    } catch (e) {
      console.log(`\nMarket ${id}: call failed — ${(e as Error).message.slice(0, 200)}`);
    }
  }
  writeFileSync("fixtures/morpho-markets.json", JSON.stringify(results, null, 2));
  console.log("\nWritten to fixtures/morpho-markets.json.");
}

main();
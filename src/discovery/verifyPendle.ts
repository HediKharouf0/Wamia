import { archive } from "../chain/client.js";
import { ptPriceFromYield } from "../pricing/fairValue.js";

const pendleMarket = "0x13285bcbc27f92b47b4edb99d744c07b48c977c0" as const;
const forkBlock = 25829822n;

const abi = [
  {
    type: "function",
    name: "_storage",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "totalPt", type: "int128" },
      { name: "totalSy", type: "int128" },
      { name: "lastLnImpliedRate", type: "uint96" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
    ],
  },
  {
    type: "function",
    name: "expiry",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

async function main() {
  const [storage, expiry, blockInfo] = await Promise.all([
    archive.readContract({ address: pendleMarket, abi, functionName: "_storage", blockNumber: forkBlock }),
    archive.readContract({ address: pendleMarket, abi, functionName: "expiry", blockNumber: forkBlock }),
    archive.getBlock({ blockNumber: forkBlock }),
  ]);

  const [totalPt, totalSy, lastLnImpliedRate] = storage;
  const timestamp = Number(blockInfo.timestamp);
  const tau = (Number(expiry) - timestamp) / (365 * 24 * 60 * 60);

  // lastLnImpliedRate is ln(1+y) scaled 1e18
  const impliedYield = Math.exp(Number(lastLnImpliedRate) / 1e18) - 1;
  const ptPrice = ptPriceFromYield(impliedYield, tau);

  console.log(`Block ${forkBlock} (timestamp ${timestamp}):`);
  console.log(`  totalPt:  ${totalPt.toString()}`);
  console.log(`  totalSy:  ${totalSy.toString()}`);
  console.log(`  lastLnImpliedRate (raw): ${lastLnImpliedRate.toString()}`);
  console.log(`  expiry:   ${expiry.toString()} (${new Date(Number(expiry) * 1000).toISOString()})`);
  console.log(`  tau:      ${tau.toFixed(4)} years`);
  console.log(`  implied yield: ${(impliedYield * 100).toFixed(3)}%`);
  console.log(`  PT price (derived): ${ptPrice.toFixed(4)}`);
  console.log(`\nSanity check: Pendle's live API showed ~11.2% implied APY.`);
  console.log(`Getting a plausible single-digit-to-low-double-digit % here confirms the ABI decoded correctly.`);
}

main();
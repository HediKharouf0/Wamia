import { readFileSync } from "fs";
import { archive } from "../chain/client.js";
import addresses from "../../config/addresses.json" with { type: "json" };

const oracleAbi = [
  { type: "function", name: "price", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

async function main() {
  const receipts: any[] = JSON.parse(readFileSync("fixtures/attack-receipts.json", "utf8"));
  const points: any[] = JSON.parse(readFileSync("results/baseline-historical/timeseries.json", "utf8"));
  const oracle = addresses.morphoMarkets.usdc.oracle as `0x${string}`;

  const liqPoints = points.filter((p) => p.txHash && p.label.startsWith("liqui"));

  for (const p of liqPoints) {
    const r = receipts.find((x) => x.hash.toLowerCase() === p.txHash.toLowerCase());
    const block = BigInt(r.blockNumber);
    const mainnetRaw = await archive.readContract({ address: oracle, abi: oracleAbi, functionName: "price", blockNumber: block });
    const mainnet = Number(mainnetRaw) / 1e36;
    const diffBps = ((p.oraclePrice - mainnet) / mainnet) * 10_000;
    console.log(
      `${p.label.padEnd(12)} mainnet block ${block} | mainnet oracle ${mainnet.toFixed(5)} | fork oracle ${p.oraclePrice.toFixed(5)} | diff ${diffBps.toFixed(2)} bps`
    );
  }
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
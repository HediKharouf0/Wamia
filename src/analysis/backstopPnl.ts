import { readFileSync } from "fs";
import { archive } from "../chain/client.js";
import addresses from "../../config/addresses.json" with { type: "json" };
import { tauFromTimestamps } from "../pricing/fairValue.js";

const exchangeRateAbi = [
  { type: "function", name: "exchangeRate", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

async function main() {
  const scenarios = ["taker-100k-L1", "taker-2M-L1", "taker-5M-L1"];
  const syToken = addresses.pendle.sy as `0x${string}`;
  const expirySeconds = Math.floor(new Date(addresses.pendle.expiry).getTime() / 1000);

  for (const label of scenarios) {
    const buys: any[] = JSON.parse(readFileSync(`results/scenario-${label}/buys.json`, "utf8"));
    if (buys.length === 0) {
      console.log(`${label}: no buys, skipping`);
      continue;
    }

    console.log(`\n=== ${label} ===`);
    let totalSySpent = 0n;
    let totalPtReceived = 0n;

    for (const b of buys) {
      const syAmount = BigInt(b.syAmount);
      const netPtOut = BigInt(b.netPtOut);
      totalSySpent += syAmount;
      totalPtReceived += netPtOut;
      
      const rate = await archive.readContract({ address: syToken, abi: exchangeRateAbi, functionName: "exchangeRate", blockNumber: BigInt(b.block) });
      const syInUnderlying = (Number(syAmount) / 1e18) * (Number(rate) / 1e6);
      const ptReceived = Number(netPtOut) / 1e6;

      console.log(`  buy at block ${b.block}: spent ${(Number(syAmount) / 1e18).toFixed(2)} SY (~${syInUnderlying.toFixed(2)} underlying), got ${ptReceived.toFixed(2)} PT`);
      console.log(`    effective price paid: ${b.effectivePrice.toFixed(4)}, market fair value at t0: 0.9710`);

      const holdToMaturityProfit = ptReceived - syInUnderlying;
      console.log(`    hold-to-maturity profit: ${holdToMaturityProfit >= 0 ? "+" : ""}${holdToMaturityProfit.toFixed(2)} underlying (${((holdToMaturityProfit / syInUnderlying) * 100).toFixed(2)}%)`);

      const markToMarketValue = ptReceived * 0.971;
      const markToMarketProfit = markToMarketValue - syInUnderlying;
      console.log(`    mark-to-market profit (PT priced at 0.9710): ${markToMarketProfit >= 0 ? "+" : ""}${markToMarketProfit.toFixed(2)} underlying (${((markToMarketProfit / syInUnderlying) * 100).toFixed(2)}%)`);
    }

    const tau = tauFromTimestamps(1787632667, expirySeconds); // approx attack-time timestamp
    const totalSyInUnderlying = Number(totalSySpent) / 1e18;
    const totalPt = Number(totalPtReceived) / 1e6;
    const totalReturn = (totalPt - totalSyInUnderlying) / totalSyInUnderlying;
    const annualized = Math.pow(1 + totalReturn, 1 / tau) - 1;
    console.log(`  TOTAL: ${totalReturn >= 0 ? "+" : ""}${(totalReturn * 100).toFixed(2)}% over ${(tau * 365).toFixed(0)} days -> ${(annualized * 100).toFixed(1)}% annualized`);
  }
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
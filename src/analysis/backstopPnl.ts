import { readFileSync, readdirSync, existsSync } from "fs";
import { archive } from "../chain/client.js";
import addresses from "../../config/addresses.json" with { type: "json" };
import { tauFromTimestamps } from "../pricing/fairValue.js";
import { exchangeRateAbi, syToAsset } from "../pricing/units.js";

// SY-reUSD: 18 decimals; reUSD and PT: 6 decimals. All profit is measured in reUSD.
const SY_DECIMALS = 18;
const ASSET_DECIMALS = 6;
const FAIR_AT_T0 = 0.971; // PT spot at the fork block, reUSD per PT
const ATTACK_TS = 1787632667; // first liquidation on mainnet, used for time to maturity

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;

async function rateFor(buy: any): Promise<bigint> {
  if (buy.syRate) return BigInt(buy.syRate);
  // Older runs did not record the rate. Fork block numbers overlap mainnet, so this reads
  // mainnet at the same height, which is within seconds of the fork state. Close enough for
  // a rate that moves by ~1e-7 per minute, but new runs record the exact value.
  const syToken = addresses.pendle.sy as `0x${string}`;
  return archive.readContract({ address: syToken, abi: exchangeRateAbi, functionName: "exchangeRate", blockNumber: BigInt(buy.block) });
}

async function main() {
  const expirySeconds = Math.floor(new Date(addresses.pendle.expiry).getTime() / 1000);
  const tau = tauFromTimestamps(ATTACK_TS, expirySeconds);
  const annualize = (r: number) => Math.pow(1 + r, 1 / tau) - 1;

  const labels = existsSync("results")
    ? readdirSync("results").filter((d) => d.startsWith("scenario-taker-")).map((d) => d.slice("scenario-".length))
    : [];

  for (const label of labels) {
    const buys: any[] = JSON.parse(readFileSync(`results/scenario-${label}/buys.json`, "utf8"));
    if (buys.length === 0) {
      console.log(`\n=== ${label} === no buys`);
      continue;
    }

    console.log(`\n=== ${label} ===`);
    let totalCost = 0; // reUSD
    let totalPt = 0;

    for (const b of buys) {
      const syAmount = BigInt(b.syAmount);
      const rate = await rateFor(b);
      const cost = syToAsset(syAmount, rate, SY_DECIMALS, ASSET_DECIMALS);
      const pt = Number(BigInt(b.netPtOut)) / 10 ** ASSET_DECIMALS;
      totalCost += cost;
      totalPt += pt;

      const hold = (pt - cost) / cost;
      const mtm = (pt * FAIR_AT_T0 - cost) / cost;
      console.log(
        `  buy at block ${b.block}: ${(Number(syAmount) / 1e18).toFixed(2)} SY = ${cost.toFixed(2)} reUSD -> ${pt.toFixed(2)} PT ` +
          `(paid ${(cost / pt).toFixed(4)} reUSD/PT, fair ${FAIR_AT_T0})`
      );
      console.log(`    hold to maturity: ${pct(hold)} (${pct(annualize(hold))} annualized), mark to market at fair: ${pct(mtm)}`);
    }

    const hold = (totalPt - totalCost) / totalCost;
    const mtm = (totalPt * FAIR_AT_T0 - totalCost) / totalCost;
    console.log(
      `  TOTAL: ${totalCost.toFixed(2)} reUSD -> ${totalPt.toFixed(2)} PT | hold to maturity ${pct(hold)} over ` +
        `${(tau * 365).toFixed(0)} days (${pct(annualize(hold))} annualized; fair-value buyers earn ~10.58%) | ` +
        `mark to market ${pct(mtm)}`
    );
  }
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});

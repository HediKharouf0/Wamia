import { writeFileSync } from "fs";
import { toHex } from "viem";
import { archive } from "../chain/client.js";
import addresses from "../../config/addresses.json" with { type: "json" };

const CHUNK = 10n;
const FROM = 25829821n;
const TO = 25829929n;
const LIQUIDATE_TOPIC = "0xa4946ede45d0c6f06a0f5ce92c9ad3b4751452d2fe0e25010783bcab57a67e41";

// Liquidate(bytes32 indexed id, address indexed caller, address indexed borrower,
//           uint256 repaidAssets, uint256 repaidShares, uint256 seizedAssets, ...)
// data field layout inferred, not yet confirmed against ABI — verify against a known tx below.

async function main() {
  const morphoBlue = addresses.morphoBlue as `0x${string}`;
  const ourMarketIds = new Set(Object.values(addresses.morphoMarkets).map((m: any) => m.id.toLowerCase()));

  const events: any[] = [];
  for (let start = FROM; start <= TO; start += CHUNK) {
    const end = start + CHUNK - 1n > TO ? TO : start + CHUNK - 1n;
    const logs: any[] = await archive.request({
      method: "eth_getLogs" as any,
      params: [{ address: morphoBlue, fromBlock: toHex(start), toBlock: toHex(end), topics: [LIQUIDATE_TOPIC] }],
    });
    events.push(...logs);
  }

  console.log(`${events.length} Liquidate events on Morpho Blue in blocks ${FROM}-${TO}\n`);

  // sanity check the data layout against one known event before trusting the decode
  const sample = events[0];
  console.log("Raw sample event for manual decode check:");
  console.log(`  marketId: ${sample.topics[1]}`);
  console.log(`  data:     ${sample.data}`);

  const repaidAssetsHex = sample.data.slice(2, 66);
  const repaidSharesHex = sample.data.slice(66, 130);
  const seizedAssetsHex = sample.data.slice(130, 194);
  console.log(`  decoded (assuming repaidAssets, repaidShares, seizedAssets order):`);
  console.log(`    repaidAssets: ${BigInt("0x" + repaidAssetsHex)}`);
  console.log(`    repaidShares: ${BigInt("0x" + repaidSharesHex)}`);
  console.log(`    seizedAssets: ${BigInt("0x" + seizedAssetsHex)}\n`);

  let totalRepaidAllMarkets = 0n;
  let totalRepaidOurMarkets = 0n;
  const perMarket = new Map<string, bigint>();

  for (const e of events) {
    const marketId = e.topics[1].toLowerCase();
    const repaidAssets = BigInt("0x" + e.data.slice(2, 66));
    totalRepaidAllMarkets += repaidAssets;
    perMarket.set(marketId, (perMarket.get(marketId) ?? 0n) + repaidAssets);
    if (ourMarketIds.has(marketId)) totalRepaidOurMarkets += repaidAssets;
  }

  console.log(`Distinct markets liquidated in this window: ${perMarket.size}`);
  for (const [id, total] of perMarket) {
    const known = Object.entries(addresses.morphoMarkets).find(([, m]: any) => m.id.toLowerCase() === id);
    console.log(`  ${id} ${known ? `(${known[0]})` : "(other market)"}: repaid ${(Number(total) / 1e6).toLocaleString()}`);
  }

  console.log(`\nTotal repaid, all markets: $${(Number(totalRepaidAllMarkets) / 1e6).toLocaleString()}`);
  console.log(`Total repaid, our two markets: $${(Number(totalRepaidOurMarkets) / 1e6).toLocaleString()}`);
  console.log(`Our share: ${((Number(totalRepaidOurMarkets) / Number(totalRepaidAllMarkets)) * 100).toFixed(1)}%`);

    writeFileSync(
    "results/baseline-historical/liquidation-reconciliation.json",
    JSON.stringify(
        {
        totalRepaidAllMarkets: totalRepaidAllMarkets.toString(),
        totalRepaidOurMarkets: totalRepaidOurMarkets.toString(),
        perMarket: Object.fromEntries([...perMarket].map(([k, v]) => [k, v.toString()])),
        },
        null,
        2
    )
  );
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
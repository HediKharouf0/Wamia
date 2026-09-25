import { readFileSync } from "fs";
import { archive } from "../chain/client.js";
import { readPendleSnapshot } from "../snapshot/pendle.js";
import addresses from "../../config/addresses.json" with { type: "json" };

async function main() {
  const receipts: any[] = JSON.parse(readFileSync("fixtures/attack-receipts.json", "utf8"));
  const pilot: any[] = JSON.parse(readFileSync("fixtures/pilot-pendle-timeseries.json", "utf8"));
  const market = addresses.pendle.market as `0x${string}`;
  const manipulator = receipts.filter((r) => r.role === "manipulator");

  for (let i = 0; i < manipulator.length; i++) {
    const mainnetBlock = BigInt(manipulator[i].blockNumber);
    const real = await readPendleSnapshot(archive, market, mainnetBlock);
    const ours = pilot[i + 1];
    const diffBps = ((ours.ptSpotPrice - real.ptSpotPrice) / real.ptSpotPrice) * 10_000;
    console.log(
      `tx ${i + 1}: mainnet block ${mainnetBlock} PT ${real.ptSpotPrice.toFixed(4)} | fork PT ${ours.ptSpotPrice.toFixed(4)} | diff ${diffBps.toFixed(2)} bps`
    );
  }
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
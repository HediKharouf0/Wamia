import { archive } from "../chain/client.js";
import addresses from "../../config/addresses.json" with { type: "json" };

const exchangeRateAbi = [
  { type: "function", name: "exchangeRate", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

async function main() {
  const syToken = addresses.pendle.sy as `0x${string}`;
  const rate = await archive.readContract({ address: syToken, abi: exchangeRateAbi, functionName: "exchangeRate", blockNumber: 25829854n });
  console.log(`raw exchangeRate(): ${rate.toString()}`);
  console.log(`as 1e18-scaled: ${Number(rate) / 1e18}`);
  console.log(`as 1e6-scaled: ${Number(rate) / 1e6}`);

  const testSyAmount = 100_000n * 10n ** 18n; // 100K SY
  const converted1e18 = (Number(testSyAmount) * Number(rate)) / 1e18 / 1e18;
  console.log(`\n100K SY converted (dividing by 1e18 twice): ${converted1e18}`);
  const converted1e18Once = (Number(testSyAmount) * Number(rate)) / 1e36;
  console.log(`same thing, one division: ${converted1e18Once}`);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
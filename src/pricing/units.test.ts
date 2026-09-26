import { assetPerSy, syToAsset, pricePaidInAsset } from "./units.js";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  console.log(`OK: ${msg}`);
}

const close = (a: number, b: number, tol: number) => Math.abs(a - b) < tol;

// SY-reUSD at the attack: exchangeRate() ~1.0968e6, SY 18 decimals, reUSD/PT 6 decimals
const rate = 1_096_800n;
const dec = { sy: 18, pt: 6 };

assert(close(assetPerSy(rate, 18, 6), 1.0968, 1e-12), "1 SY = 1.0968 reUSD");
assert(close(syToAsset(2_000_000n * 10n ** 18n, rate, 18, 6), 2_193_600, 1e-6), "2M SY = 2,193,600 reUSD");

// Recorded taker buys (results/scenario-taker-*/buys.json): SY spent -> PT received
assert(close(pricePaidInAsset(100_000n * 10n ** 18n, 115_568_069_307n, rate, dec), 0.94906, 1e-4), "$100K buy paid ~0.949 reUSD/PT");
assert(close(pricePaidInAsset(2_000_000n * 10n ** 18n, 2_282_525_909_027n, rate, dec), 0.96104, 1e-4), "$2M buy paid ~0.961 reUSD/PT");
assert(close(pricePaidInAsset(5_000_000n * 10n ** 18n, 5_637_901_189_471n, rate, dec), 0.97270, 1e-4), "$5M buy paid ~0.973 reUSD/PT (above target 0.9663)");

console.log("\nAll unit tests passed.");

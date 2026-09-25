import { ptPriceFromYield, yieldFromPtPrice, tauFromTimestamps } from "./fairValue.js";

function approxEqual(a: number, b: number, tol = 0.0001): boolean {
  return Math.abs(a - b) < tol;
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  console.log(`OK: ${msg}`);
}

const tau = 107 / 365; // "roughly 107 days to maturity" from the original doc

assert(approxEqual(ptPriceFromYield(0.11, tau), 0.9699, 0.001), "11% yield -> ~0.9699 PT price");
assert(approxEqual(ptPriceFromYield(0.20, tau), 0.9480, 0.001), "20% yield -> ~0.9480 PT price");
assert(approxEqual(ptPriceFromYield(0.22, tau), 0.9434, 0.001), "22% yield -> ~0.9434 PT price");

const y = 0.15;
const price = ptPriceFromYield(y, tau);
assert(approxEqual(yieldFromPtPrice(price, tau), y, 1e-9), "yield -> price -> yield round-trips");

const expiry = new Date("2026-12-10T00:00:00.000Z").getTime() / 1000;
const attackTime = new Date("2026-08-25T00:00:00.000Z").getTime() / 1000;
const computedTau = tauFromTimestamps(attackTime, expiry);
assert(approxEqual(computedTau, 107 / 365, 0.01), `tau at attack time ≈ 107/365 (got ${computedTau.toFixed(4)})`);

console.log("\nAll fair-value tests passed.");
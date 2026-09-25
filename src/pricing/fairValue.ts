/**
 * Pendle PT pricing: P_PT = 1 / (1 + y)^tau
 * y = implied annualized yield, tau = years to maturity
 */

export function ptPriceFromYield(impliedYield: number, tau: number): number {
  return 1 / Math.pow(1 + impliedYield, tau);
}

/** Inverse: recover implied yield from an observed PT price */
export function yieldFromPtPrice(ptPrice: number, tau: number): number {
  return Math.pow(1 / ptPrice, 1 / tau) - 1;
}

/** Years remaining to maturity, from unix timestamps (seconds) */
export function tauFromTimestamps(nowSeconds: number, expirySeconds: number): number {
  const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
  return Math.max(0, (expirySeconds - nowSeconds) / SECONDS_PER_YEAR);
}
/**
 * Unit conversions between SY and its underlying asset (reUSD for SY-reUSD).
 *
 * Pendle's SY convention: assetRaw = syRaw * exchangeRate / 1e18, each amount in its own
 * token's raw units. SY-reUSD has 18 decimals and reUSD 6, so exchangeRate() reads ~1.0968e6,
 * which is why it looked "1e6-scaled". PT has the asset's decimals.
 *
 * Every price in this project (Pendle spot, Morpho oracle, fair value, risk targets) is in
 * asset per PT. Anything priced in SY must go through these helpers before being compared.
 */

/** Asset per 1 SY, in human units (e.g. ~1.0968 reUSD per SY). */
export function assetPerSy(exchangeRate: bigint, syDecimals: number, assetDecimals: number): number {
  return (Number(exchangeRate) * 10 ** syDecimals) / 1e18 / 10 ** assetDecimals;
}

/** Converts a raw SY amount to human asset units. */
export function syToAsset(syRaw: bigint, exchangeRate: bigint, syDecimals: number, assetDecimals: number): number {
  return (Number(syRaw) / 10 ** syDecimals) * assetPerSy(exchangeRate, syDecimals, assetDecimals);
}

/** Average price actually paid for PT, in asset per PT. */
export function pricePaidInAsset(
  syRaw: bigint,
  ptRaw: bigint,
  exchangeRate: bigint,
  decimals: { sy: number; pt: number }
): number {
  const pt = Number(ptRaw) / 10 ** decimals.pt;
  return syToAsset(syRaw, exchangeRate, decimals.sy, decimals.pt) / pt;
}

export const exchangeRateAbi = [
  { type: "function", name: "exchangeRate", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

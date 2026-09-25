// Morpho Blue's virtual shares/assets, used to avoid share-price manipulation
// via the "donation" attack. These are compile-time constants in Morpho's
// SharesMathLib, not independently readable on-chain — verify against task 7.5.
const VIRTUAL_SHARES = 1_000_000n; // 1e6
const VIRTUAL_ASSETS = 1n;
const ORACLE_PRICE_SCALE = 10n ** 36n;
const WAD = 10n ** 18n;

/** Morpho's toAssetsUp: shares -> assets, rounding up (used for debt, conservative direction) */
function toAssetsUp(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  const numerator = shares * (totalAssets + VIRTUAL_ASSETS);
  const denominator = totalShares + VIRTUAL_SHARES;
  return (numerator + denominator - 1n) / denominator; // ceiling division
}

export type PositionHealth = {
  user: `0x${string}`;
  collateral: bigint;
  borrowShares: bigint;
  borrowAssets: bigint;      // derived via toAssetsUp
  maxBorrow: bigint;         // collateral value * LLTV
  liquidatable: boolean;
  healthFactor: number;      // maxBorrow / borrowAssets; Infinity if no debt
  borderline: boolean;       // |HF - 1| < 1bp — worth flagging for task 7.5
};

export function computePositionHealth(
  position: { user: `0x${string}`; collateral: bigint; borrowShares: bigint },
  market: { totalBorrowAssets: bigint; totalBorrowShares: bigint; oraclePrice: bigint; lltv: bigint }
): PositionHealth {
  const borrowAssets = toAssetsUp(position.borrowShares, market.totalBorrowAssets, market.totalBorrowShares);
  const collateralValue = (position.collateral * market.oraclePrice) / ORACLE_PRICE_SCALE;
  const maxBorrow = (collateralValue * market.lltv) / WAD;

  const liquidatable = borrowAssets > maxBorrow;
  const healthFactor = borrowAssets === 0n ? Infinity : Number(maxBorrow) / Number(borrowAssets);
  const borderline = Number.isFinite(healthFactor) && Math.abs(healthFactor - 1) < 0.0001;

  return {
    user: position.user,
    collateral: position.collateral,
    borrowShares: position.borrowShares,
    borrowAssets,
    maxBorrow,
    liquidatable,
    healthFactor,
    borderline,
  };
}
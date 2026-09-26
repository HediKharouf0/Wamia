export type Rung = { liqPrice: number; debt: number }; // debt in USD

export type RiskAssessment = {
  gapBps: number;
  earliestDeadlineSec: number;
  debtAtRiskInWindow: number;
  targetSpot: number;
};

/** Build the ladder once from positions: liquidation price and debt, highest price first. */
export function buildLadder(
  positions: { debt: bigint; collateral: bigint }[],
  lltv: bigint,
  debtDecimals: number
): Rung[] {
  return positions
    .filter((p) => p.debt > 0n && p.collateral > 0n)
    .map((p) => ({
      liqPrice: Number((p.debt * 10n ** 36n * 10n ** 18n) / (p.collateral * lltv)) / 1e36,
      debt: Number(p.debt) / 10 ** debtDecimals,
    }))
    .sort((a, b) => b.liqPrice - a.liqPrice);
}

/** Seconds until a rung becomes liquidatable, if spot stays where it is. */
export function secondsUntilLiquidation(oracle: number, spot: number, liqPrice: number, twapWindowSec: number): number {
  if (oracle <= liqPrice) return 0;
  if (spot >= liqPrice) return Infinity;
  return (twapWindowSec * (oracle - liqPrice)) / (oracle - spot);
}

export function assessRisk(
  ladder: Rung[],
  oracle: number,
  spot: number,
  twapWindowSec: number,
  reactionSec: number,
  minDebtUsd = 100_000
): RiskAssessment {
  const gapBps = ((oracle - spot) / oracle) * 10_000;

  let earliest = Infinity;
  let debtAtRisk = 0;
  let highestThreatenedLiq = 0;

  for (const r of ladder) {
    const t = secondsUntilLiquidation(oracle, spot, r.liqPrice, twapWindowSec);
    if (r.debt >= minDebtUsd) earliest = Math.min(earliest, t);
    if (t <= reactionSec) debtAtRisk += r.debt;
    if (t < Infinity && r.debt >= minDebtUsd) highestThreatenedLiq = Math.max(highestThreatenedLiq, r.liqPrice);
  }

  const targetSpot = highestThreatenedLiq > 0 ? highestThreatenedLiq * 1.0005 : spot;

  return { gapBps, earliestDeadlineSec: earliest, debtAtRiskInWindow: debtAtRisk, targetSpot };
}
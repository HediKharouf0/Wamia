import raw from "../data/measurements.json";

export type MakerRun = {
  run: string;
  sourceDir: string;
  shippedSy: number;
  syUsed: number;
  discountMaxBps: number;
  latencyBlocks: number;
  attacker: string;
  extraAttackSy: number;
  guards: boolean;
  fills: number;
  oracleMin: number;
  spotMin: number;
  eligibleDebtUsd: number;
  eligiblePositions: number;
  lpHoldToMaturityAnnualized: number | null;
  lpAvgPaidUsdPerPt: number | null;
};

export type CollapseCase = {
  case: string;
  bought: boolean;
  reason: string;
  spot: number;
  fair: number;
};

export type TakerRun = {
  key: string;
  sourceDir: string;
  capital: number;
  spentSy: number;
  peakDebtAtRisk: number;
  oracleMin: number;
  buys: number;
};

export type Measurements = {
  meta: {
    repoBase: string;
    forkBlock: number;
    market: string;
    contracts: {
      pendleMarket: string;
      pendlePt: string;
      pendleSy: string;
      morphoBlue: string;
      morphoUsdcMarket: string;
      morphoUsdtMarket: string;
      curvePool: string;
      aquaRouter: string;
      manipulatorWallet: string;
    };
  };
  makerSweep: MakerRun[];
  collapseScenarios: CollapseCase[];
  takerComparison: TakerRun[];
  yieldModel: { refYield: number; tauAtAttack: number; expiry: number; sanityCheck: number };
};

export const measurements = raw as unknown as Measurements;
export const repoBase = measurements.meta.repoBase;

export const usd = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

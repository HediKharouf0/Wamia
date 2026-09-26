import raw from "../data/replay.json";

export type Point = {
  t: number;
  block: number;
  spot: number;
  oracle: number;
  fair: number;
  debtAtRisk: number;
  liquidatable: number[];
  syLeft: number;
};

export type ReplayEvent =
  | { t: number; kind: "push" | "trade"; label: string; tx: string; block: number; spot: number }
  | { t: number; kind: "fill"; block: number; ptBought: number; syPaid: number; price: number; spotBefore: number; spotAfter: number; searcherProfitPt: number }
  | { t: number; kind: "liquidatable"; position: number; debtUsd: number };

export type Run = {
  key: string;
  title: string;
  shippedSy: number;
  guards: boolean;
  points: Point[];
  events: ReplayEvent[];
  summary: {
    peakDebtAtRisk: number;
    oracleMin: number;
    spotMin: number;
    syUsed: number;
    fills: number;
    lpAnnualized: number | null;
    lpAvgPrice: number | null;
    searcherProfitPt: number;
  };
};

export type Position = { id: string; market: string; user: string; debtUsd: number; collateralPt: number; liqPrice: number };

export const replay = raw as unknown as {
  meta: { market: string; forkBlock: number; startTimestamp: number; lltv: number; refYield: number; duration: number; source: string };
  positions: Position[];
  runs: Run[];
};

export const runByKey = (key: string) => replay.runs.find((r) => r.key === key)!;

/** Last point at or before t (prices move block by block). */
export function stateAt(run: Run, t: number): Point {
  let lo = 0;
  let hi = run.points.length - 1;
  if (t <= run.points[0]!.t) return run.points[0]!;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (run.points[mid]!.t <= t) lo = mid;
    else hi = mid - 1;
  }
  return run.points[lo]!;
}

/** The oracle is a time average, so between two measurements it moves smoothly. */
export function oracleAt(run: Run, t: number): number {
  const pts = run.points;
  if (t <= pts[0]!.t) return pts[0]!.oracle;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (t <= b.t) return b.t === a.t ? b.oracle : a.oracle + ((b.oracle - a.oracle) * (t - a.t)) / (b.t - a.t);
  }
  return pts[pts.length - 1]!.oracle;
}

export const usdM = (x: number) => `$${(x / 1e6).toFixed(2)}M`;
export const fmtInt = (x: number) => Math.round(x).toLocaleString("en-US");
export const clock = (t: number) => {
  // Wall-clock time on Aug 25, 2026 (UTC) for a replay offset.
  const d = new Date((replay.meta.startTimestamp + t) * 1000);
  return d.toISOString().slice(11, 19);
};
export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

import { measurements, repoBase, usd } from "./data";
import { GhLink, VerificationDrawer } from "./VerificationDrawer";

const LABELS: Record<string, string> = { baseline: "No capital", "2M": "$2M taker", "5M": "$5M taker" };

/** Simple bar chart: peak debt at risk per capital level, drawn to scale, teal for the Wamia figure elsewhere. */
function DebtBars() {
  const rows = measurements.takerComparison;
  const max = Math.max(...rows.map((r) => r.peakDebtAtRisk));
  const w = 640;
  const h = 40 * rows.length;
  const barX = 190;
  const barMaxW = w - barX - 70;
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="Peak debt at risk by taker capital">
      {rows.map((r, i) => {
        const bw = max > 0 ? (r.peakDebtAtRisk / max) * barMaxW : 0;
        const y = i * 40 + 8;
        return (
          <g key={r.key}>
            <text x={0} y={y + 15} fontSize="12">
              {LABELS[r.key] ?? r.key}
            </text>
            <rect x={barX} y={y} width={barMaxW} height="22" fill="var(--panel-2, #19223a)" />
            <rect x={barX} y={y} width={Math.max(bw, 2)} height="22" fill="#c98500" />
            <text x={barX + barMaxW + 8} y={y + 15} fontSize="12" fill="var(--ink,#e8ebf4)">
              {usd(r.peakDebtAtRisk)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function TakerComparison() {
  const rows = measurements.takerComparison;
  const wamiaRun = measurements.makerSweep.find((r) => r.run === "5M-L1-adaptive-dmax30-guards");
  return (
    <div className="landing-section" id="taker-comparison">
      <div className="section-head">
        <span className="eyebrow-teal">// CAPITAL ALONE VS. THE PROTOCOL</span>
        <h2>What Capital Alone Can't Do</h2>
        <p>
          Same replay, no Wamia contracts: a wallet with capital watches the lending liquidation ladder and buys
          discounted PT directly on Pendle whenever the risk model says to, sized by the same average-price target
          the real strategy uses. Even $5M of capital only gets partway there — Wamia's 1inch SwapVM standing bid gets the
          debt at risk to $0 with the same 5M SY.
        </p>
      </div>
      <div className="panel" style={{ padding: "16px 16px 8px" }}>
        <DebtBars />
      </div>
      <div className="section-actions">
        <span className="muted" style={{ fontSize: 12 }}>
          Wamia, {wamiaRun ? usd(wamiaRun.eligibleDebtUsd) : "$0"} at risk with the same 5M SY, backstop contracts shipped.
        </span>
        <GhLink repoBase={repoBase} path="results/scenario-taker-5M-L1" label="View on GitHub" />
      </div>
      <VerificationDrawer
        columns={[
          {
            heading: "Per-run source",
            lines: rows.map((r) => ({ k: LABELS[r.key] ?? r.key, v: `results/${r.sourceDir}` })),
          },
          {
            heading: "What's being compared",
            lines: [
              { k: "Fork block", v: String(measurements.meta.forkBlock) },
              { k: "Risk model", v: "src/strategies/riskModel.ts + sizing.ts" },
            ],
          },
        ]}
      />
    </div>
  );
}

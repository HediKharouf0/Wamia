import { measurements, repoBase, usd } from "./data";
import { GhLink } from "./VerificationDrawer";

export function Hero() {
  const none = measurements.makerSweep.find((r) => r.run === "0M-L1-adaptive-dmax30")!;
  const guarded = measurements.makerSweep.find((r) => r.run === "5M-L1-adaptive-dmax30-guards")!;
  return (
    <div className="hero">
      <div className="kicker">
        <span className="led" />
        <span style={{ fontSize: 12, fontWeight: 600 }}>A standing yield strategy that also protects Morpho debt</span>
      </div>
      <h1>
        Get paid to keep <span className="accent">Morpho borrowers</span> solvent
      </h1>
      <p className="lede">
        Commit SY into a standing on-chain bid and earn an annualized return every time the market needs it — while
        the same capital absorbs manipulation dumps in the very next block, replayed against a real mainnet attack,
        not a simulation of one.
      </p>
      <div className="ctas">
        <a className="btn primary" href="#yield-model">
          See the return
        </a>
        <GhLink repoBase={repoBase} path="" label="Foundry & TS tests" />
      </div>
      <div className="badge-grid">
        <div className="badge">
          <div className="k">Measured LP annualized return</div>
          <div className="v accent">{(guarded.lpHoldToMaturityAnnualized! * 100).toFixed(1)}%</div>
          <div className="d">hold-to-maturity yield, 5M SY committed</div>
        </div>
        <div className="badge">
          <div className="k">Morpho debt protected</div>
          <div className="v">{usd(none.eligibleDebtUsd)}</div>
          <div className="d">at risk with no backstop, $0 with it</div>
        </div>
      </div>
    </div>
  );
}

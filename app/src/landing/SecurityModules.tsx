import { measurements, repoBase } from "./data";
import { GhLink } from "./VerificationDrawer";

const MODULES = [
  {
    tag: "WamiaQuoter",
    title: "Maturity guard",
    blurb: "Refuses any fill at or beyond the PT's maturity timestamp.",
    code: 'require(block.timestamp < expiry, MarketExpired(expiry));',
  },
  {
    tag: "WamiaRateGuard",
    title: "NAV run guard",
    blurb: "Reads the Curve EMA rate; if it's fallen below the last high-water mark by more than the allowed drop, every fill halts.",
    code: 'require(rate * BPS >= mark * (BPS - p.maxDropBps), RateBelowHighWaterMark(rate, mark));',
  },
  {
    tag: "WamiaQuoter",
    title: "News vs. push filter",
    blurb: "Refuses a fill if Pendle's spot sits further below fair value than the configured deviation — a real repricing, not a manipulated dump.",
    code: 'require(spotWad * BPS >= fairWad * (BPS - p.maxDeviationBps), SpotTooFarBelowFair(spotWad, fairWad));',
  },
  {
    tag: "WamiaSpendLimit",
    title: "Per-block spend cap",
    blurb: "Strict rolling-window budget: at most a configured share of the shipped SY can be spent before the window resets.",
    code: 'require(spent <= cap, SpendLimitExceeded(spent, cap));',
  },
];

export function SecurityModules() {
  return (
    <div className="landing-section" id="extruction-specs">
      <div className="section-head">
        <span className="eyebrow-teal">// VERIFICATION MATRIX</span>
        <h2>Extruction Specifications &amp; Security</h2>
        <p>SwapVM order constraints, quoted verbatim from the contracts — every line below is a real require/error in the codebase, not paraphrased.</p>
      </div>
      <div className="module-grid">
        {MODULES.map((m) => (
          <div className="panel module-card" key={m.title}>
            <span className="tag">// {m.tag}</span>
            <h4>{m.title}</h4>
            <p>{m.blurb}</p>
            <code>{m.code}</code>
          </div>
        ))}
      </div>
      <div className="section-actions">
        <span className="muted" style={{ fontSize: 12 }}>
          22 Foundry tests cover WamiaQuoter alone (fuzz + unit), 65 tests pass across the full contract suite.
        </span>
        <GhLink repoBase={repoBase} path="contracts/test" label="View tests on GitHub" />
      </div>
    </div>
  );
}

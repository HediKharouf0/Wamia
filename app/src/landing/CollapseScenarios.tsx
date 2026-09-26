import { measurements, repoBase } from "./data";
import { GhLink, VerificationDrawer } from "./VerificationDrawer";

const CASE_COPY: Record<string, { title: string; blurb: string }> = {
  control: { title: "Control", blurb: "The attack's first 7 pushes, nothing else wrong." },
  switchoff: { title: "Switch-off attempt", blurb: "Attacker dumps reUSD on Curve to fake a depeg, then pushes." },
  run: { title: "Genuine run", blurb: "reUSD really depegged and stayed down for minutes before the pushes." },
  loss: { title: "Vault loss", blurb: "reUSD's NAV oracle reports a real 5% loss before the pushes." },
  jump: { title: "News repricing", blurb: "Pendle's market is 6% below fair before any arb can react." },
};

export function CollapseScenarios() {
  const cases = measurements.collapseScenarios;
  return (
    <div className="landing-section" id="collapse-scenarios">
      <div className="section-head">
        <span className="eyebrow-teal">// SPEC 7.6 STEP 6 — NEWS VS. MANIPULATION</span>
        <h2>Does It Buy On Real Bad News?</h2>
        <p>
          A backstop that buys every dip is a bug, not a feature, the moment the dip is real. Five fork cases check
          Wamia refuses to buy when the price drop is genuine news rather than a manipulated push — same demo
          strategy (5M SY, 10–30 bp discount) as the replay above.
        </p>
      </div>
      <div className="module-grid" style={{ gridTemplateColumns: "repeat(5, 1fr)" }}>
        {cases.map((c) => {
          const copy = CASE_COPY[c.case] ?? { title: c.case, blurb: "" };
          return (
            <div className="module-card" key={c.case} style={{ borderColor: c.bought ? "var(--line)" : "var(--teal)" }}>
              <span className="tag" style={{ color: c.bought ? "var(--ink-3)" : "var(--teal)" }}>
                {c.bought ? "BOUGHT" : "REFUSED"}
              </span>
              <h4>{copy.title}</h4>
              <p>{copy.blurb}</p>
              {!c.bought && <code>{c.reason}</code>}
            </div>
          );
        })}
      </div>
      <div className="section-actions">
        <span className="muted" style={{ fontSize: 12 }}>
          Control and switch-off both size the same real arb; the other three refuse outright rather than buying into a
          real collapse.
        </span>
        <GhLink repoBase={repoBase} path="results/collapse-scenarios" label="View on GitHub" />
      </div>
      <VerificationDrawer
        columns={[
          {
            heading: "Guard contracts",
            lines: [
              { k: "WamiaRateGuard", v: "NAV & Curve EMA floor" },
              { k: "WamiaQuoter", v: "SpotTooFarBelowFair check" },
            ],
          },
          {
            heading: "Reference addresses",
            lines: [
              { k: "Curve reUSD/USDC pool", v: measurements.meta.contracts.curvePool },
              { k: "Lending oracle", v: measurements.meta.contracts.morphoUsdcMarket },
            ],
          },
        ]}
      />
    </div>
  );
}

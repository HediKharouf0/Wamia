import { useMemo, useState } from "react";
import { measurements, repoBase } from "./data";
import { GhLink, VerificationDrawer } from "./VerificationDrawer";

// Real measured curve: avg price an LP paid for PT during the Aug 25 replay, at each capital level
// shipped (same discount range, same attacker, same latency) — results/maker-results.json.
const CURVE = measurements.makerSweep
  .filter((r) => !r.guards && r.discountMaxBps === 30 && r.attacker === "adaptive" && r.latencyBlocks === 1 && r.extraAttackSy === 0 && r.lpAvgPaidUsdPerPt)
  .map((r) => ({ sy: r.shippedSy, price: r.lpAvgPaidUsdPerPt! }))
  .sort((a, b) => a.sy - b.sy);

function avgPriceForCapital(sy: number): number {
  if (sy <= CURVE[0]!.sy) return CURVE[0]!.price;
  if (sy >= CURVE[CURVE.length - 1]!.sy) return CURVE[CURVE.length - 1]!.price;
  for (let i = 1; i < CURVE.length; i++) {
    const a = CURVE[i - 1]!;
    const b = CURVE[i]!;
    if (sy <= b.sy) {
      const t = (sy - a.sy) / (b.sy - a.sy);
      return a.price + t * (b.price - a.price);
    }
  }
  return CURVE[CURVE.length - 1]!.price;
}

function yieldFromPtPrice(ptPrice: number, tau: number): number {
  return Math.pow(1 / ptPrice, 1 / tau) - 1;
}

export function YieldCalculator() {
  const { refYield, tauAtAttack } = measurements.yieldModel;
  const [capital, setCapital] = useState(5_000_000);
  const [events, setEvents] = useState(1);

  const { avgPrice, eventApy, netApy, bump } = useMemo(() => {
    const avgPrice = avgPriceForCapital(capital);
    const eventApy = yieldFromPtPrice(avgPrice, tauAtAttack);
    const bump = Math.max(0, eventApy - refYield);
    const netApy = refYield + events * bump;
    return { avgPrice, eventApy, netApy, bump };
  }, [capital, events, tauAtAttack, refYield]);

  return (
    <div className="landing-section" id="yield-model">
      <div className="section-head">
        <span className="eyebrow-teal">// GROUNDED IN THE ACTUAL REPLAY, NOT A MODEL</span>
        <h2>What An LP Actually Earned</h2>
        <p>
          This isn't a fitted curve — <code>avgPriceForCapital()</code> interpolates the real average price paid per
          PT at each capital level from the maker sweep, then <code>yieldFromPtPrice()</code> (the same inverse of{" "}
          <code>P = 1/(1+y)^τ</code> the pricing engine itself uses) recovers the annualized yield to maturity that
          price implies. One event/year reproduces the measured 11.3% at 5M SY exactly. More events/year is an
          explicit assumption you control, not a measurement — each additional Aug-25-scale event is assumed to add
          the same yield bump, since Aqua capital never leaves your wallet between events.
        </p>
      </div>
      <div className="apy-calc">
        <div className="panel apy-controls">
          <div className="apy-field">
            <div className="row">
              <span>SY Committed</span>
              <span className="val">${capital.toLocaleString()}</span>
            </div>
            <input
              type="range"
              min={3000000}
              max={6000000}
              step={100000}
              value={capital}
              onChange={(e) => setCapital(Number(e.target.value))}
            />
            <div className="range-labels">
              <span>$3M</span>
              <span>$5M (measured)</span>
              <span>$6M</span>
            </div>
          </div>
          <div className="apy-field">
            <div className="row">
              <span>Aug-25-scale events / year</span>
              <span className="val">{events}</span>
            </div>
            <input type="range" min={1} max={8} step={1} value={events} onChange={(e) => setEvents(Number(e.target.value))} />
            <div className="range-labels">
              <span>1 (what actually happened)</span>
              <span>8</span>
            </div>
          </div>
          <div className="section-actions">
            <span className="muted" style={{ fontSize: 12 }}>
              Avg price paid at this capital: {avgPrice.toFixed(4)} USD/PT
            </span>
            <GhLink repoBase={repoBase} path="src/app/buildMeasurementsData.ts" label="View model on GitHub" />
          </div>
        </div>
        <div className="panel apy-output">
          <div>
            <div className="headline-eyebrow">Projected annualized return</div>
            <div className="big-apy">{(netApy * 100).toFixed(2)}%</div>
            <div className="compose">
              <b>{(refYield * 100).toFixed(2)}%</b> base yield-to-maturity + <b>{(bump * 100 * events).toFixed(2)}%</b>{" "}
              from catching the discount, {events}× this event's size.
            </div>
          </div>
          <div className="breakdown">
            <div className="row">
              <span className="muted">Single-event yield (measured formula)</span>
              <span className="mono">{(eventApy * 100).toFixed(2)}%</span>
            </div>
            <div className="row">
              <span className="muted">Years to maturity at the attack</span>
              <span className="mono">{tauAtAttack.toFixed(3)}</span>
            </div>
          </div>
          <div className="note-box">
            Base yield and the price-vs-capital curve are both real, measured values from{" "}
            <code>results/maker-results.json</code>. The event-frequency multiplier is a projection you set — treat it
            as a scenario, not a guarantee.
          </div>
        </div>
      </div>
      <VerificationDrawer
        title="Inspection & verification: the real data points behind this curve"
        columns={[
          {
            heading: "Measured (capital → avg price paid)",
            lines: CURVE.map((c) => ({ k: `${(c.sy / 1_000_000).toFixed(0)}M SY`, v: c.price.toFixed(4) })),
          },
          {
            heading: "Formula",
            lines: [
              { k: "Price model", v: "P = 1 / (1+y)^τ" },
              { k: "Source", v: "src/pricing/fairValue.ts" },
            ],
          },
        ]}
      />
    </div>
  );
}

import { explainRevert, fmt, short, useAction, useLiveState, type LiveState } from "./api";
import { ActivityLog } from "./LpConsole";
import { ChainBadge, Offline, Rolling, Toast } from "../ui";

type Sample = LiveState["history"][number];

function PriceTrio({ hist, state }: { hist: Sample[]; state: LiveState }) {
  const W = 820;
  const H = 220;
  const M = { l: 46, r: 12, t: 10, b: 18 };
  const vals = hist.flatMap((s) => [s.spot, s.fair, ...(s.oracle !== null ? [s.oracle] : [])]);
  const lo = Math.min(...vals, state.market.spot) - 0.002;
  const hi = Math.max(...vals, state.market.fair) + 0.002;
  const n = Math.max(hist.length - 1, 1);
  const x = (i: number) => M.l + (i / n) * (W - M.l - M.r);
  const y = (v: number) => M.t + ((hi - v) / (hi - lo)) * (H - M.t - M.b);
  const path = (k: "spot" | "fair" | "oracle") =>
    hist
      .map((s, i) => (s[k] === null ? null : `${i ? "L" : "M"}${x(i).toFixed(1)},${y(s[k] as number).toFixed(1)}`))
      .filter(Boolean)
      .join("");
  const gapBp = ((state.market.fair - state.market.spot) / state.market.fair) * 1e4;
  const m = state.market;
  return (
    <section className="panel card">
      <div className="side-head">
        <h3>Fair value vs Pendle vs the lending oracle</h3>
        <span className={`pill ${gapBp > 450 ? "bad" : gapBp > 100 ? "warn" : "good"}`}>
          <span className="led" />
          Pendle {gapBp >= 0 ? `${gapBp.toFixed(0)} bp below` : `${(-gapBp).toFixed(0)} bp above`} fair
        </span>
      </div>
      <div className="split" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
        <div className="stat"><div className="v"><Rolling value={m.fair} digits={4} /></div><div className="k">fair value at 10.58%</div></div>
        <div className="stat"><div className="v" style={{ color: "var(--spot)" }}><Rolling value={m.spot} digits={4} /></div><div className="k">Pendle spot</div></div>
        <div className="stat">
          <div className="v" style={{ color: "var(--oracle)" }}>{m.morpho ? <Rolling value={m.morpho.oracle} digits={4} /> : "n/a"}</div>
          <div className="k">{m.morpho ? "Morpho oracle (TWAP)" : "no lending market on the local chain"}</div>
        </div>
      </div>
      {hist.length > 1 ? (
        <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Prices over the last blocks">
          {[lo + (hi - lo) * 0.2, (lo + hi) / 2, hi - (hi - lo) * 0.2].map((v) => (
            <g key={v}>
              <line x1={M.l} x2={W - M.r} y1={y(v)} y2={y(v)} stroke="var(--grid)" />
              <text x={M.l - 6} y={y(v) + 4} textAnchor="end">{v.toFixed(4)}</text>
            </g>
          ))}
          <path d={path("fair")} fill="none" stroke="var(--fair)" strokeDasharray="4 4" strokeWidth={1.5} />
          <path d={path("spot")} fill="none" stroke="var(--spot)" strokeWidth={2} />
          {m.morpho && <path d={path("oracle")} fill="none" stroke="var(--oracle)" strokeWidth={2.5} />}
          {m.morpho && <line x1={M.l} x2={W - M.r} y1={y(m.morpho.firstLiqPrice)} y2={y(m.morpho.firstLiqPrice)} stroke="var(--critical)" strokeDasharray="5 4" />}
          <text x={W - M.r} y={H - 4} textAnchor="end">last {hist.length} blocks</text>
        </svg>
      ) : (
        <div className="muted" style={{ fontSize: 12 }}>The chart fills in as actions add blocks.</div>
      )}
    </section>
  );
}

function Protection({ state }: { state: LiveState }) {
  const capUsd = state.lp.realSy * state.lp.syRate;
  const mo = state.market.morpho;
  const need = mo ? mo.within3pct : 0;
  const scale = Math.max(capUsd, need, 1) * 1.1;
  return (
    <section className="panel card">
      <h3>Is it protected?</h3>
      {mo ? (
        <p style={{ margin: 0, fontSize: 15 }}>
          Wamia can absorb <b>${fmt(capUsd / 1e6, 2)}M</b> of PT sales. <b>${fmt(need / 1e6, 2)}M</b> of debt sits within 3% of liquidation, and{" "}
          <b style={{ color: mo.liquidatableDebt > 0 ? "#ff9a9a" : "inherit" }}>${fmt(mo.liquidatableDebt / 1e6, 2)}M</b> is liquidatable now.
        </p>
      ) : (
        <p style={{ margin: 0, fontSize: 15 }}>
          Wamia can absorb <b>${fmt(capUsd / 1e6, 2)}M</b> of PT sales. The local chain has no Morpho, so debt at risk is only shown on the fork.
        </p>
      )}
      <div className="gauge" aria-hidden>
        <div className="cap" style={{ width: `${(100 * capUsd) / scale}%` }} />
        {mo && <div className="need" style={{ left: `${(100 * need) / scale}%` }} />}
      </div>
      <div className="legend">
        <span><i style={{ background: "var(--wamia)", height: 8 }} />real backstop capacity, at NAV</span>
        {mo && <span><i style={{ background: "var(--ink)", width: 2, height: 10 }} />debt within 3% of liquidation</span>}
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        The two numbers aren't the same unit of risk: on Aug 25, 4.6M SY of fills kept $37.35M of loans safe, because the backstop only has to hold the price, not buy the
        collateral. The replay tab shows it block by block.
      </p>
    </section>
  );
}

function Rules({ state, run, busy }: { state: LiveState; run: (l: string, p: string, b: unknown, d?: string) => Promise<void>; busy: boolean }) {
  const refuses = state.market.verdict !== "accepts";
  const fork = state.chain.mode === "fork";
  return (
    <section className="panel card">
      <div className="side-head">
        <h3>Safety rules</h3>
        <span className={`pill ${refuses ? "bad" : "good"}`}>
          <span className="led" />
          {refuses ? "Wamia steps aside" : "Wamia is buying"}
        </span>
      </div>
      <div className="rules">
        {state.market.rules.map((r) => (
          <div key={r.id} className={`rule ${r.ok ? "" : "bad"}`}>
            <div>
              <div className="name">{r.name}</div>
              <div className="detail">{r.detail}</div>
            </div>
            <span className={`pill ${r.ok ? "good" : "bad"}`}>
              <span className="led" />
              {r.ok ? "ok" : "stop"}
            </span>
          </div>
        ))}
      </div>
      {refuses && <div className="muted" style={{ fontSize: 13 }}>The quoter refuses: {explainRevert(state.market.verdict)}.</div>}
      <div className="eyebrow" style={{ marginTop: 4 }}>Try a real collapse</div>
      <div className="row-actions">
        <button className="btn" disabled={busy || !!state.chain.scenario || fork} title={fork ? "Needs 20 minutes of Curve trading; run npm run scenario:collapse -- run" : ""} onClick={() => run("Scenario", "scenario", { name: "run" })}>
          Run on reUSD
        </button>
        <button className="btn" disabled={busy || !!state.chain.scenario} onClick={() => run("Scenario", "scenario", { name: "loss" })}>
          Vault loss (−5%)
        </button>
        <button className="btn" disabled={busy || !!state.chain.scenario} onClick={() => run("Scenario", "scenario", { name: "repricing" })}>
          News repricing (−6%)
        </button>
        <button className="btn" disabled={busy || !state.chain.scenario} onClick={() => run("Undo", "scenario", { name: "restore" })}>
          Undo
        </button>
      </div>
      {state.chain.scenario && (
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          Now push the market from the “Protect a market” tab or with the button below: the searcher finds no arb, because Wamia refuses to buy.
        </p>
      )}
      <button className="btn primary" disabled={busy} onClick={() => run("Pushing", "push", { sy: 100_000 })}>
        Push the market (100k SY of YT)
      </button>
    </section>
  );
}

function Borrowers({ state }: { state: LiveState }) {
  const mo = state.market.morpho;
  if (!mo) return null;
  return (
    <section className="panel card">
      <div className="side-head">
        <h3>Closest to liquidation</h3>
        <span className="muted" style={{ fontSize: 12 }}>health factor, 1.00 = liquidatable</span>
      </div>
      <div className="poslist">
        {mo.positions.map((p) => {
          const hf = Math.min(p.healthFactor, 1.2);
          const w = Math.max(0, Math.min(100, ((hf - 0.95) / 0.25) * 100));
          const color = p.liquidatable ? "var(--critical)" : p.healthFactor < 1.03 ? "var(--warning)" : "var(--good)";
          return (
            <div className="pos" key={`${p.market}${p.user}`} title={`liquidatable below ${p.liqPrice.toFixed(4)}`}>
              <span className="mono">{short(p.user)} <span className="muted">{p.market}</span></span>
              <div className="hf"><div style={{ width: `${w}%`, background: color }} /></div>
              <span className="mono" style={{ textAlign: "right" }}>${fmt(p.debt / 1e6, 2)}M · {p.healthFactor.toFixed(3)}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function Monitor() {
  const { state, error, refresh } = useLiveState(1200);
  const { run, pending, toast } = useAction(refresh);
  const hist = state?.history ?? [];
  if (error && !state) return <Offline error={error} />;
  if (!state) return <div className="banner">Connecting to the app server…</div>;
  const busy = pending !== null || !!state.chain.busy;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="headline">
        <div>
          <div className="eyebrow">For curators and lenders</div>
          <h2>Is PT-reUSD protected right now?</h2>
        </div>
        <ChainBadge mode={state.chain.mode} block={state.chain.block} busy={pending ?? state.chain.busy} />
      </div>
      <div className="live-grid" style={{ gridTemplateColumns: "1fr 400px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          <PriceTrio hist={hist} state={state} />
          <Protection state={state} />
          <Borrowers state={state} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          <Rules state={state} run={run} busy={busy} />
          <ActivityLog state={state} />
        </div>
      </div>
      <Toast toast={toast} />
    </div>
  );
}

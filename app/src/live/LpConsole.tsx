import { useEffect, useMemo, useState } from "react";
import { fmt, get, short, useAction, useLiveState, type LiveState, type StrategyView } from "./api";
import { ChainBadge, Offline, Rolling, Toast, useFlash } from "../ui";

type Ladder = { fair: number; spot: number; points: { usedSy: number; bid: number }[] };

function LadderChart({ ladder, size }: { ladder: Ladder; size: number }) {
  const W = 340;
  const H = 180;
  const M = { l: 44, r: 10, t: 10, b: 24 };
  const vals = [...ladder.points.map((p) => p.bid), ladder.fair, ladder.spot];
  const lo = Math.min(...vals) - 0.001;
  const hi = Math.max(...vals) + 0.001;
  const x = (u: number) => M.l + (u / size) * (W - M.l - M.r);
  const y = (v: number) => M.t + ((hi - v) / (hi - lo)) * (H - M.t - M.b);
  const d = ladder.points.map((p, i) => `${i ? "L" : "M"}${x(p.usedSy).toFixed(1)},${y(p.bid).toFixed(1)}`).join("");
  const area = `${d}L${x(size)},${H - M.b}L${x(0)},${H - M.b}Z`;
  const ticks = [lo + (hi - lo) * 0.15, (lo + hi) / 2, hi - (hi - lo) * 0.15];
  const [hover, setHover] = useState<number | null>(null);
  const hp = hover === null ? null : ladder.points[hover];
  return (
    <div className="chart-wrap">
      <svg
        className="chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Bid ladder: price Wamia pays per PT as the backstop is used"
        onPointerMove={(e) => {
          const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const u = (((e.clientX - box.left) / box.width) * W - M.l) / (W - M.l - M.r);
          setHover(u < 0 || u > 1 ? null : Math.round(u * 20));
        }}
        onPointerLeave={() => setHover(null)}
      >
        {ticks.map((v) => (
          <g key={v}>
            <line x1={M.l} x2={W - M.r} y1={y(v)} y2={y(v)} stroke="var(--grid)" />
            <text x={M.l - 6} y={y(v) + 4} textAnchor="end">{v.toFixed(4)}</text>
          </g>
        ))}
        {[0, 0.5, 1].map((f) => (
          <text key={f} x={x(size * f)} y={H - 6} textAnchor={f === 0 ? "start" : f === 1 ? "end" : "middle"}>
            {fmt((size * f) / 1e6, 1)}M SY
          </text>
        ))}
        <line x1={M.l} x2={W - M.r} y1={y(ladder.fair)} y2={y(ladder.fair)} stroke="var(--fair)" strokeDasharray="4 4" opacity={0.8} />
        <line x1={M.l} x2={W - M.r} y1={y(ladder.spot)} y2={y(ladder.spot)} stroke="var(--spot)" strokeWidth={1.5} />
        <path d={area} fill="var(--wamia-soft)" />
        <path d={d} fill="none" stroke="var(--wamia)" strokeWidth={2} />
        {hp && (
          <>
            <line x1={x(hp.usedSy)} x2={x(hp.usedSy)} y1={M.t} y2={H - M.b} stroke="var(--ink-2)" />
            <circle cx={x(hp.usedSy)} cy={y(hp.bid)} r={4} fill="var(--wamia)" stroke="var(--panel)" strokeWidth={2} />
          </>
        )}
      </svg>
      {hp && (
        <div className="tooltip" style={{ left: `${Math.min(55, (x(hp.usedSy) / W) * 100)}%`, top: 4 }}>
          <div className="row"><span>After {fmt(hp.usedSy)} SY used</span></div>
          <div className="row"><span>Wamia pays</span><span className="mono">{hp.bid.toFixed(4)}</span></div>
          <div className="row"><span>Discount to fair</span><span className="mono">{(((ladder.fair - hp.bid) / ladder.fair) * 1e4).toFixed(1)} bp</span></div>
        </div>
      )}
      <div className="legend" style={{ marginTop: 6 }}>
        <span><i style={{ background: "var(--wamia)" }} />Wamia bid</span>
        <span><i className="dash" />Fair value</span>
        <span><i style={{ background: "var(--spot)" }} />Pendle now</span>
      </div>
    </div>
  );
}

function StrategyRow({ s, onDock, onInspect, busy }: { s: StrategyView; onDock: () => void; onInspect: () => void; busy: boolean }) {
  const pct = s.shippedSy ? (100 * s.syLeft) / s.shippedSy : 0;
  const fills = s.fills.length;
  const moved = useFlash(fills);
  return (
    <div className={`strat ${s.docked ? "docked" : ""} ${moved ? "flash-move" : ""}`}>
      <div>
        <div className="mono" style={{ fontSize: 13 }}>
          {short(s.hash)} {s.guards && <span className="pill" style={{ marginLeft: 6 }}>guards</span>} {s.docked && <span className="pill" style={{ marginLeft: 6 }}>docked</span>}
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          {fmt(s.syLeft)} of {fmt(s.shippedSy)} SY left · max discount {s.discountMaxBps} bp · {fills} fill{fills === 1 ? "" : "s"}
          {s.bid !== null && <> · bids {s.bid.toFixed(4)}</>}
        </div>
      </div>
      <div className="row-actions">
        <button className="btn" onClick={onInspect}>
          Inspect
        </button>
        {!s.docked && (
          <button className="btn danger" disabled={busy} onClick={onDock}>
            Dock
          </button>
        )}
      </div>
      <div className="bar">
        <div style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function WalletVsStrategy({ s }: { s: LiveState }) {
  const lp = s.lp;
  const shippedCount = lp.strategies.filter((x) => !x.docked).length;
  const stillAfterShip = useFlash(shippedCount, 2400);
  return (
    <section className="panel card">
      <div className="side-head">
        <h3>Your SY stays in your wallet</h3>
        <span className="muted mono" style={{ fontSize: 12 }}>{short(lp.wallet)}</span>
      </div>
      <div className="wallet-vs">
        <div className={`box ${stillAfterShip ? "flash-still" : ""}`}>
          <div className="eyebrow">Wallet</div>
          <div className="big"><Rolling value={lp.walletSy} /> <span className="muted" style={{ fontSize: 14 }}>SY</span></div>
          <div className="muted" style={{ fontSize: 12 }}>
            ≈ $<Rolling value={lp.walletUsd} /> · <Rolling value={lp.walletPt} /> PT bought
          </div>
          {stillAfterShip && <span className="pill good" style={{ alignSelf: "flex-start" }}><span className="led" />unchanged by ship</span>}
        </div>
        <div className="link">
          <span className="line" />
          <span>Aqua<br />allowance</span>
          <span className="line" />
        </div>
        <div className="box">
          <div className="eyebrow">Promised to strategies</div>
          <div className="big"><Rolling value={lp.promisedSy} /> <span className="muted" style={{ fontSize: 14 }}>SY</span></div>
          <div style={{ fontSize: 12, color: lp.realSy < lp.promisedSy - 1 ? "#ffd98a" : "var(--ink-3)" }}>
            Real capacity <span className="mono"><Rolling value={lp.realSy} /></span> SY
            {lp.realSy < lp.promisedSy - 1 ? ": promised more than the wallet holds" : ""}
          </div>
        </div>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        Shipping writes a virtual balance in Aqua. SY only leaves the wallet when a trade fills, and PT arrives in the same transaction. Real capacity is the smallest of the
        promised balance, the wallet and the allowance.
      </p>
    </section>
  );
}

export function LpConsole({ onInspect }: { onInspect: (hash: string) => void }) {
  const { state, error, refresh } = useLiveState();
  const { run, pending, toast } = useAction(refresh);
  const [size, setSize] = useState(5_000_000);
  const [dmax, setDmax] = useState(30);
  const [guards, setGuards] = useState(true);
  const [pushSize, setPushSize] = useState(100_000);
  const [ladder, setLadder] = useState<Ladder | null>(null);
  const block = state?.chain.block;

  useEffect(() => {
    if (!state) return;
    const id = setTimeout(() => {
      get<Ladder>(`ladder?sy=${size}&dmax=${dmax}`).then(setLadder).catch(() => undefined);
    }, 200);
    return () => clearTimeout(id);
    // Refresh the ladder when inputs change or a new block moves fair value and spot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, dmax, block]);

  const busy = pending !== null || !!state?.chain.busy;
  const pnl = state?.lp.pnl;
  const live = useMemo(() => state?.lp.strategies.filter((s) => !s.docked) ?? [], [state]);

  if (error && !state) return <Offline error={error} />;
  if (!state) return <div className="banner">Connecting to the app server…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="headline">
        <div>
          <div className="eyebrow">Protect a market</div>
          <h2>Back a PT market with SY that keeps working in your wallet.</h2>
        </div>
        <ChainBadge mode={state.chain.mode} block={state.chain.block} busy={pending ?? state.chain.busy} />
      </div>

      <div className="live-grid">
        <section className="panel card">
          <h3>New strategy</h3>
          <div className="field">
            <label htmlFor="market">Market</label>
            <select id="market" defaultValue="pt-reusd">
              <option value="pt-reusd">PT-reUSD · Dec 10, 2026 · lent against on Morpho</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="size">SY to promise: {fmt(size)} SY (≈ ${fmt((size * state.lp.syRate) / 1e6, 2)}M)</label>
            <input id="size" className="size" type="range" min={500_000} max={10_000_000} step={250_000} value={size} onChange={(e) => setSize(Number(e.target.value))} />
          </div>
          <div className="field">
            <label>Deepest discount, when the backstop is fully used</label>
            <div className="seg" role="group" aria-label="Max discount">
              {[30, 60].map((d) => (
                <button key={d} aria-pressed={dmax === d} onClick={() => setDmax(d)}>
                  {d} bp
                </button>
              ))}
            </div>
          </div>
          <label className="check" style={{ cursor: "pointer" }}>
            <input id="guards" type="checkbox" checked={guards} onChange={(e) => setGuards(e.target.checked)} /> Add the v2 guards (rate high-water mark, 20% per block)
          </label>
          {ladder ? <LadderChart ladder={ladder} size={size} /> : <div className="muted">Loading the bid ladder…</div>}
          <div className="row-actions">
            <button className="btn" disabled={busy} onClick={() => run("Funding", "faucet", { sy: size }, `Wallet funded with ${fmt(size)} SY`)}>
              Fund wallet with {fmt(size / 1e6, 2)}M SY
            </button>
            <button
              className="btn primary"
              disabled={busy || state.lp.walletSy < 1}
              onClick={() => run("Shipping", "ship", { sy: size, discountMaxBps: dmax, guards }, "Shipped to Aqua. Check the wallet: nothing moved.")}
            >
              Ship to Aqua
            </button>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            {state.chain.mode === "fork" ? "Funding edits the SY balance on the fork (a test cheat); ship and dock are real transactions on the deployed Aqua." : "Local chain: SY is a mock you can mint."}
          </p>
        </section>

        <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          <WalletVsStrategy s={state} />

          <section className="panel card">
            <div className="side-head">
              <h3>Your strategies</h3>
              <span className="muted" style={{ fontSize: 12 }}>{live.length} live</span>
            </div>
            {state.lp.strategies.length === 0 && <div className="muted">Nothing shipped yet. Fund the wallet, then ship.</div>}
            {[...state.lp.strategies].reverse().map((s) => (
              <StrategyRow key={s.hash} s={s} busy={busy} onInspect={() => onInspect(s.hash)} onDock={() => run("Docking", "dock", { hash: s.hash }, "Docked. The strategy no longer buys.")} />
            ))}
          </section>

          <div className="split">
            <section className="panel card">
              <h3>Stress it</h3>
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                The attacker buys YT with SY, which makes Pendle sell PT. Then the searcher bot sells that PT to your strategy and buys it back on Pendle, in one transaction.
              </p>
              <div className="seg" role="group" aria-label="Push size">
                {[50_000, 100_000, 200_000].map((v) => (
                  <button key={v} aria-pressed={pushSize === v} onClick={() => setPushSize(v)}>
                    {v / 1000}k SY
                  </button>
                ))}
              </div>
              <button className="btn primary" disabled={busy} onClick={() => run("Pushing", "push", { sy: pushSize })}>
                Push the market
              </button>
            </section>
            <section className="panel card">
              <h3>Held to maturity</h3>
              <dl className="kv">
                <dt>PT bought</dt>
                <dd><Rolling value={pnl?.ptBought ?? 0} /></dd>
                <dt>Paid (USD)</dt>
                <dd><Rolling value={pnl?.paidUsd ?? 0} /></dd>
                <dt>Gain at maturity</dt>
                <dd style={{ color: (pnl?.atMaturityUsd ?? 0) > 0 ? "#8fe28f" : "var(--ink)" }}>
                  <Rolling value={pnl?.atMaturityUsd ?? 0} prefix="$" />
                </dd>
                <dt>Annualized</dt>
                <dd>{pnl?.annualized ? `${(pnl.annualized * 100).toFixed(1)}%` : "n/a"}</dd>
              </dl>
              <p className="muted" style={{ margin: 0, fontSize: 12 }}>Each PT redeems for $1 of reUSD on Dec 10.</p>
            </section>
          </div>

          <ActivityLog state={state} />
        </div>
      </div>
      <Toast toast={toast} />
    </div>
  );
}

export function ActivityLog({ state }: { state: LiveState }) {
  const items = [...state.activity].reverse();
  const color: Record<string, string> = { push: "var(--spot)", fill: "var(--wamia)", error: "var(--critical)", ship: "var(--good)", dock: "var(--ink-3)", scenario: "var(--warning)" };
  return (
    <section className="panel feed">
      <div className="eyebrow">On chain</div>
      <ol>
        {items.map((a, i) => (
          <li key={`${a.at}-${i}-${a.text.length}`}>
            <span className="when">+{Math.max(0, a.at - (state.activity[0]?.at ?? a.at))}s</span>
            <span className="mark" style={{ background: color[a.kind] ?? "var(--line)" }} />
            <span className="what">
              {a.text} {a.tx && <span className="mono muted">{short(a.tx)}</span>}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

import { useEffect, useMemo, useState } from "react";
import { useTween } from "../ui";
import { PriceChart } from "./PriceChart";
import { clock, fmtInt, replay, runByKey, shortAddr, stateAt, usdM, type Run, type ReplayEvent } from "./data";
import { GhLink, VerificationDrawer } from "../landing/VerificationDrawer";
import { measurements } from "../landing/data";

const SIZES = ["3M", "4M", "5M", "5M-guards"] as const;
const SPEEDS = [30, 60, 120];
const DUR = replay.meta.duration;

function Counter({ value, label }: { value: number; label: string }) {
  const shown = useTween(value);
  return (
    <div className="counter" aria-live="polite">
      <div className={`value ${value > 0 ? "bad" : "ok"}`}>{usdM(shown)}</div>
      <div className="label">{label}</div>
    </div>
  );
}

function Borrowers({ liquidatable }: { liquidatable: number[] }) {
  const count = liquidatable.length;
  const debtShare = replay.positions.length ? (100 * count) / replay.positions.length : 0;
  return (
    <div className="risk-gauge">
      <div className="meta">
        <span>{replay.positions.length} Morpho borrowers tracked</span>
        <span className="count" style={{ color: count ? "var(--critical)" : "var(--ink-3)" }}>
          {count} liquidatable
        </span>
      </div>
      <div className="bar">
        <div className="fill" style={{ width: `${debtShare}%` }} />
      </div>
    </div>
  );
}

function Side({ run, t, withWamia }: { run: Run; t: number; withWamia: boolean }) {
  const now = stateAt(run, t);
  const left = useTween(now.syLeft, 350);
  return (
    <section className="panel side" aria-label={run.title}>
      <div className="side-head">
        <div>
          <div className="eyebrow">{withWamia ? "With Wamia" : "Without a backstop"}</div>
          <div className="side-title">
            <span className="dot" style={{ background: withWamia ? "var(--wamia)" : "var(--ink-3)" }} />
            {withWamia ? `${run.title} shipped on Aqua` : "What happened on Aug 25"}
          </div>
        </div>
        <Counter value={now.debtAtRisk} label="debt liquidatable now" />
      </div>
      <PriceChart run={run} t={t} showFills={withWamia} />
      {withWamia ? (
        <div className="capacity">
          <div className="meta">
            <span>Backstop left</span>
            <span className="mono">
              {fmtInt(left)} / {fmtInt(run.shippedSy)} SY
            </span>
          </div>
          <div className="bar">
            <div className="fill" style={{ width: `${(100 * left) / run.shippedSy}%` }} />
          </div>
        </div>
      ) : (
        <div className="capacity">
          <div className="meta">
            <span>Backstop left</span>
            <span className="mono">none</span>
          </div>
          <div className="bar" />
        </div>
      )}
      <Borrowers liquidatable={now.liquidatable} />
    </section>
  );
}

type FeedItem = { key: string; t: number; side: "none" | "wamia" | "both"; ev: ReplayEvent };

function Feed({ items, t }: { items: FeedItem[]; t: number }) {
  // Borrowers that cross the line between the same two measurements share one line.
  const grouped: (FeedItem & { group: number[] })[] = [];
  for (const i of items.filter((x) => x.t <= t)) {
    const prev = grouped[grouped.length - 1];
    if (i.ev.kind === "liquidatable" && prev && prev.ev.kind === "liquidatable" && prev.t === i.t && prev.side === i.side) prev.group.push(i.ev.position);
    else grouped.push({ ...i, group: i.ev.kind === "liquidatable" ? [i.ev.position] : [] });
  }
  const shown = grouped.slice(-60).reverse();
  return (
    <section className="panel feed" aria-label="Event feed">
      <div className="eyebrow">Block by block</div>
      <ol>
        {shown.length === 0 && <li><span className="when">{clock(0)}</span><span /><span className="what">Waiting for the first push…</span></li>}
        {shown.map(({ key, t: et, side, ev, group }) => (
          <li key={key}>
            <span className="when">{clock(et)}</span>
            <span
              className="mark"
              style={{ background: ev.kind === "push" ? "var(--spot)" : ev.kind === "fill" ? "var(--wamia)" : "var(--critical)" }}
            />
            <span className="what">
              {ev.kind === "push" && (
                <>
                  <b>Attacker push {ev.label.replace("manip-", "#")}</b>: buys YT, Pendle sells PT, spot {ev.spot.toFixed(4)}{" "}
                  <a href={`https://etherscan.io/tx/${ev.tx}`} target="_blank" rel="noreferrer">
                    {ev.tx.slice(0, 10)}↗
                  </a>
                </>
              )}
              {ev.kind === "fill" && (
                <>
                  <b>Wamia fill</b>: bought {fmtInt(ev.ptBought)} PT for {fmtInt(ev.syPaid)} SY at {ev.price.toFixed(4)}; spot {ev.spotBefore.toFixed(4)} → {ev.spotAfter.toFixed(4)}{" "}
                  <span className="muted mono">fork block {ev.block}</span>
                </>
              )}
              {ev.kind === "liquidatable" && (
                <>
                  <b style={{ color: "#ff9a9a" }}>{side === "wamia" ? "With Wamia" : "Without Wamia (left)"}</b>:{" "}
                  {group.length === 1 ? (
                    <>
                      {shortAddr(replay.positions[ev.position]!.user)} became liquidatable, ${fmtInt(ev.debtUsd)} of {replay.positions[ev.position]!.market} debt
                    </>
                  ) : (
                    <>
                      {group.length} borrowers became liquidatable, ${fmtInt(group.reduce((a, i) => a + replay.positions[i]!.debtUsd, 0))} of debt (
                      {group.map((i) => shortAddr(replay.positions[i]!.user)).join(", ")})
                    </>
                  )}
                </>
              )}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Results({ none, run }: { none: Run; run: Run }) {
  const s = run.summary;
  return (
    <section className="panel results" aria-label="Results">
      <h3>End of the replay</h3>
      <div className="stat">
        <div className="v">{usdM(none.summary.peakDebtAtRisk)}</div>
        <div className="k">debt liquidatable, no backstop</div>
      </div>
      <div className="stat">
        <div className="v" style={{ color: s.peakDebtAtRisk ? "#ff9a9a" : "var(--ink)" }}>{usdM(s.peakDebtAtRisk)}</div>
        <div className="k">with Wamia, {run.title}</div>
      </div>
      <div className="stat">
        <div className="v">
          {none.summary.oracleMin.toFixed(4)} → {s.oracleMin.toFixed(4)}
        </div>
        <div className="k">lowest Morpho oracle price</div>
      </div>
      <div className="stat">
        <div className="v">{fmtInt(s.syUsed)} SY</div>
        <div className="k">backstop used, in {s.fills} fills</div>
      </div>
      <div className="stat">
        <div className="v">{s.lpAnnualized ? `${(s.lpAnnualized * 100).toFixed(1)}%` : "n/a"}</div>
        <div className="k">LP return held to maturity, annualized (avg price {s.lpAvgPrice?.toFixed(4)})</div>
      </div>
      <div className="stat">
        <div className="v">{fmtInt(s.searcherProfitPt)} PT</div>
        <div className="k">searcher profit, with zero capital</div>
      </div>
      <p className="note">
        Mainnet fork at block {replay.meta.forkBlock}. The attacker's 11 pushes are replayed with fresh slippage bounds; the searcher's arb lands one block after each push.
        Historical liquidations are skipped so the debt that could be liquidated is measured, not executed.
      </p>
      <div className="section-actions" style={{ gridColumn: "1 / -1" }}>
        <span className="muted" style={{ fontSize: 12 }}>
          Measured in {none.sourceDir} (no backstop) and {run.sourceDir} ({run.title}).
        </span>
        <GhLink repoBase={replay.meta.repoBase} path={`results/${run.sourceDir}`} label="View on GitHub" />
      </div>
      <div style={{ gridColumn: "1 / -1" }}>
        <VerificationDrawer
          columns={[
            {
              heading: "Target contracts",
              lines: [
                { k: "PT-reUSD (Pendle PT)", v: measurements.meta.contracts.pendlePt },
                { k: "Morpho Blue market", v: measurements.meta.contracts.morphoUsdcMarket },
                { k: "Curve reUSD/USDC EMA", v: measurements.meta.contracts.curvePool },
              ],
            },
            {
              heading: "This run",
              lines: [
                { k: "Fork block", v: String(replay.meta.forkBlock) },
                { k: "Manipulator wallet", v: measurements.meta.contracts.manipulatorWallet },
                { k: "Source folder", v: `results/${run.sourceDir}` },
                { k: "Full index", v: `${replay.meta.repoBase}/docs/MEASUREMENTS.md` },
              ],
            },
          ]}
        />
      </div>
    </section>
  );
}

export function Replay() {
  const [size, setSize] = useState<(typeof SIZES)[number]>("5M");
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(60);
  const none = runByKey("none");
  const run = runByKey(size);

  // Autoplay shortly after load.
  useEffect(() => {
    const id = setTimeout(() => setPlaying(true), 700);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setT((prev) => {
        const next = prev + dt * speed;
        if (next >= DUR) {
          setPlaying(false);
          return DUR;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        setPlaying((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const feed = useMemo<FeedItem[]>(() => {
    const items: FeedItem[] = [];
    none.events.forEach((ev, i) => {
      if (ev.kind === "push") items.push({ key: `p${i}`, t: ev.t, side: "both", ev });
      if (ev.kind === "liquidatable") items.push({ key: `n${i}`, t: ev.t, side: "none", ev });
    });
    run.events.forEach((ev, i) => {
      if (ev.kind === "fill") items.push({ key: `f${run.key}${i}`, t: ev.t, side: "wamia", ev });
      if (ev.kind === "liquidatable") items.push({ key: `l${run.key}${i}`, t: ev.t, side: "wamia", ev });
    });
    return items.sort((a, b) => a.t - b.t);
  }, [none, run]);

  const ticks = feed.filter((f) => f.ev.kind !== "trade");
  const togglePlay = () => {
    if (t >= DUR) setT(0);
    setPlaying((p) => !p);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="alert-banner">
        <div style={{ display: "flex", gap: 12 }}>
          <span className="dot-ping" />
          <div>
            <div className="head">Aug 25, 2026 crisis log analysis</div>
            <div className="body">
              PT-reUSD on Morpho was looped to ~91.5% LLTV. At block {replay.meta.forkBlock}, 11 aggressive trades
              dumped millions of SY, pushing spot down and dragging the oracle TWAP toward the liquidation floor.
            </div>
          </div>
        </div>
        <span className="tag">Oracle manipulation event</span>
      </div>
      <div className="headline">
        <div>
          <div className="eyebrow">Aug 25, 2026 · PT-reUSD on Morpho · replayed on a mainnet fork</div>
          <h2>Eleven trades pushed PT down 2.5%. The oracle followed, and {usdM(none.summary.peakDebtAtRisk)} of loans became liquidatable.</h2>
          <p>
            Left: the attack as it happened. Right: the same trades against a Wamia strategy on Aqua, filled by a searcher one block after each push. Watch the blue oracle line: it's
            a roughly 15-minute average, so it keeps falling after spot stops, unless someone buys the dip right away.
          </p>
        </div>
        <div className="controls">
          <div className="seg" role="group" aria-label="Backstop size">
            {SIZES.map((s) => (
              <button key={s} aria-pressed={s === size} onClick={() => setSize(s)}>
                {runByKey(s).title}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="legend" aria-label="Legend">
        <span><i style={{ background: "var(--spot)" }} />Pendle spot</span>
        <span><i style={{ background: "var(--oracle)", height: 3 }} />Morpho oracle (TWAP)</span>
        <span><i className="dash" />Fair value at 10.58%</span>
        <span><i style={{ background: "var(--critical)" }} />First liquidation price</span>
        <span><i style={{ background: "var(--wamia)", width: 8, height: 8, transform: "rotate(45deg)" }} />Wamia fill</span>
      </div>

      <div className="sides">
        <Side run={none} t={t} withWamia={false} />
        <Side run={run} t={t} withWamia />
      </div>

      <section className="panel timeline" aria-label="Playback">
        <div className="controls" style={{ justifyContent: "space-between" }}>
          <div className="controls">
            <button className="btn primary" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
              {playing ? "❚❚ Pause" : t >= DUR ? "↻ Replay" : "▶ Play"}
            </button>
            <button className="btn" onClick={() => { setT(0); setPlaying(true); }}>Restart</button>
            <div className="seg" role="group" aria-label="Speed">
              {SPEEDS.map((s) => (
                <button key={s} aria-pressed={s === speed} onClick={() => setSpeed(s)}>
                  {s}×
                </button>
              ))}
            </div>
          </div>
          <span className="clock">
            {clock(t)} UTC · +{(t / 60).toFixed(1)} min
          </span>
        </div>
        <div className="scrub">
          <div className="ticks" aria-hidden>
            {ticks.map((f) => (
              <span key={f.key} className={`tick ${f.ev.kind}`} style={{ left: `${(100 * f.t) / DUR}%` }} />
            ))}
          </div>
          <input
            id="replay-scrub"
            type="range"
            min={0}
            max={DUR}
            step={1}
            value={Math.round(t)}
            aria-label="Replay time"
            onChange={(e) => {
              setPlaying(false);
              setT(Number(e.target.value));
            }}
          />
        </div>
      </section>

      <div className="lower">
        <Feed items={feed} t={t} />
        <Results none={none} run={run} />
      </div>
    </div>
  );
}

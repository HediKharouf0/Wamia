import { useMemo, useRef, useState } from "react";
import { oracleAt, stateAt, replay, type Run } from "./data";

const W = 560;
const H = 250;
const M = { top: 12, right: 14, bottom: 26, left: 46 };
const Y_MIN = 0.944;
const Y_MAX = 0.974;

const x = (t: number, dur: number) => M.left + (t / dur) * (W - M.left - M.right);
const y = (v: number) => M.top + ((Y_MAX - v) / (Y_MAX - Y_MIN)) * (H - M.top - M.bottom);

/** Step path for block-by-block prices, drawn up to `until`. */
function stepPath(run: Run, key: "spot" | "fair", until: number, dur: number) {
  let d = "";
  let last: number | null = null;
  for (const p of run.points) {
    if (p.t > until) break;
    const px = x(p.t, dur);
    const py = y(p[key]);
    d += d ? `L${px.toFixed(1)},${y(last!).toFixed(1)}L${px.toFixed(1)},${py.toFixed(1)}` : `M${px.toFixed(1)},${py.toFixed(1)}`;
    last = p[key];
  }
  if (last !== null) d += `L${x(until, dur).toFixed(1)},${y(last).toFixed(1)}`;
  return d;
}

function oraclePath(run: Run, until: number, dur: number) {
  let d = "";
  for (const p of run.points) {
    if (p.t > until) break;
    d += `${d ? "L" : "M"}${x(p.t, dur).toFixed(1)},${y(p.oracle).toFixed(1)}`;
  }
  d += `${d ? "L" : "M"}${x(until, dur).toFixed(1)},${y(oracleAt(run, until)).toFixed(1)}`;
  return d;
}

export function PriceChart({ run, t, showFills }: { run: Run; t: number; showFills: boolean }) {
  const dur = replay.meta.duration;
  const firstLiq = replay.positions[0]!.liqPrice;
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const now = stateAt(run, t);
  const oracleNow = oracleAt(run, t);

  const yTicks = [0.945, 0.95, 0.955, 0.96, 0.965, 0.97];
  const xTicks = useMemo(() => Array.from({ length: Math.floor(dur / 300) + 1 }, (_, i) => i * 300), [dur]);
  const fills = run.events.filter((e) => e.kind === "fill" && e.t <= t) as Extract<Run["events"][number], { kind: "fill" }>[];
  const oracleBelow = oracleNow < firstLiq;

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const box = ref.current!.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const tt = ((px - M.left) / (W - M.left - M.right)) * dur;
    setHover(tt >= 0 && tt <= Math.min(t, dur) ? tt : null);
  }

  const hs = hover === null ? null : stateAt(run, hover);
  return (
    <div className="chart-wrap">
      <svg
        ref={ref}
        className="chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Pendle spot, Morpho oracle and fair value for ${run.title}`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={M.left} x2={W - M.right} y1={y(v)} y2={y(v)} stroke="var(--grid)" strokeWidth={1} />
            <text x={M.left - 8} y={y(v) + 4} textAnchor="end">
              {v.toFixed(3)}
            </text>
          </g>
        ))}
        {xTicks.map((s) => (
          <text key={s} x={x(s, dur)} y={H - 8} textAnchor="middle">
            {s / 60} min
          </text>
        ))}

        {/* The oracle price below which the first borrower can be liquidated. */}
        <line x1={M.left} x2={W - M.right} y1={y(firstLiq)} y2={y(firstLiq)} stroke="var(--critical)" strokeWidth={1.5} strokeDasharray="5 4" opacity={oracleBelow ? 1 : 0.7} />
        <text x={W - M.right} y={y(firstLiq) - 6} textAnchor="end" style={{ fill: "#ff9a9a" }}>
          liquidations start {firstLiq.toFixed(4)}
        </text>

        <path d={stepPath(run, "fair", Math.min(t, dur), dur)} fill="none" stroke="var(--fair)" strokeWidth={1.5} strokeDasharray="4 4" opacity={0.7} />
        <path d={stepPath(run, "spot", Math.min(t, dur), dur)} fill="none" stroke="var(--spot)" strokeWidth={2} strokeLinejoin="round" />
        <path d={oraclePath(run, Math.min(t, dur), dur)} fill="none" stroke="var(--oracle)" strokeWidth={2.5} strokeLinejoin="round" />

        {showFills &&
          fills.map((f, i) => (
            <rect
              key={i}
              x={x(f.t, dur) - 3.5}
              y={y(f.spotAfter) - 3.5}
              width={7}
              height={7}
              transform={`rotate(45 ${x(f.t, dur)} ${y(f.spotAfter)})`}
              fill="var(--wamia)"
              stroke="var(--panel)"
              strokeWidth={2}
            />
          ))}

        {/* Playhead */}
        {t < dur && <line x1={x(t, dur)} x2={x(t, dur)} y1={M.top} y2={H - M.bottom} stroke="var(--ink-3)" strokeWidth={1} opacity={0.5} />}
        <circle cx={x(Math.min(t, dur), dur)} cy={y(now.spot)} r={4.5} fill="var(--spot)" stroke="var(--panel)" strokeWidth={2} />
        <circle cx={x(Math.min(t, dur), dur)} cy={y(oracleNow)} r={5} fill="var(--oracle)" stroke="var(--panel)" strokeWidth={2} />

        {hover !== null && <line x1={x(hover, dur)} x2={x(hover, dur)} y1={M.top} y2={H - M.bottom} stroke="var(--ink-2)" strokeWidth={1} />}
      </svg>
      {hover !== null && hs && (
        <div className="tooltip" style={{ left: `${Math.min(70, (x(hover, dur) / W) * 100)}%`, top: 8 }}>
          <div className="muted mono">+{(hover / 60).toFixed(1)} min · block {hs.block}</div>
          <div className="row"><span><i className="sw" style={{ background: "var(--spot)" }} />Pendle spot</span><span className="mono">{hs.spot.toFixed(4)}</span></div>
          <div className="row"><span><i className="sw" style={{ background: "var(--oracle)" }} />Morpho oracle</span><span className="mono">{oracleAt(run, hover).toFixed(4)}</span></div>
          <div className="row"><span><i className="sw" style={{ background: "var(--fair)" }} />Fair value</span><span className="mono">{hs.fair.toFixed(4)}</span></div>
        </div>
      )}
    </div>
  );
}

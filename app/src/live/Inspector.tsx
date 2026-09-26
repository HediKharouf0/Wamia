import { useEffect, useState } from "react";
import { explainRevert, fmt, get, post, short, useLiveState } from "./api";
import { ChainBadge, Offline } from "../ui";

type Step = {
  opcode: string;
  instruction: string;
  target: string;
  contract: string;
  argsBytes: number;
  params: Record<string, string>;
  checks: { codeSize: number; codeHash: string; matchesRepoBuild: boolean; noProxy: boolean; riskyOpcodes: string[] };
};
type Inspection = { hash: string; maker: string; traits: string; programBytes: number; steps: Step[]; router: string; aqua: string };
type Quote = { ok: true; ptIn: number; syOut: number; usdPerPt: number } | { ok: false; reason: string };

const ROLE: Record<string, string> = {
  WamiaRateGuard: "Runs first. Refuses if SY's exchange rate fell below its high-water mark, or if reUSD's realized yield runs far above the reference.",
  WamiaQuoter: "Prices the trade: fair value at the reference yield minus a discount that deepens with use. Refuses on a vault loss, a reUSD run, or a gap that looks like news.",
  WamiaSpendLimit: "Runs after pricing. Caps what the strategy pays per 12 s block, so a bug or an unseen collapse can't drain it at once.",
};

/** Human units for the packed parameters. */
function show(k: string, v: string) {
  if (/Wad$/.test(k)) return `${(Number(v) / 1e16).toFixed(3)}%`;
  if (/Bps$/.test(k)) return `${v} bp`;
  if (k === "shippedSy") return `${fmt(Number(BigInt(v) / 10n ** 18n))} SY`;
  if (k === "minSyRate" || k === "rateAtShip") return (Number(v) / 1e6).toFixed(6);
  if (k === "minElapsed" || k === "horizonSec") return `${fmt(Number(v) / 86_400, 1)} days`;
  if (k === "windowSec") return `${v} s`;
  if (k === "expiry" || k === "shipTimestamp") return new Date(Number(v) * 1000).toISOString().slice(0, 16).replace("T", " ");
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) return short(v);
  return v;
}

export function Inspector({ initialHash }: { initialHash: string | null }) {
  const { state, error } = useLiveState(3000);
  const [hash, setHash] = useState<string | null>(initialHash);
  const [data, setData] = useState<Inspection | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [pt, setPt] = useState(100_000);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);

  const strategies = state?.lp.strategies ?? [];
  useEffect(() => {
    if (!hash && strategies.length) setHash(strategies[strategies.length - 1]!.hash);
  }, [hash, strategies]);
  useEffect(() => {
    if (!hash) return;
    setData(null);
    setQuote(null);
    get<Inspection>(`inspect?hash=${hash}`)
      .then((d) => {
        setData(d);
        setLoadErr(null);
      })
      .catch((e) => setLoadErr(e.message));
  }, [hash]);

  if (error && !state) return <Offline error={error} />;
  if (!state) return <div className="banner">Connecting to the app server…</div>;

  async function runQuote() {
    if (!hash) return;
    setQuoting(true);
    try {
      setQuote((await post("quote", { hash, pt })) as Quote);
    } catch (e: any) {
      setQuote({ ok: false, reason: e.message });
    } finally {
      setQuoting(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="headline">
        <div>
          <div className="eyebrow">For resolvers and takers</div>
          <h2>Can I trust this strategy?</h2>
          <p>
            SwapVM warns that Extruction hands pricing to a maker-chosen contract. This page decodes the order's program and checks every contract it calls against the build in this
            repo.
          </p>
        </div>
        <ChainBadge mode={state.chain.mode} block={state.chain.block} busy={state.chain.busy} />
      </div>

      {strategies.length === 0 ? (
        <div className="banner">Ship a strategy from “Protect a market” first, then inspect it here.</div>
      ) : (
        <div className="live-grid" style={{ gridTemplateColumns: "1fr 360px" }}>
          <section className="panel card">
            <div className="side-head">
              <h3>Program</h3>
              <select id="strategy" value={hash ?? ""} onChange={(e) => setHash(e.target.value)} style={{ background: "var(--ground)", border: "1px solid var(--line)", borderRadius: 8, padding: "6px 8px" }}>
                {strategies.map((s) => (
                  <option key={s.hash} value={s.hash}>
                    {short(s.hash)} · {fmt(s.shippedSy / 1e6, 2)}M SY{s.guards ? " · guards" : ""}{s.docked ? " · docked" : ""}
                  </option>
                ))}
              </select>
            </div>
            {loadErr && <div className="banner">{loadErr}</div>}
            {data && (
              <>
                <dl className="kv">
                  <dt>Maker (LP wallet)</dt>
                  <dd>{data.maker}</dd>
                  <dt>Maker traits</dt>
                  <dd>{data.traits === "0x4000000000000000000000000000000000000000000000000000000000000000" ? "Aqua balances, no signature, no hooks" : data.traits}</dd>
                  <dt>Program</dt>
                  <dd>{data.programBytes} bytes, {data.steps.length} instruction{data.steps.length > 1 ? "s" : ""}</dd>
                </dl>
                <div className="program">
                  {data.steps.map((s, i) => (
                    <div key={i}>
                      {i > 0 && <div className="arrow-down">↓ then</div>}
                      <div className="step">
                        <span className="op">{s.opcode}</span>
                        <div>
                          <div>
                            <b>{s.instruction}</b> → <b>{s.contract}</b> <span className="mono muted">{short(s.target)}</span>
                          </div>
                          <div className="muted" style={{ fontSize: 13 }}>{ROLE[s.contract] ?? ""}</div>
                          <div className="row-actions" style={{ marginTop: 6 }}>
                            <span className={`check ${s.checks.matchesRepoBuild ? "ok" : "no"}`}>code matches this repo's build</span>
                            <span className={`check ${s.checks.noProxy ? "ok" : "no"}`}>not a proxy</span>
                            <span className={`check ${s.checks.riskyOpcodes.length === 0 ? "ok" : "no"}`}>
                              {s.checks.riskyOpcodes.length === 0 ? "no DELEGATECALL or SELFDESTRUCT" : s.checks.riskyOpcodes.join(", ")}
                            </span>
                          </div>
                          <pre>
                            {Object.entries(s.params)
                              .map(([k, v]) => `${k.padEnd(16)} ${show(k, v)}`)
                              .join("\n")}
                          </pre>
                          <div className="mono muted" style={{ fontSize: 11 }}>
                            {s.argsBytes} bytes of params · code {fmt(s.checks.codeSize)} bytes · hash {short(s.checks.codeHash)}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>

          <section className="panel card">
            <h3>Quote tester</h3>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>Calls the router's quote() for a PT sale to this strategy, the same view a resolver would call.</p>
            <div className="field">
              <label htmlFor="quote-pt">PT to sell</label>
              <input id="quote-pt" type="number" min={1} step={1000} value={pt} onChange={(e) => setPt(Number(e.target.value))} />
            </div>
            <button className="btn primary" disabled={quoting || !hash} onClick={runQuote}>
              {quoting ? "Quoting…" : "Quote"}
            </button>
            {quote &&
              (quote.ok ? (
                <dl className="kv">
                  <dt>PT in</dt>
                  <dd>{fmt(quote.ptIn)}</dd>
                  <dt>SY out</dt>
                  <dd>{fmt(quote.syOut, 2)}</dd>
                  <dt>Price</dt>
                  <dd>{quote.usdPerPt.toFixed(4)} USD/PT</dd>
                  <dt>vs fair</dt>
                  <dd>{(((state.market.fair - quote.usdPerPt) / state.market.fair) * 1e4).toFixed(1)} bp below</dd>
                </dl>
              ) : (
                <div className="rule bad">
                  <div>
                    <div className="name">Refused</div>
                    <div className="detail">{explainRevert(quote.reason)}</div>
                  </div>
                </div>
              ))}
            <dl className="kv" style={{ marginTop: 8 }}>
              <dt>Router</dt>
              <dd>{short(state.contracts.router ?? "")}</dd>
              <dt>Aqua</dt>
              <dd>{short(state.contracts.aqua ?? "")}</dd>
            </dl>
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              {state.chain.mode === "fork"
                ? "On the fork, the router and Aqua are the deployed 1inch contracts; Wamia's own contracts are deployed by the app server."
                : "Local chain: Aqua and the router are built from their release tags."}
            </p>
          </section>
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";

export type Rule = { id: string; name: string; ok: boolean; detail: string };
export type Fill = { at: number; block: number; tx: string; ptBought: number; syPaid: number; price: number };
export type StrategyView = {
  hash: string;
  shippedSy: number;
  syLeft: number;
  discountMaxBps: number;
  guards: boolean;
  docked: boolean;
  shippedAt: number;
  shipTx: string;
  bid: number | null;
  fills: Fill[];
};
export type Activity = { at: number; kind: string; text: string; tx?: string };
export type Position = { market: string; user: string; debt: number; healthFactor: number; liquidatable: boolean; liqPrice: number };

export type LiveState = {
  chain: { mode: "fork" | "local"; rpc: string; block: number; ts: number; busy: string | null; scenario: string | null };
  contracts: Record<string, string>;
  market: {
    ts: number;
    block: number;
    syRate: number;
    spot: number;
    fair: number;
    impliedYield: number;
    marketToNav: number;
    verdict: string;
    rules: Rule[];
    morpho: null | { oracle: number; liquidatableDebt: number; within3pct: number; firstLiqPrice: number; positions: Position[] };
  };
  lp: {
    wallet: string;
    walletSy: number;
    walletPt: number;
    walletUsd: number;
    allowanceUnlimited: boolean;
    promisedSy: number;
    realSy: number;
    syRate: number;
    strategies: StrategyView[];
    pnl: { ptBought: number; paidUsd: number; atMaturityUsd: number; annualized: number | null };
  };
  activity: Activity[];
  history: { block: number; spot: number; fair: number; oracle: number | null }[];
};

export async function post(path: string, body: unknown = {}) {
  const r = await fetch(`/api/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

export async function get<T>(path: string): Promise<T> {
  const r = await fetch(`/api/${path}`);
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j as T;
}

/** Polls /api/state. `refresh()` fetches right away (after an action). */
export function useLiveState(intervalMs = 1500) {
  const [state, setState] = useState<LiveState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    try {
      const s = await get<LiveState>("state");
      if (alive.current) {
        setState(s);
        setError(null);
      }
    } catch (e: any) {
      if (alive.current) setError(e.message === "Failed to fetch" || /HTTP 50[02]/.test(e.message) ? "offline" : e.message);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const id = setInterval(refresh, intervalMs);
    return () => {
      alive.current = false;
      clearInterval(id);
    };
  }, [refresh, intervalMs]);
  return { state, error, refresh };
}

/** Runs an action, shows a toast with the outcome, and refreshes the state. */
export function useAction(refresh: () => Promise<void>) {
  const [toast, setToast] = useState<{ text: string; err: boolean } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), toast.err ? 7000 : 3500);
    return () => clearTimeout(id);
  }, [toast]);
  const run = useCallback(
    async (label: string, path: string, body: unknown, done?: string) => {
      setPending(label);
      try {
        await post(path, body);
        if (done) setToast({ text: done, err: false });
      } catch (e: any) {
        setToast({ text: e.message, err: true });
      } finally {
        setPending(null);
        await refresh();
      }
    },
    [refresh]
  );
  return { run, pending, toast };
}

/** Plain-words names for the contracts' refusals. */
export function explainRevert(reason: string): string {
  const name = reason.split("(")[0] ?? reason;
  const map: Record<string, string> = {
    UnderlyingDepegged: "reUSD trades more than 1% below its NAV on Curve",
    SyBelowFloor: "SY's exchange rate fell below the LP's floor (a loss in the vault)",
    SpotTooFarBelowFair: "Pendle trades more than 4.5% below fair value, which looks like news, not a push",
    SpendLimitExceeded: "the strategy already paid its share for this block (spend limit)",
    RateBelowHighWaterMark: "SY's rate dropped below its highest value",
    UnderlyingYieldAboveReference: "reUSD now yields far more than the reference rate",
    InsufficientLiquidity: "more than the strategy has left",
    MarketExpired: "the market has matured",
    OnlyPtToSy: "P1nch only buys PT",
  };
  return map[name] ? `${map[name]} (${name})` : reason;
}

export const fmt = (x: number, d = 0) => x.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
export const short = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;

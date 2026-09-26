import { useEffect, useRef, useState } from "react";

/** Eases a displayed number toward its target so values roll instead of jumping. */
export function useTween(target: number, ms = 450) {
  const [v, setV] = useState(target);
  const from = useRef(target);
  const cur = useRef(target);
  cur.current = v;
  useEffect(() => {
    from.current = cur.current;
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      setV(from.current + (target - from.current) * e);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

export function Rolling({ value, digits = 0, prefix = "", suffix = "" }: { value: number; digits?: number; prefix?: string; suffix?: string }) {
  const v = useTween(value);
  return (
    <span className="num">
      {prefix}
      {v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits })}
      {suffix}
    </span>
  );
}

/** Briefly marks a value that just changed (or, with `still`, one that stayed put when it could have moved). */
export function useFlash(value: unknown, ms = 1600) {
  const [flash, setFlash] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setFlash(true);
    const id = setTimeout(() => setFlash(false), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return flash;
}

export function Toast({ toast }: { toast: { text: string; err: boolean } | null }) {
  if (!toast) return null;
  return (
    <div className={`toast ${toast.err ? "err" : ""}`} role="status">
      {toast.text}
    </div>
  );
}

export function Offline({ error }: { error: string }) {
  return (
    <div className="banner">
      {error === "offline" ? (
        <>
          The app server isn't running. Start a chain and the server in two terminals:
          <pre className="mono" style={{ margin: "10px 0 0", whiteSpace: "pre-wrap" }}>
            {`anvil --fork-url "$ARCHIVE_RPC_URL" --fork-block-number 25829822   # or plain anvil for local mode\nnpm run app:server`}
          </pre>
        </>
      ) : (
        <>Server: {error}</>
      )}
    </div>
  );
}

export function ChainBadge({ mode, block, busy }: { mode: "fork" | "local"; block: number; busy: string | null }) {
  return (
    <div className="controls" style={{ gap: 8 }}>
      <span className={`pill ${mode === "fork" ? "good" : "warn"}`}>
        <span className="led" />
        {mode === "fork" ? "Mainnet fork" : "Local chain, mock Pendle"}
      </span>
      <span className="pill mono">block {block}</span>
      {busy && (
        <span className="pill warn">
          <span className="led spin" />
          {busy}…
        </span>
      )}
    </div>
  );
}

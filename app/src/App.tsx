import { useEffect, useState } from "react";
import { Replay } from "./replay/Replay";
import { LpConsole } from "./live/LpConsole";
import { Monitor } from "./live/Monitor";
import { Inspector } from "./live/Inspector";

const TABS = [
  { id: "replay", label: "Aug 25 replay" },
  { id: "protect", label: "Protect a market" },
  { id: "monitor", label: "Is it protected?" },
  { id: "inspect", label: "Inspect a strategy" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function initialTab(): TabId {
  const h = window.location.hash.replace("#", "");
  return (TABS.find((t) => t.id === h)?.id ?? "replay") as TabId;
}

function HostedNote() {
  return (
    <div className="banner">
      This screen works live against a mainnet fork on your machine, so it can't run on this hosted page. Clone the repo, start anvil forked at block 25829822 and run{" "}
      <code>npm run app:server</code> and <code>npm run app</code>. The replay tab above runs anywhere.
    </div>
  );
}

export function App() {
  const [tab, setTab] = useState<TabId>(initialTab);
  const [inspectHash, setInspectHash] = useState<string | null>(null);
  useEffect(() => {
    try {
      history.replaceState(null, "", `#${tab}`);
    } catch {
      /* some embedded frames refuse history edits; the tab still works */
    }
  }, [tab]);
  useEffect(() => {
    const onHash = () => setTab(initialTab());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <h1>
            P<span className="one">1</span>nch
          </h1>
          <span className="tag">A standing PT backstop on 1inch Aqua + SwapVM</span>
        </div>
        <nav className="tabs" role="tablist" aria-label="Screens">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <main>
        {tab === "replay" && <Replay />}
        {tab === "protect" && (__HOSTED__ ? <HostedNote /> : <LpConsole onInspect={(h) => { setInspectHash(h); setTab("inspect"); }} />)}
        {tab === "monitor" && (__HOSTED__ ? <HostedNote /> : <Monitor />)}
        {tab === "inspect" && (__HOSTED__ ? <HostedNote /> : <Inspector initialHash={inspectHash} />)}
      </main>
    </div>
  );
}

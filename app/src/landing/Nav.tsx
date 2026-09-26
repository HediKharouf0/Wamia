import { repoBase } from "./data";

export function Nav() {
  return (
    <header className="topbar">
      <div className="brand">
        <h1>
          WAMIA <span className="one">// TERMINAL</span>
        </h1>
      </div>
      <nav className="nav-links" aria-label="Sections">
        <a href="#attack-replay">Defense Proof</a>
        <a href="#yield-model">Yield Model</a>
        <a href="#architecture">Architecture</a>
        <a href="#extruction-specs">Guardrails</a>
      </nav>
      <a className="btn" href={repoBase} target="_blank" rel="noreferrer">
        GitHub
      </a>
    </header>
  );
}

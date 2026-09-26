import { repoBase } from "./data";
import logo from "../assets/wamia-logo.png";

export function Nav() {
  return (
    <header className="topbar">
      <div className="brand">
        <img src={logo} alt="" className="brand-mark" />
        <h1>WAMIA</h1>
      </div>
      <nav className="nav-links" aria-label="Sections">
        <a href="#yield-model">Yield Model</a>
        <a href="#attack-replay">Defense Proof</a>
        <a href="#taker-comparison">Capital Comparison</a>
        <a href="#collapse-scenarios">Collapse Scenarios</a>
        <a href="#architecture">Architecture</a>
        <a href="#extruction-specs">Guardrails</a>
      </nav>
      <a className="btn" href={repoBase} target="_blank" rel="noreferrer">
        GitHub
      </a>
    </header>
  );
}

import { repoBase } from "./data";

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="top">
        <div>
          <div className="brand">WAMIA // TERMINAL</div>
          <div className="tagline">SWAPVM STANDING LIQUIDITY BACKSTOP FOR PENDLE PT MARKETS :: ZERO-CAPITAL SEARCHER ROUTING</div>
        </div>
        <div className="links">
          <a href={`${repoBase}/docs/MEASUREMENTS.md`} target="_blank" rel="noreferrer">
            All measurements
          </a>
          <span>•</span>
          <a href="#extruction-specs">SwapVM extruction docs</a>
          <span>•</span>
          <a href="#architecture">Aqua pool architecture</a>
          <span>•</span>
          <a href={repoBase} target="_blank" rel="noreferrer">
            GitHub core repo
          </a>
        </div>
      </div>
    </footer>
  );
}

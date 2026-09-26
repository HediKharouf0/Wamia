import { repoBase } from "./data";

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="top">
        <div>
          <div className="brand">WAMIA</div>
          <div className="tagline">1INCH SWAPVM STANDING LIQUIDITY BACKSTOP :: ZERO-CAPITAL SEARCHER ROUTING</div>
        </div>
        <div className="links">
          <a href={`${repoBase}/docs/MEASUREMENTS.md`} target="_blank" rel="noreferrer">
            All measurements
          </a>
          <span>•</span>
          <a href="#extruction-specs">1inch SwapVM extruction docs</a>
          <span>•</span>
          <a href="#architecture">1inch Aqua pool architecture</a>
          <span>•</span>
          <a href={repoBase} target="_blank" rel="noreferrer">
            GitHub core repo
          </a>
        </div>
      </div>
    </footer>
  );
}

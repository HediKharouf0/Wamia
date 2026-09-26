import { measurements, repoBase } from "./data";
import { GhLink } from "./VerificationDrawer";

export function Architecture() {
  return (
    <div className="landing-section" id="architecture">
      <div className="section-head">
        <span className="eyebrow-teal">// PROTOCOL ANATOMY</span>
        <h2>How It Works</h2>
        <p>
          Off-chain bots monitor mempools and race to land a transaction; under congestion they miss the block that
          matters. Wamia instead deposits a standing, pre-verified order into 1inch SwapVM, so any searcher — not a
          bot Wamia runs — is paid to execute it the moment it becomes profitable.
        </p>
      </div>
      <div className="arch-grid">
        <div className="panel arch-stage">
          <div className="top">
            <span className="stage-tag">01</span>
          </div>
          <h3>LP Wallet + Aqua</h3>
          <p>LPs sign a standing SwapVM order for SY. Funds stay in the LP's own wallet until a fill actually happens.</p>
          <ul>
            <li>No lockup, no separate deposit</li>
            <li>Verified against the LP's live balance on every fill</li>
          </ul>
          <div className="foot">// contracts/src/WamiaOrders.sol</div>
        </div>
        <div className="panel arch-stage">
          <div className="top">
            <span className="stage-tag">02</span>
          </div>
          <h3>SwapVM extruction pipeline</h3>
          <p>When PT dips, SwapVM evaluates the order's constraints, in order, before it prices anything:</p>
          <ul>
            <li>WamiaRateGuard — NAV & Curve EMA floor</li>
            <li>WamiaQuoter — 1/(1+y)^τ fair-value discount curve</li>
            <li>WamiaSpendLimit — per-block budget cap</li>
          </ul>
          <div className="foot">EXTRUCTION_OPCODE = 0x20</div>
        </div>
        <div className="panel arch-stage">
          <div className="top">
            <span className="stage-tag">03</span>
          </div>
          <h3>Searcher execution</h3>
          <p>
            A zero-capital searcher calls <code>WamiaArb.arb()</code>: buy cheap PT on Pendle, sell it to Wamia via
            SwapVM, settle both legs atomically in <code>preTransferInCallback</code>.
          </p>
          <ul>
            <li>Reverts whole if either leg fails — no partial state</li>
            <li>Sized by golden-section search on simulated profit</li>
          </ul>
          <div className="foot">// contracts/src/WamiaArb.sol</div>
        </div>
      </div>
      <div className="section-actions">
        <span className="muted" style={{ fontSize: 12 }}>
          Every claim on this page traces to a contract, a test, or a results/ folder — nothing here is illustrative.
        </span>
        <GhLink repoBase={repoBase} path="contracts/src" label="View contracts on GitHub" />
      </div>
    </div>
  );
}

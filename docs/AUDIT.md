# Repo audit (Sep 26)

Full read of `src/`, `contracts/`, `config/`, `fixtures/` (structure), `results/`
and the git history. Findings are ordered by how much they can change the
numbers or the pitch. "Fixed" items are already committed.

## Fixed today

1. Taker price check mixed units (SY/PT vs reUSD/PT), so every trigger spent the
   full budget. The 5M SY run paid 0.9727 reUSD/PT, above the 0.9663 target and
   above fair value. Now converted with `SY.exchangeRate()` and sized toward the
   target (`src/strategies/sizing.ts`). Taker results in `results/` are stale
   until the sweep is rerun.
2. PnL TOTAL ignored the SY rate, giving 50-64% annualized. Real figures from
   the recorded buys: 19.5% / 14.5% / 9.9%. Note the 5M SY buy returns less
   than simply buying at fair value (10.58%).
3. The TypeScript never typechecked (CommonJS package, node types excluded);
   `tsx` hid it. Three discovery scripts were broken since the client-argument
   refactor (070c549). Now `npm run typecheck` passes and `npm test` runs the
   offline tests.

## Open: can change results

4. Latency is 1 second per block, not 12. `maybeReactAndBuy` mines reaction
   blocks at `lastTs + 1`. On mainnet the first liquidation landed 12 s after
   manip-11, and the taker trigger only fired after manip-11 (9 s deadline), so
   with real block times the taker buys in the same block as the first
   liquidation. The taker "1-block latency" results are optimistic. The maker
   design avoids this: its bid is standing, so arbs fill it every block with no
   trigger.
5. The attacker is replayed with fixed calldata. Once Levee buys between
   manipulator transactions, their slippage limits may make them revert, which
   would look like protection but is really the attacker giving up.
   `scenarioMaker` must report manipulator tx statuses and offer an "adaptive
   attacker" mode (same SY in, min out 0).
6. The depeg stop reads `SY.exchangeRate()`, which only moves if the reUSD vault
   itself loses value. A market depeg of reUSD against USD leaves it unchanged,
   and to the quoter looks exactly like the Aug 25 manipulation. The pitch
   should not call this a depeg stop until a price-based check exists (Morpho
   oracle vs reference, cross-maturity check, or an external reUSD/USD feed).
7. Fixed reference rate: after a genuine repricing, a strategy keeps buying at
   the old fair value until the LP docks. Cheap mitigation: add SwapVM's
   `Deadline` instruction (index 13 in v1.0.2) before the Extruction so
   strategies expire and must be re-shipped with a fresh rate.
8. Levee's bid vs the risk target. With a 10 bp discount the bid (~0.970) is
   well above the target the risk model needs (~0.966), so the maker would
   spend more capital than protection requires. Any discount up to ~45 bp
   still keeps the bid above the target and pays LPs more. Worth sweeping.

## Open: correctness of the model (lower risk)

9. Morpho oracle model: `FEED_1` appears to be Pendle's `PendleChainlinkOracle`,
   a TWAP of the market's implied rate (Etherscan suggests a ~1000 s window,
   unconfirmed). The fork uses the real oracle contract, so replays are exact;
   only the risk model's W = 900 s is approximate. Confirm with
   `cast call 0x570eA68f11e63a9108514eB73Dc4f88232C9e7f6 "twapDuration()(uint32)"`.
10. State-only counterfactuals skip the 29 liquidations but still replay the 4
    competitor PT dumps that followed them. Conservative (adds selling), fine,
    but say so.
11. The liquidation ladder is built once from fork-block health; the 10
    `morpho-other` transactions are not reflected. Small effect.
12. `backstopPnl` reads the SY rate from mainnet at the fork's block number
    for old runs (fork and mainnet heights overlap). New runs record the exact
    rate.

## Hygiene before submission

13. Root `README.md` is still the Foundry template. Judges read it first.
14. Repo must be public for judging; add a LICENSE for our code.
15. `results/` has three raw replay logs (~430 KB) and `scenario-test-*` runs;
    `fixtures/` has `attacker_txs_filtered.json` / `liquidator_txs_filtered.json`
    and `scripts/replay.sh` from the first day. Keep only what the README uses.
16. `config/scenario.json` duplicates `config/addresses.json` (and labels the
    liquidation proxy "liquidator"). Merge into `addresses.json`, with Aqua and
    the router marked verified once the fork test passes.
17. `strategies/taker.ts` still exports an unused `decideTakerAction`.
18. Commit messages lost their dollar amounts (".9M cascade") because `$3...`
    was expanded by the shell. Use single quotes for messages with `$`.

## Contracts (written today)

19. Local tests: 32 pass (unit, and end to end on Aqua v1.0.0 + router v1.0.2
    built from source). The mainnet fork test is written but has not run yet.
20. The per-trade cap is stateless, so splitting a trade bypasses it. The real
    cap is the shipped SY. A per-hour limit needs storage written only in swap
    mode (planned v2).

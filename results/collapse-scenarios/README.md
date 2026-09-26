# Genuine-collapse scenarios

Five fork scenarios checking that Wamia refuses to buy when a price drop is real news,
not a manipulated attack — spec 7.6 step 6. Each case starts from the same fork block
with the demo strategy shipped (5M SY, discount 10 to 30 bp), then a zero-capital
searcher looks for the arb exactly as in the maker replay (`results/scenario-maker-*`).

## Reproduce

```
anvil --fork-url $MAINNET_RPC_URL --fork-block-number 25829822 --port 8545 &
forge build
npm run scenario:collapse               # all five cases, writes summary.json
npm run scenario:collapse -- jump       # one case only (no file written)
```

## The five cases

1. **`control`** — the attack's first 7 pushes, nothing else wrong.
   Wamia buys: the arb goes through, exactly as in a normal run.

2. **`switchoff`** — an attacker dumps reUSD on the real Curve pool until the pool's
   *last* price is over 1% under NAV, then pushes the SwapVM discount all at once.
   Wamia's depeg stop reads the pool's EMA, not its last price, and one dump barely
   moves an EMA — so Wamia keeps buying and the attacker cannot switch the backstop
   off cheaply with a single trade.

3. **`run`** — a genuine run: reUSD is dumped to 2% under NAV and *left there* for
   minutes, until the pool's EMA itself is over 1% under NAV (the underlying exchange
   rate is unchanged throughout). The same pushes then run. Wamia refuses
   (`UnderlyingDepegged`).

4. **`loss`** — reUSD's NAV oracle reports 5% less value, then the same pushes run.
   Wamia refuses (`SyBelowFloor`). Harness edit: the oracle's stored rate is scaled
   directly in EVM storage, as if its updater had posted a loss — there is no public
   contract path to do that on a fork, so this case cannot be driven through ordinary
   calls.

5. **`jump`** — Pendle's market is more than 4.5% below fair value before any arb has
   a chance to react. First the attacker's trade is pushed in 50k SY steps with no arb
   in between, to find how far trades *alone* can move Pendle's price (its own AMM
   stops accepting further pushes once it's about 2.6% below fair). Since that falls
   short of 4.5%, the market's stored implied rate is then edited directly (harness
   edit, `marketRateEdited: true`) to 6% below fair, as if Pendle had repriced on news.
   Wamia refuses (`SpotTooFarBelowFair`).

Cases `run`, `loss`, and `jump` rely on a harness edit to reach a state that has no
legitimate onchain path in one block (a sustained EMA move, an oracle write, an AMM
repricing beyond what trades alone can force) — that's what makes each of them
*genuine news* rather than something a manipulator could replicate by pushing.

## Result (`summary.json`)

| case | bought? | reason | spot vs fair |
|---|---|---|---|
| control | yes | max profit | 0.9592 / 0.9710 |
| switchoff | yes | max profit | 0.9592 / 0.9710 |
| run | no | `UnderlyingDepegged(989774946423246737, 990000000000000000)` | 0.9592 / 0.9710 |
| loss | no | `SyBelowFloor(1041958, 1085830)` | 0.9592 / 0.9710 |
| jump | no | `SpotTooFarBelowFair(912743560123411841, 971003799754889937)` | 0.9127 / 0.9710 |

Notes:
- `control` and `switchoff` both size the same arb (~1.157M SY in, ~1.309M PT out) —
  confirming `switchoff`'s Curve dump really did nothing to Wamia's own decision.
- `switchoff`'s Curve pool sees its last-trade price fall to 0.9865 (over 1% under
  NAV) while its EMA barely moves, to 0.9999 — the mechanism the case is testing.
- `run` holds a 2% Curve depeg for 19 simulated minutes until the EMA itself reaches
  0.9795 (over 1% under NAV) before the pushes run.
- `loss` scales the SY exchange rate from 1096798 to 1041958 (about -5%) by editing
  the oracle contract's storage directly (`editedContract` in the JSON).
- `jump` finds Pendle's own AMM stops accepting pushes past ~2.6% below fair
  (`tradesFloorBps: 223.6`) after 4 pushes of 50k SY each, then edits the market's
  stored rate to 6% below fair (`deviationBps: 600`) to reach the 4.5% threshold.

## Files

- `summary.json` — one object per case, written only on a full run (all five cases).
- [`collapseScenarios.ts`](../../src/replay/collapseScenarios.ts) — the script that
  runs all five cases and writes this file; its header comment documents each case in
  the same terms as above.

# Taker comparison — 5M SY, latency 1

This is one of four runs from a single script: **`compareTakerVsBaseline.ts`**, which
replays the real August 2026 attack (`fixtures/replay-plan.json` — the manipulator's and the
background users' actual mainnet transactions, resubmitted on a fork) with a capitalized
"taker" wallet watching the Morpho liquidation ladder and buying discounted PT on Pendle
directly, whenever [`assessRisk`](../../src/strategies/riskModel.ts) judges the ladder at risk
and [`decideAndSizeBuy`](../../src/strategies/sizing.ts) finds a size whose average price stays
at or under a target spot. No Wamia contracts are shipped in this comparison — it isolates what
a taker with capital and no protocol support can do, as a baseline against the Wamia maker
strategy measured in `results/scenario-maker-*`.

Historical liquidation transactions in the replay plan are skipped by design (state-only mode):
the point of this comparison is what buying pressure on Pendle does to the ladder, not to
reproduce the actual liquidations.

## Reproduce

```
anvil --fork-url $MAINNET_RPC_URL --fork-block-number 25829822 --port 8545 &
forge build
npx tsx src/replay/compareTakerVsBaseline.ts
```

This single command runs all four capital levels in one pass (baseline with zero capital, then
100k/2M/5M SY) and prints a side-by-side comparison at the end; each level also writes its own
`results/scenario-<label>/timeseries.json` and `buys.json`.

## This run

5,000,000 SY of capital (~5.48M reUSD), 1 block of reaction latency. Here the budget is large
enough that a single full-size buy would push the average price over the 0.9663 target, so the
sizing search splits it into three partial buys instead:

| block | event | SY spent | PT received | price (asset) | sizing |
|---|---|---|---|---|---|
| 25829854 | manip-11 ok | 3,346,722.29 | 3,798,675.508681 | 0.9663 | partial |
| 25829861 | backg-9 ok | 41,809.09 | 47,459.693388 | 0.9662 | partial |
| 25829865 | backg-10 REV | 1,644.90 | 1,867.180810 | 0.9662 | partial |

Only ~3.39M of the 5M SY budget is actually spent across the replay — each partial buy is
capped at the size whose average price stays at or under the target, and the remaining capital
is left unused once spot is already near target (see [`sizing.ts`](../../src/strategies/sizing.ts)).

## Files

- `timeseries.json` — one point per replayed event/tick, same shape as the baseline run.
- `buys.json` — this taker's actual buys, with the exact sizes and prices the sizing search chose.


# Taker comparison — 100k SY, latency 1

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

100,000 SY of capital (~109,680 reUSD), 1 block of reaction latency. The taker makes one buy:

| block | SY spent | PT received | price (SY) | price (asset) | sizing |
|---|---|---|---|---|---|
| 25829854 | 100,000 | 115,568.069307 | 0.8653 | 0.9490 | full-budget |

The whole budget goes in one trade (`sizingReason: "full-budget"`) at an average price of
~0.949 reUSD/PT — under the strategy's target spot of 0.9663, so no partial-fill search was
needed.

## Files

- `timeseries.json` — one point per replayed event/tick, same shape as the baseline run.
- `buys.json` — this taker's actual buy(s), with the exact size and price the sizing search chose.


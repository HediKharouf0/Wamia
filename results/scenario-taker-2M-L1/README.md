# Taker comparison — 2M SY, latency 1

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

2,000,000 SY of capital (~2.19M reUSD), 1 block of reaction latency. The taker makes one buy:

| block | SY spent | PT received | price (SY) | price (asset) | sizing |
|---|---|---|---|---|---|
| 25829854 | 2,000,000 | 2,282,525.909027 | 0.8762 | 0.9610 | full-budget |

Same block as the 100k run, again a full-budget buy: 2M SY is still small enough relative to
the ladder's discount that spending the whole budget at once stays under the 0.9663 target
(average price ~0.961 reUSD/PT).

## Files

- `timeseries.json` — one point per replayed event/tick, same shape as the baseline run.
- `buys.json` — this taker's actual buy(s), with the exact size and price the sizing search chose.


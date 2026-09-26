# Taker comparison — baseline (zero capital)

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

Zero capital (`capitalSy: 0`), latency 0 — the reference point every capital level is measured
against. No buys happen (`buys.json` is `[]`); `timeseries.json` records the ladder and the
oracle/spot price throughout the replay exactly as it played out with no taker intervention at
all.

## Files

- `timeseries.json` — one point per replayed event/tick: PT spot, implied yield, oracle price,
  and the Morpho liquidatable count/debt for both markets.
- `buys.json` — empty for this run (no capital to spend).


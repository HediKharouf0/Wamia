# Historical replay (ground truth)

The full August 2026 attack replayed exactly as it happened on mainnet: every manipulator,
background-user, and liquidation transaction from `fixtures/replay-plan.json`, resubmitted on
an anvil fork in their original order, at 60-second ticks between them. No Wamia contracts and
no taker are involved — this is the ground-truth baseline every other measurement in `results/`
is checked against, including the state-only baseline (`results/scenario-baseline-state-only/`),
which skips historical liquidations by design and so is not the same thing as this run.

## Reproduce

```
anvil --fork-url $MAINNET_RPC_URL --fork-block-number 25829822 --port 8545 &
forge build
npx tsx src/replay/baseline.ts
```

Two validation scripts read this run's output afterward:

```
npx tsx src/validate/shadowOracle.ts        # checks the fork's oracle price at each historical
                                             # liquidation against the real mainnet oracle at
                                             # the same block, to confirm the fork is faithful
npx tsx src/validate/reconcileLiquidations.ts   # sums real Morpho `Liquidate` events in the
                                                 # attack window directly from mainnet logs, as
                                                 # an independent check on repaid amounts —
                                                 # writes liquidation-reconciliation.json
```

## Result

- `timeseries.json` — one point per replayed transaction plus periodic idle ticks: PT spot,
  implied yield, oracle price, and the Morpho liquidatable count/debt for both markets, from
  before the attack through 30 minutes of post-attack ticks.
- `liquidation-reconciliation.json` — cross-checked against real Morpho Blue `Liquidate` events
  fetched directly from mainnet logs (blocks 25829821-25829929): **$35,906,531.949202** repaid
  across the two Wamia-covered Morpho markets, which is the same total repaid across *all*
  markets liquidated in that window — confirming no liquidation in this window happened outside
  the markets this project tracks.

## Files

- `timeseries.json` — the full historical replay, described above.
- `liquidation-reconciliation.json` — the independent mainnet cross-check, described above.
- [`baseline.ts`](../../src/replay/baseline.ts) — the replay script.
- [`shadowOracle.ts`](../../src/validate/shadowOracle.ts),
  [`reconcileLiquidations.ts`](../../src/validate/reconcileLiquidations.ts) — the two validation
  scripts.

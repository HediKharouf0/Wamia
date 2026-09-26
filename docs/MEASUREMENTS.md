# Measurements

Every measurement this project has taken lives in its own `results/<name>/` folder: the raw
JSON data plus a `README.md` explaining what it measures and the exact command to reproduce it
on a fresh anvil fork. This file is the index — pick a folder below to see its data and its
reproduce command.

All fork-based measurements start from mainnet block `25829822` (just before the real August
2026 attack) unless noted otherwise, and need `$MAINNET_RPC_URL` set to an archive-capable RPC.

## Maker replay (spec 7.6): does Wamia stop the attack?

The Wamia SwapVM strategy shipped with real SY, replaying the real attack against it. Capital
sweep, latency 0 vs 1, adaptive vs historical attacker, guards on/off, persistent attacker.

| folder | what it varies |
|---|---|
| [`scenario-maker-0M-L1-adaptive-dmax30`](../results/scenario-maker-0M-L1-adaptive-dmax30/) | no Wamia strategy at all — the no-backstop baseline |
| [`scenario-maker-3M-L1-adaptive-dmax30`](../results/scenario-maker-3M-L1-adaptive-dmax30/) | 3M SY |
| [`scenario-maker-4M-L1-adaptive-dmax30`](../results/scenario-maker-4M-L1-adaptive-dmax30/) | 4M SY |
| [`scenario-maker-5M-L0-adaptive-dmax30`](../results/scenario-maker-5M-L0-adaptive-dmax30/) | 5M SY, latency 0 (same-block searcher) |
| [`scenario-maker-5M-L1-adaptive-dmax30`](../results/scenario-maker-5M-L1-adaptive-dmax30/) | 5M SY, latency 1 — the headline result |
| [`scenario-maker-5M-L1-adaptive-dmax30-guards`](../results/scenario-maker-5M-L1-adaptive-dmax30-guards/) | 5M SY, v2 guards on (RateGuard + SpendLimit) |
| [`scenario-maker-5M-L1-adaptive-extra1M-dmax30`](../results/scenario-maker-5M-L1-adaptive-extra1M-dmax30/) | 5M SY, persistent attacker pushes 1M more SY after the historical attack ends |
| [`scenario-maker-5M-L1-adaptive-extra2M-dmax30`](../results/scenario-maker-5M-L1-adaptive-extra2M-dmax30/) | 5M SY, persistent attacker pushes 2M more SY after the historical attack ends |
| [`scenario-maker-5M-L1-historical-dmax30`](../results/scenario-maker-5M-L1-historical-dmax30/) | 5M SY, the manipulator's exact historical calldata instead of adaptive slippage bounds |
| [`scenario-maker-6M-L1-adaptive`](../results/scenario-maker-6M-L1-adaptive/) | 6M SY |
| [`scenario-maker-6M-L1-adaptive-dmax30`](../results/scenario-maker-6M-L1-adaptive-dmax30/) | 6M SY, dmax 30 |
| [`scenario-maker-8M-L1-adaptive`](../results/scenario-maker-8M-L1-adaptive/) | 8M SY |
| [`scenario-maker-10M-L1-adaptive`](../results/scenario-maker-10M-L1-adaptive/) | 10M SY |

Each folder's own README has the exact `npm run scenario:maker -- ...` command for that run,
built from its own `summary.json`. Regenerate all of them at once with
[`npm run results:readmes`](../src/replay/writeRunReadmes.ts) after a new sweep.

Aggregated sweep data (not tied to one run): [`maker-results.md`](../results/maker-results.md),
[`maker-results.json`](../results/maker-results.json), and the `maker-sweep-*.json` files.

## Genuine-collapse scenarios (spec 7.6 step 6): does Wamia buy on real news?

[`collapse-scenarios`](../results/collapse-scenarios/) — five cases (control, switchoff, run,
loss, jump) checking Wamia refuses to buy when a price drop is real news rather than a
manipulated attack.

## Taker comparison: what can capital alone do, without Wamia?

The real attack replayed against a capitalized "taker" wallet that buys discounted PT directly
on Pendle, with no Wamia contracts shipped — the baseline the maker replay's numbers are
measured against.

| folder | capital |
|---|---|
| [`scenario-baseline-state-only`](../results/scenario-baseline-state-only/) | 0 (reference point) |
| [`scenario-taker-100k-L1`](../results/scenario-taker-100k-L1/) | 100k SY |
| [`scenario-taker-2M-L1`](../results/scenario-taker-2M-L1/) | 2M SY |
| [`scenario-taker-5M-L1`](../results/scenario-taker-5M-L1/) | 5M SY |

All four come from one script,
[`compareTakerVsBaseline.ts`](../src/replay/compareTakerVsBaseline.ts), run once.

## Historical replay: ground truth

[`baseline-historical`](../results/baseline-historical/) — the real August 2026 attack replayed
exactly as it happened on mainnet (real liquidations included), cross-checked against real
Morpho Blue `Liquidate` events fetched directly from mainnet logs. Every other measurement here
is checked against this one.

## Unit tests (not a fork replay)

[`src/pricing/units.test.ts`](../src/pricing/units.test.ts) checks the SY/PT conversion math
against real recorded buys from the taker runs above. Run with `npm test`.

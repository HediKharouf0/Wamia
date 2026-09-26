# Plan (updated Sep 27)

Source of truth for what is done and what comes next. The design spec lives in
the project notes (levee_project_context, sections 7.3 to 7.6); this file tracks
status against it. Track rules: official Aqua/SwapVM contracts, SwapVM use
scores higher, onchain transfers shown in the demo (a fork is fine), tests or a
UI, real commit history.

## Done

- Aqua v1.0.0 and AquaSwapVMRouter v1.0.2 confirmed at fork block 25829822 by
  the fork test (router domain "1inch SwapVM v1.0" 1.0.2). Extruction = 0x20.
- `LeveeQuoter` to spec 7.4 v1: direction and maturity, SY exchange-rate floor,
  depeg stop on the Curve reUSD/USDC pool (EMA only; the last price alone can be
  moved in one block), max-deviation stop, discount deepening with usage and
  priced over the trade's whole range. The shipped SY is the only cap.
- Spec 7.4 v2 core as separate Extruction steps: `LeveeRateGuard` (SY rate
  high-water mark, realized-yield check) and `LeveeSpendLimit` (share of the
  shipped SY per 12 s block, growing to 100% at maturity). State written only
  in swap mode and only from the router.
- TypeScript on the official SDKs (`src/aqua/levee.ts`), byte-for-byte parity
  with Solidity for the plain and the guarded program; local SDK demo.
- `LeveeArb` (zero capital, through `preTransferInCallback`) and the searcher
  bot, which sizes each arb by simulation and arbs in several rounds.
- Maker replay (spec 7.6): adaptive and historical attacker, latency 0 and 1,
  capital sweep, persistent attacker. 5M SY shipped gives zero eligible debt,
  with or without the guards; LP 11.3% annualized. Results in
  `results/maker-results.md`.
- Genuine-collapse scenarios (spec 7.6 step 6): switch-off attempt, run on
  reUSD, vault loss, news repricing. All five cases behave as designed
  (`results/collapse-scenarios.json`).
- Root README with the numbers and the limitations.

## Left before submission

1. Make the repo public; LICENSE.
2. Clean `results/` (raw replay logs, `scenario-test-*`, untracked sweep dirs)
   and legacy fixtures (`attacker_txs_filtered.json`,
   `liquidator_txs_filtered.json`, `scripts/replay.sh`); merge
   `config/scenario.json` into `config/addresses.json`.
3. Finish `FEEDBACK.md`.
4. Record the demo.

## Future work (spec v2, not built)

Cross-market check against other stablecoin PTs, updatable reference rate,
two-sided quoting, UI, `MaturityDutchAuction`.

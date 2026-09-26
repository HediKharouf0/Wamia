# Plan (updated Sep 27)

Source of truth for what is done and what comes next. The design spec lives in
the project notes (sections 7.3 to 7.6); this file tracks
status against it. Track rules: official Aqua/SwapVM contracts, SwapVM use
scores higher, onchain transfers shown in the demo (a fork is fine), tests or a
UI, real commit history.

## Done

- Aqua v1.0.0 and AquaSwapVMRouter v1.0.2 confirmed at fork block 25829822 by
  the fork test (router domain "1inch SwapVM v1.0" 1.0.2). Extruction = 0x20.
- `WamiaQuoter` to spec 7.4 v1: direction and maturity, SY exchange-rate floor,
  depeg stop on the Curve reUSD/USDC pool (EMA only; the last price alone can be
  moved in one block), max-deviation stop, discount deepening with usage and
  priced over the trade's whole range. The shipped SY is the only cap.
- Spec 7.4 v2 core as separate Extruction steps: `WamiaRateGuard` (SY rate
  high-water mark, realized-yield check) and `WamiaSpendLimit` (share of the
  shipped SY per 12 s block, growing to 100% at maturity). State written only
  in swap mode and only from the router.
- TypeScript on the official SDKs (`src/aqua/wamia.ts`), byte-for-byte parity
  with Solidity for the plain and the guarded program; local SDK demo.
- `WamiaArb` (zero capital, through `preTransferInCallback`) and the searcher
  bot, which sizes each arb by simulation and arbs in several rounds.
- Maker replay (spec 7.6): adaptive and historical attacker, latency 0 and 1,
  capital sweep, persistent attacker. 5M SY shipped gives zero eligible debt,
  with or without the guards; LP 11.3% annualized. Results in
  `results/maker-results.md`.
- Genuine-collapse scenarios (spec 7.6 step 6): switch-off attempt, run on
  reUSD, vault loss, news repricing. All five cases behave as designed
  (`results/collapse-scenarios/summary.json`).
- Root README with the numbers and the limitations.
- Repo cleanup: removed `scenario-test-*`, raw replay logs, `fixtures/scratch/`,
  the two legacy filtered-tx fixtures, and `scripts/replay.sh`; merged
  `config/scenario.json` into `config/addresses.json`; dropped the unused
  `decideTakerAction`/`TakerTrigger` from `strategies/taker.ts`.

## Left before submission

1. Make the repo public; LICENSE.
2. Finish `FEEDBACK.md`.
3. Record the demo.

## Future work (spec v2, not built)

Cross-market check against other stablecoin PTs, updatable reference rate,
two-sided quoting, UI, `MaturityDutchAuction`.

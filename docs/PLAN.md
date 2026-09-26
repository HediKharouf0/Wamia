# Plan (updated Sep 26)

Source of truth for what is done and what comes next. The design spec lives in
the project notes (levee_project_context, sections 7.3 to 7.6); this file tracks
status against it. Track rules: official Aqua/SwapVM contracts, SwapVM use
scores higher, onchain transfers shown in the demo (a fork is fine), tests or a
UI, real commit history.

## Done

- Aqua v1.0.0 and AquaSwapVMRouter v1.0.2 confirmed at fork block 25829822 by
  the fork test (router domain "1inch SwapVM v1.0" 1.0.2). Extruction = 0x20.
- Taker fixes: prices compared in asset terms, sizing toward the target, PnL
  total corrected, standing allowance. Sweep rerun and committed
  (100k: ~0 saved; 2M: 11.2M saved; 5M budget: 3.39M spent, 26.1M saved).
- Foundry project, `LeveeMath`, `LeveeQuoter` (first version), `LeveeOrders`,
  local end-to-end test on the official sources, mainnet fork test (4/4 pass).
- TypeScript side on the official SDKs (`src/aqua/levee.ts`), byte-for-byte
  parity with Solidity, local SDK demo (`npm run demo:local`).
- `LeveeArb` (zero-capital, flash-style through `preTransferInCallback`) with
  local tests; fork test written (replays the 11 manipulator txs).
- reUSD market price source found (spec 7.4 rule 4): Curve StableSwap-NG
  reUSD/USDC pool `0xf74c91b36c26543a0aa820bef407a577e5498bf0`, live at the
  fork block. It prices reUSD against its NAV (stored rate = SY.exchangeRate),
  so `1e36 / price_oracle(0)` is reUSD market / NAV (0.99997 at the fork
  block). EMA half-life ~20 min, ~$451K TVL. Pitch caveat: real but thin.

## Units, for the record

The PT's asset is USD with 6 decimals. `SY.exchangeRate()` is reUSD's NAV in
USD (1.0968 at the fork block). Where code or results say "reUSD per PT" they
mean USD per PT.

## Order from here

1. Rebuild `LeveeQuoter` to spec 7.4 (in progress):
   - depeg stop on the Curve pool: refuse if reUSD trades more than
     `maxDepegBps` below NAV by either the EMA or the last price;
   - SY exchange-rate floor (internal accounting loss only);
   - max-deviation stop: refuse if Pendle spot is more than `maxDeviationBps`
     below fair value (default 450 bp; Aug 25 was ~245 bp);
   - discount that deepens with backstop usage (`shippedSy - balanceOut`),
     priced over the trade's whole range so splitting never pays more;
   - no per-trade cap (splittable, so useless); the shipped SY is the cap.
   Then update the SDK side, parity vectors, and all tests.
2. User runs both fork tests (`LeveeForkTest`, `LeveeArbForkTest`).
3. `scenarioMaker.ts` (spec 7.6): LP strategies shipped at the fork block,
   the attack replayed, `LeveeArb` after every manipulator tx with real 12 s
   blocks, measured like the taker. Report manipulator tx statuses; add an
   adaptive-attacker mode. Headline: minimum standing capital for zero
   eligible debt, LP return at that size, versus the taker results.
4. Genuine-collapse scenarios (spec 7.6 step 6): Levee refuses on (a) reUSD
   market depeg with exchangeRate unchanged, (b) exchangeRate drop, (c) Pendle
   spot beyond `maxDeviationBps`.
5. Open decisions: the friend's risk rules (opcodes on a redeployed router or
   Extruction targets); whether a per-block spend limit (spec v2) goes in.
6. Submission: root README with the numbers, make the repo public, LICENSE,
   clean `results/` and legacy fixtures, merge `config/scenario.json`, finish
   `FEEDBACK.md`, record the demo.
7. Stretch (spec v2): per-block spend limit sized to the oracle window,
   exchange-rate high-water mark, yield check, cross-market check against
   other stablecoin PTs, updatable reference rate, two-sided quoting, UI,
   `MaturityDutchAuction`.

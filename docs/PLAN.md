# Next steps (revised Sep 26)

Replaces section 9 of the project notes. Checked against the track rules:
official Aqua/SwapVM contracts (redeploying a modified SwapVM is allowed),
SwapVM use scores higher, onchain token transfers shown in the demo (a fork
is fine), tests or a UI, and a real commit history.

## Done

- Old step 1: router and Aqua exist at the fork block (Etherscan: router
  deployed at 25618917, v1.0.2). Final proof is the fork test below.
- Old step 2: unit bug and PnL total fixed, taker sizing fixed. Rerun pending.
- Old steps 3 to 5: Foundry project, `LeveeMath`, `LeveeQuoter`, `LeveeOrders`,
  local end-to-end test on the official sources.
- Old step 6: fork test passes on mainnet state at block 25829822 (4/4):
  router domain "1inch SwapVM v1.0" 1.0.2, SY rate 1096798, Levee fair value
  0.9709907 vs Pendle spot 0.9709910, 100k PT sold for 88,441 SY through the
  deployed router.
- Old step 10 (better taker sizing): done as part of step 2.
- TypeScript side on the official SDKs (`src/aqua/levee.ts`), checked byte for
  byte against the Solidity side, with a local end-to-end demo
  (`npm run demo:local`). `scenarioMaker` should reuse these helpers.

## Order from here

1. Run on a machine with the RPC (blocks everything else):
   `npm install && npm run typecheck && npm test`, then
   `cd contracts && forge test` (with `ARCHIVE_RPC_URL` set), then
   `npx tsx src/replay/compareTakerVsBaseline.ts` and
   `npx tsx src/analysis/backstopPnl.ts`. Commit the new results.
2. Decide three design questions (they change the contracts):
   - Reference rate: fixed at ship time, or read from Pendle's onchain TWAP.
   - Where the friend's risk rules live: native opcodes on a redeployed
     router, or Extruction targets on the official router.
   - Discount: flat or laddered, and how deep (audit item 8).
3. `LeveeArb.sol` + fork test: flash-style, zero capital. Receive SY from
   Levee, buy PT on Pendle inside `preTransferInCallback`, the router then
   collects the PT. Reverts entirely if Levee refuses.
   Add `Deadline` before the Extruction in `LeveeQuoter.program` (audit item 7).
4. `scenarioMaker.ts` (the demo): ship strategies for several LP wallets at the
   fork block, replay the attack, run the arb every block with real 12 s block
   times, measure like the taker runs. Report manipulator tx statuses and add
   an adaptive-attacker mode (audit items 4 and 5). Output: minimum standing
   capital for zero eligible debt, LP return at that size, maker vs taker.
5. Risk rules v2, before the collapse demo: a price-based depeg check (audit
   item 6), a per-hour spend limit (swap-mode storage), and the friend's rules
   in whichever form step 2 chose. If they become opcodes, redeploy a modified
   v1.0.2 AquaSwapVMRouter against the official Aqua (drop unused opcodes to
   stay under 24 KB) and run the same tests on it.
6. Genuine-collapse scenario: show Levee refusing in a real depeg, which only
   works after step 5.
7. Submission: root README with the numbers, make the repo public, LICENSE,
   clean `results/` and legacy fixtures, merge `config/scenario.json`, finish
   `FEEDBACK.md` for 1inch, record the demo.
8. Stretch: UI, `MaturityDutchAuction` for seized collateral.

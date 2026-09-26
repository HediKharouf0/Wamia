# Levee contracts

Levee strategies are Aqua-shipped SwapVM orders whose program is a single
`Extruction` instruction calling `LeveeQuoter`. They run on the deployed
1inch contracts, unmodified:

| Contract | Address | Release |
|---|---|---|
| Aqua | `0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a` | aqua v1.0.0 |
| AquaSwapVMRouter | `0x111111338c5091E8440b67B168bAe16a668AC0De` | swap-vm v1.0.2 (block 25618917) |

## Files

- `src/LeveeMath.sol`: fair value `1/(1+y)^tau`, discount, PT <-> SY conversion
  (Pendle SY convention: `asset = sy * exchangeRate / 1e18`).
- `src/LeveeQuoter.sol`: the Extruction target. Prices every PT sale and
  enforces the rules below. Stateless, so quote and swap always agree.
- `src/LeveeOrders.sol`: builds the maker order and taker data with
  swap-vm's own `MakerTraitsLib` / `TakerTraitsLib`.
- `src/LeveeArb.sol`: zero-capital arbitrage. Sells PT to Levee strategies
  and, inside the router's `preTransferInCallback`, buys that PT back on
  Pendle with the SY it just received. The searcher needs no inventory.

## Quoter rules

All from maker parameters, onchain reads and block time, never from taker data:

1. Direction: only PT in, SY out.
2. Maturity: refuse at or after the market's expiry.
3. SY exchange-rate floor (`minSyRate`): catches a loss in reUSD's NAV.
4. Market depeg stop (`maxDepegBps`): refuse if reUSD trades more than this
   below its NAV on the Curve reUSD/USDC pool
   (`0xf74c91b36C26543A0Aa820bEf407A577e5498BF0`), by the pool's EMA price
   (half-life ~20 min). The pool is NAV-adjusted, so 1e18 means "at NAV".
   Catches a run, where the market price falls but the NAV does not. Not the
   last trade price: the pool is thin, and on the fork 60k reUSD dumped in one
   block was enough to move it past 1%, which would let an attacker switch
   Levee off right before pushing Pendle.
5. Max deviation (`maxDeviationBps`): refuse if Pendle's spot is more than
   this below fair value. A gap that large suggests real news, not a push.
6. Price: fair value at `refYieldWad`, minus a discount that deepens linearly
   with backstop usage from `discountMinBps` to `discountMaxBps`. A trade pays
   the average discount over the usage range it covers, so splitting a trade
   never pays the taker more in total.
7. Never pay more SY than the strategy holds. The shipped SY is the only cap;
   a per-trade cap would be pointless since trades can be split.

## Program and order

```
program = [0x20][149][LeveeQuoter address, 20 bytes][params, 129 bytes]
order   = MakerTraitsLib.build({ maker: lp, useAquaInsteadOfSignature: true, program })
ship    = aqua.ship(router, abi.encode(order), [SY, PT], [syAmount, 0])
```

`0x20` is Extruction's index in the v1.0.2 `AquaOpcodes` table (not the
`main` branch numbering). Parameters are packed (`encodeParams`) because an
instruction's args are limited to 255 bytes.

## Tests

```bash
git submodule update --init --recursive   # once
cd contracts
forge test                                # unit + local end-to-end (fork tests skipped)

set -a && source ../.env && set +a        # needs ARCHIVE_RPC_URL
forge test --mc LeveeForkTest -vv         # against mainnet at block 25829822
forge test --mc LeveeArbForkTest -vv
```

- `LeveeMath.t.sol`: prices against 60-digit reference values (same formula
  as `src/pricing/fairValue.ts`), rounding direction, conversions.
- `LeveeQuoter.t.sol`: every rule, called the way Extruction calls it,
  including a fuzz test that splitting a trade never pays more.
- `LeveeAquaLocal.t.sol`: deploys Aqua v1.0.0 and AquaSwapVMRouter v1.0.2 from
  their release tags and runs ship, quote, swap, dock with real transfers.
- `LeveeArb.t.sol`: the zero-capital arbitrage against a mock Pendle router.
- `fork/LeveeFork.t.sol`: the same flow on the deployed contracts with real
  PT/SY, plus checks against Pendle's and Curve's own state (including a
  reUSD depeg on Curve making the quote refuse).
- `fork/LeveeArbFork.t.sol`: the arbitrage against the real Pendle router.
- `SdkParity.t.sol`: the TypeScript side builds orders with `@1inch/swap-vm-sdk`
  and `@1inch/aqua-sdk` (`src/aqua/levee.ts`). This test requires the SDK output
  (`test/fixtures/sdk-vectors.json`, regenerated with `npm run sdk:vectors`)
  to match LeveeQuoter/LeveeOrders byte for byte, including the strategy hash.

From the repo root, `npm run demo:local` runs the whole flow with SDK-built
transactions on a local Anvil chain: deploy, ship, quote, swap, SY-rate and
market-depeg refusals, dock. It needs `forge build` first, and no RPC key.

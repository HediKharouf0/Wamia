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
  enforces the v1 rules (direction, maturity, depeg floor, per-trade cap,
  shipped-SY cap). Stateless, so quote and swap always agree.
- `src/LeveeOrders.sol`: builds the maker order and taker data with
  swap-vm's own `MakerTraitsLib` / `TakerTraitsLib`.

## Program and order

```
program = [0x20][122][LeveeQuoter address, 20 bytes][params, 102 bytes]
order   = MakerTraitsLib.build({ maker: lp, useAquaInsteadOfSignature: true, program })
ship    = aqua.ship(router, abi.encode(order), [SY, PT], [syAmount, 0])
```

`0x20` is Extruction's index in the v1.0.2 `AquaOpcodes` table (not the
`main` branch numbering). Parameters are packed because an instruction's
args are limited to 255 bytes.

## Tests

```bash
git submodule update --init --recursive   # once
cd contracts
forge test                                # unit + local end-to-end (fork test skipped)

set -a && source ../.env && set +a        # needs ARCHIVE_RPC_URL
forge test --mc LeveeForkTest -vv         # against mainnet at block 25829822
```

- `LeveeMath.t.sol`: prices against 60-digit reference values (same formula
  as `src/pricing/fairValue.ts`), rounding direction, conversions.
- `LeveeQuoter.t.sol`: every rule, called the way Extruction calls it.
- `LeveeAquaLocal.t.sol`: deploys Aqua v1.0.0 and AquaSwapVMRouter v1.0.2 from
  their release tags and runs ship, quote, swap, dock with real transfers.
- `fork/LeveeFork.t.sol`: the same flow on the deployed contracts with real
  PT/SY, plus unit checks against Pendle's own state.

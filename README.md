# Wamia

> **1inch "Build an Aqua App" track** · Built on 1inch Aqua & SwapVM

Wamia is a standing liquidity backstop for Pendle PT markets. LPs ship SY to a Wamia strategy on Aqua; the strategy buys PT at a small discount to fair value, but only while the market looks manipulated rather than genuinely repriced. When someone dumps PT into a thin Pendle pool, a zero-capital searcher sells that PT to Wamia and buys it back on Pendle in the same transaction, pulling the price back up before a lending oracle can follow it down.

Everything runs on the deployed Aqua (v1.0.0) and AquaSwapVMRouter (swap-vm v1.0.2), unmodified, tested on a mainnet fork against the real Pendle, Morpho and Curve contracts.

---

## The Problem — Aug 25, 2026

PT-reUSD (Pendle, matures Dec 10, 2026) is used as collateral on Morpho, looped to ~91% LTV. One wallet bought YT eleven times in ~9 minutes, forcing Pendle's router to sell PT into a thin pool. A few hundred thousand dollars of YT moved millions of PT and pushed the price down ~3%. Morpho's oracle (a 15-minute TWAP of Pendle's rate) followed, and leveraged borrowers got liquidated — even though PT's value at maturity never changed.

| | Without a backstop |
|---|---|
| Debt eligible for liquidation | $37.35M across 20 positions |
| Oracle low | 0.9472 |

No one was standing there with a deep bid, and a bot that reacts after the fact is too late — the oracle is an average, so minutes spent near the bottom keep dragging it down even after spot recovers.

---

## The Idea

A bid that's always there, funded by capital that's doing something else in the meantime.

- **Aqua** lets an LP ship SY to a strategy without locking it — balance stays in the LP's own wallet.
- **SwapVM** runs the strategy's program on every quote and swap, so the bid is priced onchain from live Pendle/Curve/SY state at the moment of the trade.
- The bid is **standing**, so it fills the block right after every manipulator trade — spot never sits low long enough to drag the oracle average down.
- LPs earn by buying PT below fair value; PT redeems at par at maturity.

```
LP wallet (SY) --ship--> Aqua --> AquaSwapVMRouter
                                     program: [Extruction -> WamiaRateGuard]   optional, v2
                                              [Extruction -> WamiaQuoter]      prices PT -> SY
                                              [Extruction -> WamiaSpendLimit]  optional, v2

Searcher --> WamiaArb.arb():  sell PT to Wamia via the router
                              -> in preTransferInCallback, buy that PT on Pendle with the SY just received
                              -> keep the leftover PT as profit (zero capital, reverts if not profitable)
```

`WamiaQuoter` prices every PT sale and refuses it outright in any of these cases:

| Check | Refuses when |
|---|---|
| Maturity | at or after the PT's expiry |
| Vault loss | SY's exchange rate (reUSD's NAV) is below the LP's floor |
| Run on the peg | reUSD trades >1% below NAV on Curve, by the pool's EMA |
| News vs. push | Pendle's spot is >4.5% below fair value (Aug 25 was ~2.45%) |
| _(otherwise)_ | pays fair value `1/(1+y)^t` minus a discount that deepens from 10bp to `discountMaxBps` as the backstop is used |

Two v2 guards add further Extruction steps an LP can opt into: `WamiaRateGuard` (refuses if the SY rate drops below its own high-water mark, or if reUSD's realized yield runs far above reference) and `WamiaSpendLimit` (caps spend per 12s block, growing toward maturity, so a bug or an undetected real collapse can't drain a strategy in one block). Both key their state by order hash and only the router can write it, so quoting never burns budget. Full parameter details: [`contracts/README.md`](contracts/README.md).

---

## Stack

| Layer | Technology |
|---|---|
| Contracts | Solidity, Foundry — built against 1inch's deployed Aqua v1.0.0 / swap-vm v1.0.2 releases |
| Order building | `@1inch/swap-vm-sdk`, `@1inch/aqua-sdk` (TS side matches the Solidity byte-for-byte, incl. strategy hash) |
| Simulation | `viem`, anvil mainnet fork replays |
| App | Vite + React |

---

## Results

Fork replay at block 25829822, real 12s blocks, the Aug 25 attack replayed with an **adaptive** attacker (same SY per trade as on the day, fresh slippage bounds — it doesn't give up just because Wamia moved the price). Full tables: [`results/maker-results.md`](results/maker-results.md).

| Setup | Capital | Debt eligible for liquidation | Oracle min |
|---|---|---|---|
| No backstop | 0 | $37.35M (20 positions) | 0.9472 |
| Reactive taker bot (buys after the drop) | 5M SY budget | $11.23M | 0.9629 |
| Wamia | 3M SY shipped | $13.02M (8) | 0.9615 |
| Wamia | 4M SY shipped | $0.20M (1) | 0.9650 |
| Wamia | 5M SY shipped (4.60M used) | $0 | 0.9671 |
| Wamia + v2 guards | 5M SY shipped (4.54M used) | $0 | 0.9669 |

At 5M SY: LP's average buy price was 0.9691 USD/PT against a fair value of ~0.971 — 3.18% over 107 days, 11.3% annualized, above the 10.58% a buyer at fair value would get. The searcher made ~8,900 PT with zero capital. Result holds with the arb landing in the same block as each push, and with the attacker's exact historical calldata.

**Genuine collapses — Wamia has to step aside**, or a backstop that buys into a real collapse is just a loss (`npm run scenario:collapse`):

| Case | What happens | Wamia |
|---|---|---|
| Control (the Aug 25 push) | — | buys |
| Switch-off attempt | 60k reUSD dumped on Curve, one block, EMA barely moves | buys (one block can't fake it) |
| Run on reUSD | 80k reUSD sold, held 19 min, EMA 0.9899 of NAV | refuses (`UnderlyingDepegged`) |
| Vault loss | SY rate 1.0968 → 1.0420 | refuses (`SyBelowFloor`) |
| News repricing | Pendle's rate moved 6% below fair | refuses (`SpotTooFarBelowFair`) |

---

## The App

Four screens in `app/` (`npm run app`, then open `http://localhost:5173`):

| Screen | What it shows |
|---|---|
| Aug 25 replay | The fork run played back block by block, with/without Wamia side by side — spot, oracle, borrowers turning liquidatable, each attack tx. Reads committed results, no chain needed. |
| Protect a market | An LP picks a size/discount, ships to Aqua, watches the searcher fill it live. |
| Is it protected? | Fair value vs. oracle, backstop capacity vs. debt at risk, each safety rule as a light. |
| Inspect a strategy | The order's program decoded step by step, checked against this repo's build; a live quote tester. |

The last three run against a live local chain:

```bash
anvil --fork-url "$ARCHIVE_RPC_URL" --fork-block-number 25829822    # terminal 1 (plain `anvil` also works, with mocks)
npm run app:server                                                   # terminal 2: deploys Wamia on that chain
npm run app                                                          # terminal 3
```

---

## Key Addresses

| Contract | Address | Release |
|---|---|---|
| Aqua | `0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a` | aqua v1.0.0 |
| AquaSwapVMRouter | `0x111111338c5091E8440b67B168bAe16a668AC0De` | swap-vm v1.0.2 |
| Pendle market (PT-reUSD) | `0x13285bcbc27f92b47b4edb99d744c07b48c977c0` | fork target, block 25829822 |

---

## Repository Layout

```
p1nch/
├── contracts/
│   ├── src/           WamiaQuoter, WamiaMath, WamiaOrders, WamiaArb, WamiaRateGuard, WamiaSpendLimit
│   └── test/           unit, local end-to-end, SDK parity, fork/ (mainnet state)
├── src/
│   ├── aqua/           building & shipping orders with the 1inch SDKs, fork helpers, local demo
│   ├── strategies/      the searcher (sizes each arb by simulation), the earlier taker bot
│   ├── replay/          fork replays (compareMaker.ts, scenarioMaker.ts, collapseScenarios.ts), attacker modes
│   ├── pricing/         fair value, discount curve
│   ├── health/          Morpho position health
│   ├── measure/         what each run measures
│   └── app/             local server; app:data rebuilds replay data from results/
├── app/                Vite + React app
├── results/            committed run outputs and summary tables
└── FEEDBACK.md         what we ran into with Aqua, SwapVM and the SDKs
```

---

## Run It

**Prerequisites:** Node 20+, Foundry, a mainnet archive RPC (for the fork parts).

### 1 — Clone and install

```bash
git clone --recurse-submodules https://github.com/HediKharouf0/p1nch.git && cd p1nch
npm install
```

### 2 — Configure environment

```bash
cp .env.example .env    # set ARCHIVE_RPC_URL
```

### 3 — Build and test contracts

```bash
cd contracts && forge build && forge test           # unit + local end-to-end
set -a && source ../.env && set +a
forge test --mc WamiaForkTest -vv                   # against the deployed contracts at block 25829822
forge test --mc WamiaArbForkTest -vv
cd ..
```

### 4 — Test and run the TS side

```bash
npm run typecheck && npm test
npm run demo:local              # SDK-built ship/quote/swap/refusals/dock on a local anvil, no RPC needed
```

### 5 — Run a replay

```bash
anvil --fork-url "$ARCHIVE_RPC_URL" --fork-block-number 25829822   # separate terminal
npm run scenario:maker -- --capital 5 --dmax 30                    # add --guards for the v2 steps
npm run scenario:collapse
```

---

## Common Issues

| Problem | Fix |
|---|---|
| `forge test --mc WamiaForkTest` fails to connect | `ARCHIVE_RPC_URL` isn't sourced in that shell — `source .env` again |
| Replay script hangs | Anvil isn't running on port 8545, or isn't forked at block `25829822` |
| A replay run is slow | Normal — mostly anvil fetching mainnet state and mining blocks (the guarded 5M run took 3.9 min) |
| App shows stale data | Re-run `npm run app:data` to rebuild `app/src/data/*.json` from `results/` |

---

## License

ISC (see `package.json`)

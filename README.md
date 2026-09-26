# Levee

A standing liquidity backstop for Pendle PT markets, built as an Aqua app on 1inch SwapVM.

LPs ship SY to a Levee strategy on Aqua. The strategy buys PT at a small discount to its fair value, and only while the market looks like it's being pushed rather than repriced. When someone dumps PT into a thin Pendle pool, a searcher sells that PT to Levee and buys it back on Pendle in the same transaction, with no capital of its own. That pulls Pendle's price back up before a lending oracle can follow it down.

Built for the 1inch "Build an Aqua App" track. Everything runs on the deployed Aqua (v1.0.0) and AquaSwapVMRouter (swap-vm v1.0.2), unmodified, and is tested on a mainnet fork against the real Pendle, Morpho and Curve contracts.

## The problem: Aug 25, 2026

PT-reUSD (Pendle, maturity Dec 10, 2026) is used as collateral on Morpho, looped to about 91% LTV. On Aug 25 one wallet bought YT eleven times in about nine minutes. Each YT buy makes Pendle's router sell PT into the pool, so a few hundred thousand dollars of YT moved millions of PT and pushed the PT price down about 3%. Morpho's oracle, a TWAP of Pendle's rate over about 15 minutes, followed. Leveraged borrowers got liquidated, though PT's value at maturity never changed.

Our fork replay of that morning (block 25829822, the 11 manipulator transactions and the background trades, liquidations skipped so we can measure what would have been liquidatable) gives $37.35M of debt across 20 positions eligible for liquidation, with the oracle bottoming at 0.9472.

Nobody was standing there with a deep bid. Keeping idle capital as a standby buyer is expensive, and a bot that reacts after the fact is too late: the oracle is an average, so the minutes spent near the bottom keep dragging it down even after spot recovers.

## The idea

A bid that is always there, funded by capital that is doing something else in the meantime.

- Aqua lets an LP ship SY to a strategy without locking it. The balance stays in the LP's wallet, so the same wallet can back Levee on several PT markets at once.
- SwapVM runs the strategy's program on every quote and swap. Levee's program is a few Extruction instructions that call our pricing and risk contracts, so the bid is priced onchain from live Pendle, Curve and SY state at the moment of the trade.
- The bid is standing, so it fills after every manipulator trade, in the next block. Spot never sits low long enough to pull the oracle average down.
- LPs earn by buying PT below fair value. PT redeems at par at maturity.

## How it works

```
LP wallet (SY) --ship--> Aqua --> AquaSwapVMRouter
                                     program: [Extruction -> LeveeRateGuard]   optional, v2
                                              [Extruction -> LeveeQuoter]      prices PT -> SY
                                              [Extruction -> LeveeSpendLimit]  optional, v2

Searcher --> LeveeArb.arb():  sell PT to Levee via the router
                              -> in preTransferInCallback, buy that PT on Pendle with the SY just received
                              -> keep the leftover PT as profit (zero capital, reverts if not profitable)
```

`LeveeQuoter` is the pricing step. For every PT sale it:

1. only accepts PT in and SY out, and refuses at or after maturity;
2. refuses if SY's exchange rate (reUSD's NAV) is below the LP's floor: a real loss in the vault;
3. refuses if reUSD trades more than 1% below its NAV on the Curve reUSD/USDC pool, by the pool's EMA: a run on reUSD, where the market price falls but the NAV doesn't;
4. refuses if Pendle's spot is more than 4.5% below fair value: a gap that large looks like news, not a push (Aug 25 was about 2.45%);
5. otherwise pays fair value `1/(1+y)^t` at the LP's reference yield, minus a discount that deepens from 10 bp to `discountMaxBps` as the backstop is used. A trade pays the average discount over the range it covers, so splitting a trade never pays more.

The v2 rules are separate Extruction steps an LP can add around it:

- `LeveeRateGuard` (before pricing): refuses if the SY rate drops below the highest rate the strategy has seen, and, after a few days, if reUSD's realized yield is far above the reference (PT would then be worth less than Levee thinks).
- `LeveeSpendLimit` (after pricing): at most a share of the shipped SY per 12 s block (20% in our runs), growing to 100% as maturity approaches, so a pricing bug or an undetected real collapse can't empty a strategy in one block.

Both keep their state keyed by the order hash and write it only in swap mode and only from the router, so quotes never move it and nobody can burn a strategy's budget from outside. Details, parameters and the program layout are in [contracts/README.md](contracts/README.md).

The TypeScript side builds the same orders with `@1inch/swap-vm-sdk` and `@1inch/aqua-sdk`; a Foundry test checks them against the Solidity byte for byte, including the strategy hash.

## Results

All numbers come from a mainnet fork at block 25829822 replaying the Aug 25 attack with real 12 s blocks. The searcher runs our bot (`src/strategies/searcher.ts`) and lands one block after each manipulator trade. The attacker is adaptive: same SY per trade as on the day, with fresh slippage bounds, so it doesn't give up just because Levee moved the price. Full tables in [results/maker-results.md](results/maker-results.md).

| Setup | Capital | Debt eligible for liquidation | Oracle min |
|---|---|---|---|
| No backstop | 0 | $37.35M (20 positions) | 0.9472 |
| Reactive taker bot (buys after the drop) | 5M SY budget | $11.23M | 0.9629 |
| Levee | 3M SY shipped | $13.02M (8) | 0.9615 |
| Levee | 4M SY shipped | $0.20M (1) | 0.9650 |
| Levee | 5M SY shipped (4.60M used) | $0 | 0.9671 |
| Levee with the v2 guards | 5M SY shipped (4.54M used) | $0 | 0.9669 |

5M SY is about $5.5M. With the guards on, the spend limit bound once (1,000,000 SY in the block after the eighth push) and the searcher finished the job in the next block, with the same outcome.

What the LP gets at 5M: an average price of 0.9691 USD per PT against a fair value of about 0.971, so holding to maturity returns 3.18% over 107 days, 11.3% annualized, above the 10.58% a buyer at fair value would get. The searcher made about 8,900 PT with zero capital, so the arb pays for itself.

The 5M result also holds with the arb in the same block as each push (latency 0) and with the attacker's exact historical calldata.

### Genuine collapses: Levee must step aside

A backstop that buys into a real collapse is just a loss. `npm run scenario:collapse` pushes the fork into each case and checks Levee's decision:

| Case | What happens | Levee |
|---|---|---|
| control | the Aug 25 push | buys |
| switch-off attempt | 60k reUSD dumped on Curve in one block, last price 0.9865 of NAV, EMA still 0.9999 | buys (one block can't switch it off) |
| run on reUSD | 80k reUSD sold and held 19 min, EMA 0.9899 of NAV, NAV unchanged | refuses (`UnderlyingDepegged`) |
| vault loss | SY rate 1.0968 to 1.0420 | refuses (`SyBelowFloor`) |
| news repricing | Pendle's rate moved to 6% below fair | refuses (`SpotTooFarBelowFair`) |

A detail from the last case: Pendle's own pool refused trades that would take spot more than about 2.2 to 2.6% below fair, so trades alone couldn't reach the 4.5% stop. We had to edit the market's stored rate to simulate a repricing.

## What it doesn't do

- It's a shield sized to the flow, not a wall. An attacker who keeps buying YT after the historical attack drains it: 200k SY of extra YT buys (which Pendle turns into 20 to 35 times as much PT) used up the whole 5M, and eligible debt went back to $37.35M. Deeper capital or more LPs raise the bar; they don't remove it.
- The depeg stop reads a thin pool (about $450K on Curve) through an EMA with a ~20 min half-life. That's deliberate, so one block can't switch Levee off, but it also means a real run takes a while to register, and someone willing to hold a dump for long enough can switch it off.
- The reference yield is fixed at ship. After a real repricing, a strategy keeps bidding the old fair value until the deviation stop, the yield check or the LP docks it. An updatable reference rate is future work.
- Levee is passive. It needs a searcher to route PT to it. We ship the arb contract and bot, and it's profitable, but on mainnet it would rely on searchers or 1inch resolvers picking it up.
- Aqua's shipped balances are allowances, not reservations. An LP who ships the same SY to several strategies sees swaps fail once the wallet runs short.
- Replays skip the 29 historical liquidations and measure eligible debt from position health. Hackathon code, not audited.

Not built yet from the v2 list: a cross-market check against other stablecoin PTs, an updatable reference rate, two-sided quoting, a UI, and a Dutch auction to exit PT near maturity.

## Run it

Requirements: Node 20+, Foundry, and a mainnet archive RPC for the fork parts.

```bash
git clone --recurse-submodules https://github.com/HediKharouf0/p1nch.git && cd p1nch
npm install
cp .env.example .env            # set ARCHIVE_RPC_URL

cd contracts && forge build && forge test   # unit + local end to end on Aqua/router built from their release tags
set -a && source ../.env && set +a
forge test --mc LeveeForkTest -vv           # the deployed contracts at block 25829822
forge test --mc LeveeArbForkTest -vv
cd ..

npm run typecheck && npm test
npm run demo:local              # SDK-built ship, quote, swap, refusals, dock on a local anvil (no RPC)
```

The replays need an anvil fork on port 8545:

```bash
anvil --fork-url "$ARCHIVE_RPC_URL" --fork-block-number 25829822    # separate terminal
npm run scenario:maker -- --capital 5 --dmax 30             # add --guards for the v2 steps
npm run scenario:collapse
```

A replay run takes a few minutes on a laptop (the guarded 5M run took 3.9 min), mostly anvil fetching mainnet state and mining blocks.

## Repo map

- `contracts/src/`: `LeveeQuoter`, `LeveeMath`, `LeveeOrders`, `LeveeArb`, `LeveeRateGuard`, `LeveeSpendLimit`.
- `contracts/test/`: unit, local end to end on the official sources, SDK parity, and `fork/` tests on mainnet state.
- `src/aqua/`: building and shipping orders with the 1inch SDKs, fork helpers, the local demo.
- `src/strategies/`: the searcher (sizes each arb by simulation) and the earlier taker bot.
- `src/replay/`: the fork replays (`compareMaker.ts`, `scenarioMaker.ts`, `collapseScenarios.ts`) and the attacker modes.
- `src/pricing/`, `src/health/`, `src/measure/`: fair value, Morpho position health, what each run measures.
- `results/`: committed run outputs and the summary tables.
- `FEEDBACK.md`: what we ran into with Aqua, SwapVM and the SDKs.

# 5M SY with the v2 guards: full run

`run.log` is the complete console output of this run, on a MacBook against an anvil fork of mainnet at
block 25829822. It was recorded before the project was renamed, so the output still says Levee where it now says
Wamia. To rerun it:

```bash
anvil --fork-url "$ARCHIVE_RPC_URL" --fork-block-number 25829822    # separate terminal
cd contracts && forge build
cd .. && npm run scenario:maker -- --capital 5 --dmax 30 --guards
```

The other files in this folder are the same run as data: `summary.json` (the totals), `arbs.json` (every arb
the searcher sent) and `timeseries.json` (the 77 measurements of prices, the oracle and every borrower's health).

## Reading the log

- `manip-N ok: spot ...`: the attacker's Nth push replayed, and Pendle's PT price right after it.
- `[arb N after manip-M]`: the searcher's Nth arb after that push. Wamia bought PT, the searcher bought it back on
  Pendle in the same transaction and kept the difference. `bid now` is Wamia's next price. `(26 sims, 23 ms)` is
  the searcher's decision: how many trades it simulated to pick the size, and how long that took.
- `[no arb ...]`: the searcher checked and there was nothing worth doing.
- `[spend limit reached ...]`: WamiaSpendLimit refused because the strategy had paid out its 1,000,000 SY for that
  12 s block. The searcher came back the next block and finished.
- The summary at the end: SY used, the lowest oracle price, and the debt that was eligible for liquidation at the
  worst moment (here $0).

## Why a run takes minutes when the bot decides in milliseconds

The whole run took 3.9 min. The searcher's decisions took about 1 s of that: 21 decisions, about 440 simulated
trades, usually 20 to 30 ms per decision.

The rest is the test harness. Each run rebuilds 21 minutes of mainnet on the fork:

- it resets the fork, deploys our contracts and ships the strategy;
- it replays 25 historical transactions: the 11 attack pushes, 4 Pendle trades and 10 Morpho transactions (the 29
  liquidations are skipped, so we can measure what would have been liquidatable);
- it sends the searcher's 17 arbs;
- it mines an empty block every minute, and 30 more after the attack, so the oracle can be followed;
- it takes 77 measurements, each reading Pendle's state, the Morpho oracle and every borrower's position.

The slow part is anvil. The fork starts from mainnet at block 25829822 but doesn't hold mainnet's data: each time a
transaction or a read touches a storage slot anvil hasn't seen yet, it fetches that slot from the RPC provider over
the internet, one request at a time. Pendle swaps and the Morpho oracle touch many slots, so most of the run is
spent waiting on the network.

Two things made earlier runs much longer:

- A sweep command runs several scenarios back to back: the default `npm run scenario:maker` runs 0, 1, 2, 3, 4 and
  5M, six runs in one command.
- Early runs reset the fork in a way that threw away everything anvil had downloaded, so each run fetched the same
  data again. Runs now revert to a snapshot of the fork instead, which keeps it.

None of this applies to a real searcher on mainnet: it runs next to a live node that already has the state, and the
only time that matters is the decision itself.

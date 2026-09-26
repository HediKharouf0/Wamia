import { maximize, splitLegs } from "./searcher.js";

function check(ok: boolean, label: string) {
  if (!ok) throw new Error(`FAIL: ${label}`);
  console.log(`OK: ${label}`);
}

async function main() {
  // Profit rises, peaks at 400k, falls to zero at 800k, then the arb reverts.
  const PT = 10n ** 6n;
  const profit = async (x: bigint) => (x > 800_000n * PT ? null : (x * (800_000n * PT - x)) / (10n ** 12n));

  const wide = await maximize(profit, 0n, 6_000_000n * PT, 100n * PT);
  check(wide.x > 399_000n * PT && wide.x < 401_000n * PT, `finds the peak inside a mostly reverting range (x = ${wide.x / PT} PT)`);
  check(wide.evals <= 40, `within the evaluation budget (${wide.evals} sims)`);

  const narrow = await maximize(async (x) => (x > 3_000n * PT ? null : x * (3_000n * PT - x)), 0n, 6_000_000n * PT, 10n * PT);
  check(narrow.value !== null && narrow.x > 1_400n * PT && narrow.x < 1_600n * PT, `finds a small opportunity (x = ${narrow.x / PT} PT)`);

  const none = await maximize(async () => null, 0n, 1_000_000n * PT, 100n * PT);
  check(none.value === null, "reports no opportunity when every size reverts");

  const order = (maker: `0x${string}`) => ({ build: () => ({ maker, traits: 0n, data: "0x" as const }) }) as any;
  const legs = splitLegs(
    [
      { order: order("0x0000000000000000000000000000000000000001"), balanceSy: 3n * 10n ** 24n },
      { order: order("0x0000000000000000000000000000000000000002"), balanceSy: 0n },
      { order: order("0x0000000000000000000000000000000000000003"), balanceSy: 1n * 10n ** 24n },
    ],
    1_000_001n
  );
  check(legs.length === 2, "skips an empty strategy");
  check(legs[0]!.ptAmount === 750_000n && legs[1]!.ptAmount === 250_001n, "splits by SY left, remainder to the last leg");

  console.log("\nAll searcher tests passed.");
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { fork } from "../chain/client.js";
import { sendHistoricalTx, mineEmptyBlockAt, explainRevert } from "./actions.js";
import { measurePoint, readAllPositions } from "../measure/measure.js";

const TICK_SECONDS = 60;
const POST_TICKS = 30;

function gasLimitFor(mainnetGas: bigint) {
  return mainnetGas * 2n > 1_000_000n ? mainnetGas * 2n : 1_000_000n;
}

function printPoint(p: any) {
  const m = p.markets;
  const usd = (x: string) => (Number(x) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 0 });
  console.log(
    `${p.label.padEnd(18)} blk ${p.block} | PT ${p.ptSpotPrice.toFixed(4)} | y ${(p.impliedYield * 100).toFixed(2)}% | ` +
      `oracle ${p.oraclePrice.toFixed(4)} | USDC liq ${m.usdc.liquidatableCount} ($${usd(m.usdc.liquidatableDebt)}) | ` +
      `USDT liq ${m.usdt.liquidatableCount} ($${usd(m.usdt.liquidatableDebt)})`
  );
}

async function main() {
  const plan: any[] = JSON.parse(readFileSync("fixtures/replay-plan.json", "utf8"));

  const points: any[] = [];
  const record = (p: any) => {
    points.push(p);
    printPoint(p);
  };

  let block = await fork.getBlockNumber();
  let positions = await readAllPositions(fork, block);
  const t0 = await measurePoint(fork, "t0", block, positions);
  record(t0);

  let lastTs = t0.timestamp;
  const counters: Record<string, number> = {};
  const statusByRole: Record<string, { ok: number; total: number }> = {};

  for (const ev of plan) {
    const ts = Number(ev.timeStamp);

    while (ts - lastTs > TICK_SECONDS) {
      lastTs += TICK_SECONDS;
      block = await mineEmptyBlockAt(fork, lastTs);
      record(await measurePoint(fork, "tick", block, positions));
    }

    const receipt = await sendHistoricalTx(fork, ev, gasLimitFor(BigInt(ev.gasUsed)));
    block = receipt.blockNumber;
    lastTs = ts;

    if (receipt.status !== "success") {
      console.log(`    reverted (${ev.kind}, mainnet block ${ev.blockNumber}): ${await explainRevert(fork, receipt.transactionHash)}`);
    }

    counters[ev.role] = (counters[ev.role] ?? 0) + 1;
    const s = (statusByRole[ev.role] ??= { ok: 0, total: 0 });
    s.total++;
    if (receipt.status === "success") s.ok++;

    // Any tx touching our Morpho markets can change positions (liquidations, repays, collateral changes)
    if (ev.kind.startsWith("liquidation") || ev.kind === "morpho-other") {
      positions = await readAllPositions(fork, block);
    }

    const tag = receipt.status === "success" ? "ok" : "REV";
    const p = await measurePoint(fork, `${ev.role.slice(0, 5)}-${counters[ev.role]} ${tag}`, block, positions);
    record({ ...p, txHash: ev.hash, txRole: ev.role, txKind: ev.kind, txStatus: receipt.status });
  }

  for (let k = 0; k < POST_TICKS; k++) {
    lastTs += TICK_SECONDS;
    block = await mineEmptyBlockAt(fork, lastTs);
    record(await measurePoint(fork, "post-tick", block, positions));
  }

  mkdirSync("results/baseline-historical", { recursive: true });
  writeFileSync("results/baseline-historical/timeseries.json", JSON.stringify(points, null, 2));

  console.log(`\nSummary`);
  console.log(`  PT spot: ${t0.ptSpotPrice.toFixed(4)} -> min ${Math.min(...points.map((p) => p.ptSpotPrice)).toFixed(4)}`);
  console.log(`  Oracle:  ${t0.oraclePrice.toFixed(4)} -> min ${Math.min(...points.map((p) => p.oraclePrice)).toFixed(4)}`);
  for (const [role, s] of Object.entries(statusByRole)) console.log(`  ${role}: ${s.ok}/${s.total} succeeded`);
  console.log(`  Written to results/baseline-historical/timeseries.json`);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
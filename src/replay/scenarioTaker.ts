import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { fork } from "../chain/client.js";
import { resetFork, sendHistoricalTx, mineEmptyBlockAt } from "./actions.js";
import { measurePoint, readAllPositions } from "../measure/measure.js";
import { readPendleSnapshot } from "../snapshot/pendle.js";
import { readMorphoSnapshot } from "../snapshot/morpho.js";
import { dealErc20AtSlot } from "./dealErc20.js";
import { buyPt, getTokenDecimals } from "../strategies/taker.js";
import { decideAndSizeBuy } from "../strategies/binarySearch.js";
import { assessRisk } from "../strategies/riskModel.js";
import addresses from "../../config/addresses.json" with { type: "json" };
import { getAddress, keccak256, toBytes, encodeFunctionData } from "viem";

const SY_BALANCE_SLOT = 2;
const FORK_BLOCK = 25829822n;
const TICK_SECONDS = 60;
const TWAP_WINDOW_SEC = 900;
const REACTION_SEC = 12;

function gasLimitFor(mainnetGas: bigint) {
  return mainnetGas * 2n > 1_000_000n ? mainnetGas * 2n : 1_000_000n;
}

export type TakerRunConfig = {
  latencyBlocks: number;
  capitalSy: bigint;
  label: string;
};

function buildLadderFromFixtures(): { liqPrice: number; debt: number }[] {
  const marketNames = ["usdc", "usdt"] as const;
  const ladder: { liqPrice: number; debt: number }[] = [];

  for (const name of marketNames) {
    const lltv = BigInt((addresses.morphoMarkets as any)[name].lltv);
    const healths: any[] = JSON.parse(readFileSync(`fixtures/health-${name}-forkblock.json`, "utf8"));
    for (const h of healths) {
      const debt = BigInt(h.borrowAssets);
      const collateral = BigInt(h.collateral);
      if (debt === 0n || collateral === 0n) continue;
      const liqRaw = (debt * 10n ** 36n * 10n ** 18n) / (collateral * lltv);
      const liqPrice = Number(liqRaw) / 1e36;
      if (!Number.isFinite(liqPrice)) continue;
      ladder.push({ liqPrice, debt: Number(debt) / 1e6 });
    }
  }

  return ladder.sort((a, b) => b.liqPrice - a.liqPrice);
}

export async function runTakerScenario(config: TakerRunConfig) {
  await resetFork(fork, FORK_BLOCK);

  const router = addresses.pendle.router as `0x${string}`;
  const market = addresses.pendle.market as `0x${string}`;
  const syToken = addresses.pendle.sy as `0x${string}`;
  const ptToken = addresses.pendle.pt as `0x${string}`;
  const morphoBlue = addresses.morphoBlue as `0x${string}`;
  const usdcMarket = (addresses.morphoMarkets as any).usdc;

  const buyer = getAddress(`0x${keccak256(toBytes("taker-strategy-test-wallet")).slice(-40)}`) as `0x${string}`;

  if (config.capitalSy > 0n) {
    await dealErc20AtSlot(fork, syToken, buyer, config.capitalSy, SY_BALANCE_SLOT);
    await fork.request({ method: "anvil_setBalance" as any, params: [buyer, "0x56BC75E2D63100000"] });

    await fork.request({ method: "anvil_impersonateAccount" as any, params: [buyer] });
    const approveData = encodeFunctionData({
      abi: [
        { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
      ] as const,
      functionName: "approve",
      args: [router, config.capitalSy],
    });
    const approveHash = await fork.request({
      method: "eth_sendTransaction" as any,
      params: [{ from: buyer, to: syToken, data: approveData }],
    });
    await fork.waitForTransactionReceipt({ hash: approveHash as `0x${string}` });
    await fork.request({ method: "anvil_stopImpersonatingAccount" as any, params: [buyer] });
  }

  const decimals = await getTokenDecimals(fork, syToken, ptToken);
  const ladder = buildLadderFromFixtures();

  const plan: any[] = JSON.parse(readFileSync("fixtures/replay-plan.json", "utf8"));
  const points: any[] = [];
  const buys: any[] = [];
  let remainingCapital = config.capitalSy;
  let skippedLiquidations = 0;

  let block = await fork.getBlockNumber({ cacheTime: 0 });
  let positions = await readAllPositions(fork, block);
  const t0Pendle = await readPendleSnapshot(fork, market, block);

  const t0 = await measurePoint(fork, "t0", block, positions);
  points.push(t0);
  console.log(`[${config.label}] t0: PT ${t0Pendle.ptSpotPrice.toFixed(4)}, ladder has ${ladder.length} positions`);

  let lastTs = t0.timestamp;

  async function maybeReactAndBuy(afterLabel: string) {
    const startMs = Date.now();

    let reactionTs = lastTs;
    for (let i = 0; i < config.latencyBlocks; i++) {
      reactionTs += 1;
      block = await mineEmptyBlockAt(fork, reactionTs);
    }

    const snap = await readPendleSnapshot(fork, market, block);
    const oracleSnap = await readMorphoSnapshot(fork, morphoBlue, usdcMarket.id, usdcMarket.oracle, block);
    const risk = assessRisk(ladder, oracleSnap.oraclePriceScaled, snap.ptSpotPrice, TWAP_WINDOW_SEC, REACTION_SEC);

    console.log(
      `    [risk ${afterLabel}] gap=${risk.gapBps.toFixed(1)}bps earliestDeadline=${risk.earliestDeadlineSec === Infinity ? "inf" : risk.earliestDeadlineSec.toFixed(0) + "s"} ` +
      `debtAtRisk=$${risk.debtAtRiskInWindow.toLocaleString(undefined, { maximumFractionDigits: 0 })} target=${risk.targetSpot.toFixed(4)}`
    );
    console.log(`    [timing ${afterLabel}] risk check took ${Date.now() - startMs}ms`);

    if (risk.earliestDeadlineSec > REACTION_SEC * 2 || remainingCapital <= 0n) return;

    const sizingStartMs = Date.now();
    const sizing = await decideAndSizeBuy(fork, router, market, buyer, risk.targetSpot, remainingCapital, decimals);
    console.log(`    [timing ${afterLabel}] sizing quote took ${Date.now() - sizingStartMs}ms`);

    if (sizing.syAmount === 0n) {
      console.log(`    [skip ${afterLabel}] full-budget price ${sizing.effectivePrice.toFixed(6)} exceeds target ${risk.targetSpot.toFixed(6)} — not buying`);
      return;
    }

    const buyStartMs = Date.now();
    const receipt = await buyPt(fork, router, market, syToken, sizing.syAmount, buyer);
    console.log(`    [timing ${afterLabel}] execution took ${Date.now() - buyStartMs}ms`);

    remainingCapital -= sizing.syAmount;
    const after = await readPendleSnapshot(fork, market, receipt.blockNumber);

    console.log(
      `  [buy after ${afterLabel}] spent ${(Number(sizing.syAmount) / 10 ** decimals.sy).toFixed(2)} SY, ` +
      `PT spot ${snap.ptSpotPrice.toFixed(4)} -> ${after.ptSpotPrice.toFixed(4)}, remaining capital ${(Number(remainingCapital) / 10 ** decimals.sy).toFixed(2)} SY`
    );
    buys.push({
      afterLabel,
      block: receipt.blockNumber.toString(),
      syAmount: sizing.syAmount.toString(),
      netPtOut: sizing.netPtOut.toString(),
      effectivePrice: sizing.effectivePrice,
      targetSpot: risk.targetSpot,
      earliestDeadlineSec: risk.earliestDeadlineSec,
      priceBeforeBuy: snap.ptSpotPrice,
      priceAfterBuy: after.ptSpotPrice,
    });
    block = receipt.blockNumber;
  }

  const counters: Record<string, number> = {};
  for (const ev of plan) {
    const ts = Number(ev.timeStamp);
    while (ts - lastTs > TICK_SECONDS) {
      lastTs += TICK_SECONDS;
      block = await mineEmptyBlockAt(fork, lastTs);
      points.push(await measurePoint(fork, "tick", block, positions));
    }

    if (ev.kind.startsWith("liquidation")) {
      skippedLiquidations++;
      lastTs = ts;
      continue;
    }

    const receipt = await sendHistoricalTx(fork, ev, gasLimitFor(BigInt(ev.gasUsed)));
    block = receipt.blockNumber;
    lastTs = ts;

    counters[ev.role] = (counters[ev.role] ?? 0) + 1;

    if (ev.kind === "morpho-other") {
      positions = await readAllPositions(fork, block);
    }

    const tag = receipt.status === "success" ? "ok" : "REV";
    const label = `${ev.role.slice(0, 5)}-${counters[ev.role]} ${tag}`;
    points.push({ ...(await measurePoint(fork, label, block, positions)), txHash: ev.hash, txStatus: receipt.status });

    if (ev.kind === "attack" || ev.kind === "pendle-trade") {
      await maybeReactAndBuy(label);
    }
  }

  for (let k = 0; k < 30; k++) {
    lastTs += TICK_SECONDS;
    block = await mineEmptyBlockAt(fork, lastTs);
    points.push(await measurePoint(fork, "post-tick", block, positions));
  }

  mkdirSync(`results/scenario-${config.label}`, { recursive: true });
  writeFileSync(`results/scenario-${config.label}/timeseries.json`, JSON.stringify(points, null, 2));
  writeFileSync(`results/scenario-${config.label}/buys.json`, JSON.stringify(buys, null, 2));

  const totalSpent = config.capitalSy - remainingCapital;
  const minOracle = Math.min(...points.map((p) => p.oraclePrice));
  const peakLiqUsdc = Math.max(...points.map((p) => p.markets.usdc.liquidatableCount));
  const peakLiqUsdt = Math.max(...points.map((p) => p.markets.usdt.liquidatableCount));
  const peakDebtUsdc = Math.max(...points.map((p) => Number(p.markets.usdc.liquidatableDebt)));
  const peakDebtUsdt = Math.max(...points.map((p) => Number(p.markets.usdt.liquidatableDebt)));

  console.log(`\n[${config.label}] Summary (state-only mode: ${skippedLiquidations} historical liquidation txs skipped by design)`);
  console.log(`  Buys: ${buys.length}, total spent: ${(Number(totalSpent) / 10 ** decimals.sy).toFixed(2)} SY`);
  console.log(`  Oracle min: ${minOracle.toFixed(4)}`);
  console.log(`  Peak eligible: USDC ${peakLiqUsdc} pos / $${(peakDebtUsdc / 1e6).toLocaleString()} debt, USDT ${peakLiqUsdt} pos / $${(peakDebtUsdt / 1e6).toLocaleString()} debt`);

  return { points, buys, totalSpent, minOracle, peakLiqUsdc, peakLiqUsdt, peakDebtUsdc, peakDebtUsdt };
}
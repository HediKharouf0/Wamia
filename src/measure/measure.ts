import { readFileSync } from "fs";
import type { Client } from "../chain/client.js";
import addresses from "../../config/addresses.json" with { type: "json" };
import { readPendleSnapshot } from "../snapshot/pendle.js";
import { readMorphoSnapshot } from "../snapshot/morpho.js";
import { readPositions, type PositionSnapshot } from "../snapshot/position.js";
import { computePositionHealth } from "../health/morphoHealth.js";

const morphoBlue = addresses.morphoBlue as `0x${string}`;
const markets = addresses.morphoMarkets as Record<string, any>;

export type PositionsByMarket = Record<string, PositionSnapshot[]>;

const knownUsers: Record<string, `0x${string}`[]> = {};

/**
 * Re-reads every known borrower's position, one Multicall3 call per market. Only needed after
 * txs that touch Morpho. (It used to be one call per borrower with a pause between them.)
 */
export async function readAllPositions(client: Client, blockNumber: bigint): Promise<PositionsByMarket> {
  const result: PositionsByMarket = {};
  for (const [name, m] of Object.entries(markets)) {
    knownUsers[name] ??= JSON.parse(readFileSync(`fixtures/positions-${name}-forkblock.json`, "utf8")).map((p: any) => p.user);
    result[name] = await readPositions(client, morphoBlue, m.id, knownUsers[name]!, blockNumber);
  }
  return result;
}

export async function measurePoint(client: Client, label: string, blockNumber: bigint, positions: PositionsByMarket) {
  const pendle = await readPendleSnapshot(client, addresses.pendle.market as `0x${string}`, blockNumber);

  const perMarket: Record<string, any> = {};
  let oraclePrice = 0;

  for (const [name, m] of Object.entries(markets)) {
    const snap = await readMorphoSnapshot(client, morphoBlue, m.id, m.oracle, blockNumber);
    oraclePrice = snap.oraclePriceScaled; // same oracle for both markets

    const healths = (positions[name] ?? []).map((p) =>
      computePositionHealth(p, {
        totalBorrowAssets: snap.totalBorrowAssets,
        totalBorrowShares: snap.totalBorrowShares,
        oraclePrice: snap.oraclePrice,
        lltv: BigInt(m.lltv),
      })
    );
    const liq = healths.filter((h) => h.liquidatable);
    const withDebt = healths.filter((h) => h.borrowAssets > 0n);

    perMarket[name] = {
      liquidatableCount: liq.length,
      liquidatableDebt: liq.reduce((s, h) => s + h.borrowAssets, 0n).toString(),
      liquidatableCollateral: liq.reduce((s, h) => s + h.collateral, 0n).toString(),
      liquidatableUsers: liq.map((h) => h.user),
      minHealthFactor: withDebt.length ? Math.min(...withDebt.map((h) => h.healthFactor)) : null,
    };
  }

  return {
    label,
    block: blockNumber.toString(),
    timestamp: pendle.timestamp,
    ptSpotPrice: pendle.ptSpotPrice,
    impliedYield: pendle.impliedYield,
    oraclePrice,
    markets: perMarket,
  };
}
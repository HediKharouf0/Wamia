import type { Client } from "../chain/client.js";

const morphoBlueAbi = [
  {
    type: "function",
    name: "market",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "totalSupplyAssets", type: "uint128" },
      { name: "totalSupplyShares", type: "uint128" },
      { name: "totalBorrowAssets", type: "uint128" },
      { name: "totalBorrowShares", type: "uint128" },
      { name: "lastUpdate", type: "uint128" },
      { name: "fee", type: "uint128" },
    ],
  },
] as const;

const oracleAbi = [
  { type: "function", name: "price", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export type MorphoMarketSnapshot = {
  blockNumber: bigint;
  marketId: `0x${string}`;
  oraclePrice: bigint;       // raw, 1e36-scaled per Morpho convention
  oraclePriceScaled: number; // divided by 1e36, human-readable ratio
  totalSupplyAssets: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  lastUpdate: bigint;
};

export async function readMorphoSnapshot(
  client: Client,
  morphoBlue: `0x${string}`,
  marketId: `0x${string}`,
  oracleAddress: `0x${string}`,
  blockNumber: bigint
): Promise<MorphoMarketSnapshot> {
  const [market, oraclePrice] = await Promise.all([
    client.readContract({ address: morphoBlue, abi: morphoBlueAbi, functionName: "market", args: [marketId], blockNumber }),
    client.readContract({ address: oracleAddress, abi: oracleAbi, functionName: "price", blockNumber }),
  ]);

  const [totalSupplyAssets, , totalBorrowAssets, totalBorrowShares, lastUpdate] = market;

  return {
    blockNumber,
    marketId,
    oraclePrice,
    oraclePriceScaled: Number(oraclePrice) / 1e36,
    totalSupplyAssets,
    totalBorrowAssets,
    totalBorrowShares,
    lastUpdate,
  };
}
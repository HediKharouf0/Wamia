import type { Client } from "../chain/client.js";
import { ptPriceFromYield } from "../pricing/fairValue.js";

const marketAbi = [
  {
    type: "function",
    name: "_storage",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "totalPt", type: "int128" },
      { name: "totalSy", type: "int128" },
      { name: "lastLnImpliedRate", type: "uint96" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
    ],
  },
  {
    type: "function",
    name: "expiry",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "readTokens",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "_SY", type: "address" },
      { name: "_PT", type: "address" },
      { name: "_YT", type: "address" },
    ],
  },
] as const;

const erc20Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

export type PendleSnapshot = {
  blockNumber: bigint;
  timestamp: number;
  totalPt: number;
  totalSy: number;
  lastLnImpliedRateRaw: bigint;
  impliedYield: number;
  expiry: number;
  tau: number;
  ptSpotPrice: number;
};

export async function readPendleSnapshot(
  client: Client,
  marketAddress: `0x${string}`,
  blockNumber: bigint
): Promise<PendleSnapshot> {
  const [storage, expiry, [syAddr, ptAddr], blockInfo] = await Promise.all([
    client.readContract({ address: marketAddress, abi: marketAbi, functionName: "_storage", blockNumber }),
    client.readContract({ address: marketAddress, abi: marketAbi, functionName: "expiry", blockNumber }),
    client.readContract({ address: marketAddress, abi: marketAbi, functionName: "readTokens", blockNumber }),
    client.getBlock({ blockNumber }),
  ]);

  const [ptDecimals, syDecimals] = await Promise.all([
    client.readContract({ address: ptAddr, abi: erc20Abi, functionName: "decimals", blockNumber }),
    client.readContract({ address: syAddr, abi: erc20Abi, functionName: "decimals", blockNumber }),
  ]);

  const [totalPtRaw, totalSyRaw, lastLnImpliedRateRaw] = storage;
  const timestamp = Number(blockInfo.timestamp);
  const tau = Math.max(0, (Number(expiry) - timestamp) / (365 * 24 * 60 * 60));
  const impliedYield = Math.exp(Number(lastLnImpliedRateRaw) / 1e18) - 1;

  return {
    blockNumber,
    timestamp,
    totalPt: Number(totalPtRaw) / 10 ** ptDecimals,
    totalSy: Number(totalSyRaw) / 10 ** syDecimals,
    lastLnImpliedRateRaw,
    impliedYield,
    expiry: Number(expiry),
    tau,
    ptSpotPrice: ptPriceFromYield(impliedYield, tau),
  };
}
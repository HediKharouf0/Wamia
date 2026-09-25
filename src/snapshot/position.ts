import type { Client } from "../chain/client.js";

const morphoBlueAbi = [
  {
    type: "function",
    name: "position",
    stateMutability: "view",
    inputs: [
      { name: "id", type: "bytes32" },
      { name: "user", type: "address" },
    ],
    outputs: [
      { name: "supplyShares", type: "uint256" },
      { name: "borrowShares", type: "uint128" },
      { name: "collateral", type: "uint128" },
    ],
  },
] as const;

export type PositionSnapshot = {
  user: `0x${string}`;
  supplyShares: bigint;
  borrowShares: bigint;
  collateral: bigint;
};

export async function readPosition(
  client: Client,
  morphoBlue: `0x${string}`,
  marketId: `0x${string}`,
  user: `0x${string}`,
  blockNumber: bigint
): Promise<PositionSnapshot> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const [supplyShares, borrowShares, collateral] = await client.readContract({
        address: morphoBlue,
        abi: morphoBlueAbi,
        functionName: "position",
        args: [marketId, user],
        blockNumber,
      });
      return { user, supplyShares, borrowShares, collateral };
    } catch (e: any) {
      const is429 = e?.details === "Too Many Requests" || e?.shortMessage?.includes("429");
      if (!is429 || attempt === 4) throw e;
      const wait = 500 * Math.pow(2, attempt); // 500ms, 1s, 2s, 4s, 8s
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error("unreachable");
}
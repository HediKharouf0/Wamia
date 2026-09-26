import { keccak256, encodeAbiParameters, pad, toHex } from "viem";
import type { Client } from "../chain/client.js";

const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/** Sets an ERC20 balance directly via storage, given a known, confirmed mapping slot. */
export async function dealErc20AtSlot(
  client: Client,
  token: `0x${string}`,
  holder: `0x${string}`,
  amount: bigint,
  slot: number
): Promise<boolean> {
  const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, BigInt(slot)]));
  await client.request({
    method: "anvil_setStorageAt" as any,
    params: [token, key, pad(toHex(amount), { size: 32 })],
  });
  const balance = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder] });
  return balance === amount;
}
/**
 * Test-harness state edits for the fork, found from what the contracts actually read rather than
 * from a guessed storage layout: eth_createAccessList lists every storage slot a call touches, and
 * the edit is kept only if the call then returns what we asked for. Never used by strategy code.
 */
import { encodeFunctionData, pad, toHex, parseAbi } from "viem";
import type { Client } from "../chain/client.js";

type Hex = `0x${string}`;
type Slot = { address: Hex; key: Hex };

const balanceOfAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

async function setWord(client: Client, address: Hex, key: Hex, value: bigint) {
  await client.request({ method: "anvil_setStorageAt" as any, params: [address, key, pad(toHex(value), { size: 32 })] });
}

async function readWord(client: Client, address: Hex, key: Hex): Promise<bigint> {
  return BigInt((await client.getStorageAt({ address, slot: key })) ?? "0x0");
}

/** Storage slots a call reads, across every contract it touches (proxies included). */
export async function slotsReadBy(client: Client, call: { to: Hex; data: Hex }): Promise<Slot[]> {
  const { accessList } = await client.createAccessList({ to: call.to, data: call.data });
  return accessList.flatMap((e) => e.storageKeys.map((key) => ({ address: e.address as Hex, key: key as Hex })));
}

/** Sets `holder`'s balance of any standard ERC20 to `amount`. Returns false if no slot works. */
export async function dealAnyErc20(client: Client, token: Hex, holder: Hex, amount: bigint): Promise<boolean> {
  const balance = () => client.readContract({ address: token, abi: balanceOfAbi, functionName: "balanceOf", args: [holder] });
  const data = encodeFunctionData({ abi: balanceOfAbi, functionName: "balanceOf", args: [holder] });
  for (const { address, key } of await slotsReadBy(client, { to: token, data })) {
    const old = await readWord(client, address, key);
    await setWord(client, address, key, amount);
    const now = await balance().catch(() => null);
    if (now === amount) return true;
    await setWord(client, address, key, old);
  }
  return false;
}

/**
 * Scales the stored value behind a view call by num/den: tries each slot the call reads and keeps
 * the edit that moves the call's result by that factor (within 0.1%). Returns the slot, or null.
 */
export async function scaleValueBehind(
  client: Client,
  call: { to: Hex; data: Hex },
  read: () => Promise<bigint>,
  num: bigint,
  den: bigint
): Promise<Slot | null> {
  const before = await read();
  const target = (before * num) / den;
  for (const { address, key } of await slotsReadBy(client, call)) {
    const old = await readWord(client, address, key);
    if (old === 0n) continue;
    await setWord(client, address, key, (old * num) / den);
    const after = await read().catch(() => null);
    const diff = after === null ? null : after > target ? after - target : target - after;
    if (diff !== null && diff * 1000n <= target) return { address, key };
    await setWord(client, address, key, old);
  }
  return null;
}

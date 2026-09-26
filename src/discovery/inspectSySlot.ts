import { fork } from "../chain/client.js";
import { resetFork } from "../replay/actions.js";
import addresses from "../../config/addresses.json" with { type: "json" };
import { getAddress, keccak256, encodeAbiParameters } from "viem";

const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

async function main() {
  await resetFork(fork, 25829822n);

  const syToken = addresses.pendle.sy as `0x${string}`;
  const holder = getAddress("0x854e3f3b521dbae34cb111ebef0dce41d8b5690d");

  const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, 2n]));
  const raw = await fork.request({ method: "eth_getStorageAt" as any, params: [syToken, key, "latest"] });
  const realBalance = await fork.readContract({ address: syToken, abi: erc20Abi, functionName: "balanceOf", args: [holder] });

  console.log(`raw storage word: ${raw}`);
  console.log(`real balanceOf(): ${realBalance}`);
  console.log(`real balance as hex, padded 32 bytes: 0x${realBalance.toString(16).padStart(64, "0")}`);
  console.log(`\nCompare where in the raw word the balance's hex digits appear — that tells us the byte offset and packing.`);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
import { fork } from "../chain/client.js";
import { resetFork } from "../replay/actions.js";
import { dealErc20AtSlot } from "../replay/dealErc20.js";
import { quoteBuyPt, buyPt } from "../strategies/taker.js";
import addresses from "../../config/addresses.json" with { type: "json" };
import { getAddress, encodeFunctionData } from "viem";

const SY_BALANCE_SLOT = 2;

const erc20Abi = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

async function main() {
  await resetFork(fork, 25829822n);

  const router = addresses.pendle.router as `0x${string}`;
  const market = addresses.pendle.market as `0x${string}`;
  const syToken = addresses.pendle.sy as `0x${string}`;
  const buyer = getAddress("0x000000000000000000000000000000000000dead") as `0x${string}`;

  const fundAmount = 1_000_000_000_000_000_000_000n;
  console.log("Funding test buyer with SY via storage...");
  const funded = await dealErc20AtSlot(fork, syToken, buyer, fundAmount, SY_BALANCE_SLOT);
  console.log(`  funded: ${funded}`);

  console.log("\nApproving router to spend SY...");
  await fork.request({ method: "anvil_impersonateAccount" as any, params: [buyer] });

  const approveData = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [router, fundAmount],
  });
  const approveHash = await fork.request({
    method: "eth_sendTransaction" as any,
    params: [{ from: buyer, to: syToken, data: approveData }],
  });
  await fork.waitForTransactionReceipt({ hash: approveHash as `0x${string}` });

  await fork.request({ method: "anvil_stopImpersonatingAccount" as any, params: [buyer] });

  const tinyAmount = 1_000_000_000_000_000_000n; // 1 SY

  console.log("\nQuoting a real buy...");
  const quote = await quoteBuyPt(fork, router, market, tinyAmount, buyer);
  console.log(`  quote: netPtOut=${quote.netPtOut}, netSyFee=${quote.netSyFee}`);

  console.log("\nExecuting the real swap...");
  const receipt = await buyPt(fork, router, market, syToken, tinyAmount, buyer);
  console.log(`  tx status: ${receipt.status}, gasUsed: ${receipt.gasUsed}`);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
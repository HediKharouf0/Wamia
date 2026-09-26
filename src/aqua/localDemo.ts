/**
 * End-to-end Levee flow through the 1inch SDKs, on a local Anvil chain (no fork, no RPC key):
 * deploys Aqua v1.0.0, AquaSwapVMRouter v1.0.2, LeveeQuoter and mock PT/SY/market from the
 * Foundry build, then ships a strategy, quotes and swaps a PT sale, shows the depeg stop and
 * docks. Every step is a real transaction.
 *
 *   (cd contracts && forge build) && npx tsx src/aqua/localDemo.ts
 *
 * The mainnet-fork version of this flow is contracts/test/fork/LeveeFork.t.sol, and
 * scenarioMaker will reuse these helpers against the fork.
 */
import { spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import {
  createPublicClient,
  http,
  encodeDeployData,
  encodeFunctionData,
  decodeFunctionResult,
  parseAbi,
  type Abi,
} from "viem";
import { ABI, SwappedEvent } from "@1inch/swap-vm-sdk";
import {
  buildLeveeOrder,
  shipTx,
  dockTx,
  quoteSellPtTx,
  swapSellPtTx,
  strategyHash,
  type CallInfo,
  type LeveeParams,
} from "./levee.js";

type Hex = `0x${string}`;
const PORT = 8546;
const RPC = `http://127.0.0.1:${PORT}`;
const EXPIRY = 1796860800n; // PT-reUSD expiry, 2026-12-10

const client = createPublicClient({ transport: http(RPC) });
const erc20 = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function mint(address,uint256)",
  "function setExchangeRate(uint256)",
]);

function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const path = `contracts/out/${file}/${name}.json`;
  if (!existsSync(path)) throw new Error(`${path} missing: run (cd contracts && forge build) first`);
  const j = JSON.parse(readFileSync(path, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

async function send(from: Hex, tx: { to?: Hex; data: Hex }) {
  const hash = (await client.request({ method: "eth_sendTransaction" as any, params: [{ from, ...tx, gas: "0x1C9C380" }] as any })) as Hex;
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`tx reverted: ${hash}`);
  return receipt;
}

async function deploy(from: Hex, file: string, name: string, args: unknown[] = []): Promise<Hex> {
  const { abi, bytecode } = artifact(file, name);
  const receipt = await send(from, { data: encodeDeployData({ abi, bytecode, args }) });
  return receipt.contractAddress as Hex;
}

const call = (from: Hex, c: CallInfo) => client.call({ account: from, to: c.to, data: c.data });
const balance = (token: Hex, who: Hex) =>
  client.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [who] });
const write = (from: Hex, to: Hex, functionName: "approve" | "mint" | "setExchangeRate", args: any[]) =>
  send(from, { to, data: encodeFunctionData({ abi: erc20, functionName, args } as any) });

async function startAnvil() {
  const anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      await client.getBlockNumber();
      return anvil;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  anvil.kill();
  throw new Error("anvil did not start (is Foundry installed?)");
}

async function main() {
  const anvil = await startAnvil();
  try {
    const [deployer, lp, taker] = (await client.request({ method: "eth_accounts" as any })) as Hex[];
    if (!deployer || !lp || !taker) throw new Error("anvil accounts missing");

    // Official 1inch sources (release tags pinned in contracts/lib) and Levee.
    const aqua = await deploy(deployer, "Aqua.sol", "Aqua");
    const router = await deploy(deployer, "AquaSwapVMRouter.sol", "AquaSwapVMRouter", [aqua, deployer, deployer, "AquaSwapVMRouter", "1.0.2"]);
    const quoter = await deploy(deployer, "LeveeQuoter.sol", "LeveeQuoter");
    const pt = await deploy(deployer, "Mocks.sol", "MockToken", ["PT", 6]);
    const sy = await deploy(deployer, "Mocks.sol", "MockSY", [1_096_800n]);
    const market = await deploy(deployer, "Mocks.sol", "MockPendleMarket", [EXPIRY, sy, pt]);
    console.log(`deployed Aqua ${aqua}, router ${router}, quoter ${quoter}`);

    // LP: approve Aqua once, ship a strategy built with the SDK.
    await write(lp, sy, "mint", [lp, 1_000_000n * 10n ** 18n]);
    await write(lp, sy, "approve", [aqua, 2n ** 256n - 1n]);
    const params: LeveeParams = {
      pt,
      sy,
      market,
      refYieldWad: 105_830_000_000_000_000n,
      discountBps: 10,
      maxPtPerTrade: 5_000_000n * 10n ** 6n,
      minSyRate: 1_090_000n,
    };
    const order = buildLeveeOrder(lp, quoter, params);
    await send(lp, shipTx(aqua, router, order, sy, pt, 500_000n * 10n ** 18n));
    console.log(`shipped 500,000 SY, strategy ${strategyHash(order)}`);

    // Taker: sell 100,000 PT. Quote first, then swap with the quote as min out.
    await write(taker, pt, "mint", [taker, 100_000n * 10n ** 6n]);
    await write(taker, pt, "approve", [router, 2n ** 256n - 1n]);
    const q = await call(taker, quoteSellPtTx(router, order, pt, sy, 100_000n * 10n ** 6n));
    const [, quotedOut, orderHash] = decodeFunctionResult({ abi: ABI.SWAP_VM_ABI, functionName: "quote", data: q.data! }) as [bigint, bigint, Hex];
    if (orderHash !== strategyHash(order)) throw new Error("router hash differs from the SDK strategy hash");

    const lpSyBefore = await balance(sy, lp);
    const receipt = await send(taker, swapSellPtTx(router, order, pt, sy, 100_000n * 10n ** 6n, { threshold: quotedOut }));
    const swappedLog = receipt.logs.find((l) => l.address.toLowerCase() === router.toLowerCase());
    const swapped = SwappedEvent.fromLog({ data: swappedLog!.data, topics: swappedLog!.topics as [Hex, ...Hex[]] });

    const syPaid = lpSyBefore - (await balance(sy, lp));
    // The quote ran against the previous block and the swap lands in a later one. Levee's fair
    // value rises toward 1 as maturity approaches, so a few seconds later it pays marginally more.
    // The quote is honored as the taker's min out; the LP wallet pays exactly what the taker gets.
    console.log(`swap: ${swapped.amountIn} PT in, ${swapped.amountOut} SY out (quoted ${quotedOut} one block earlier)`);
    console.log(`  LP wallet: -${syPaid} SY, +${await balance(pt, lp)} PT; taker got ${await balance(sy, taker)} SY`);
    if (swapped.amountOut < quotedOut) throw new Error("swap paid less than the quote");
    if (syPaid !== swapped.amountOut || (await balance(sy, taker)) !== swapped.amountOut) throw new Error("SY did not move LP -> taker");

    // Depeg stop: SY loses value, the same quote now reverts.
    await write(deployer, sy, "setExchangeRate", [1_050_000n]);
    const refused = await call(taker, quoteSellPtTx(router, order, pt, sy, 1_000n * 10n ** 6n)).then(() => false, () => true);
    console.log(`after SY rate drop to 1.05: quote ${refused ? "refused" : "ACCEPTED (unexpected)"}`);
    await write(deployer, sy, "setExchangeRate", [1_096_800n]);

    // Dock: the LP withdraws the strategy, no more fills.
    await send(lp, dockTx(aqua, router, order, sy, pt));
    const docked = await call(taker, quoteSellPtTx(router, order, pt, sy, 1_000n * 10n ** 6n)).then(() => false, () => true);
    console.log(`after dock: quote ${docked ? "refused" : "ACCEPTED (unexpected)"}`);

    if (!refused || !docked) throw new Error("risk checks did not hold");
    console.log("\nLocal SDK end-to-end passed.");
  } finally {
    anvil.kill();
  }
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});

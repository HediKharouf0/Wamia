import type { Client } from "../chain/client.js";

export type HistoricalTx = {
  hash: string;
  from: `0x${string}`;
  to: `0x${string}`;
  input: `0x${string}`;
  timeStamp: string;
  blockNumber: string;
};

export async function sendHistoricalTx(client: Client, tx: HistoricalTx, gasLimit: bigint) {
  await client.request({ method: "anvil_impersonateAccount" as any, params: [tx.from] });
  await client.request({ method: "anvil_setBalance" as any, params: [tx.from, "0x56BC75E2D63100000"] });
  try {
    await client.request({ method: "evm_setNextBlockTimestamp" as any, params: [Number(tx.timeStamp)] as any });
  } catch (e: any) {
    console.log(`  [timestamp warning ${tx.hash.slice(0, 10)}]: ${e?.shortMessage ?? e?.message}`);
  }

  const hash = await client.request({
    method: "eth_sendTransaction" as any,
    params: [{ from: tx.from, to: tx.to, data: tx.input, gas: `0x${gasLimit.toString(16)}` }],
  });
  const receipt = await client.waitForTransactionReceipt({ hash: hash as `0x${string}` });

  await client.request({ method: "anvil_stopImpersonatingAccount" as any, params: [tx.from] });
  return receipt;
}

export async function mineEmptyBlockAt(client: Client, timestamp: number): Promise<bigint> {
  await client.request({ method: "evm_mine" as any, params: [timestamp] as any });
  return client.getBlockNumber({ cacheTime: 0 });
}

export async function explainRevert(client: Client, hash: `0x${string}`): Promise<string> {
  try {
    const trace: any = await client.request({
      method: "debug_traceTransaction" as any,
      params: [hash, { tracer: "callTracer" }] as any,
    });
    let deepest = trace;
    const walk = (c: any) => {
      if (c.error) deepest = c;
      for (const sub of c.calls ?? []) walk(sub);
    };
    walk(trace);
    const reason = deepest.revertReason ? ` "${deepest.revertReason}"` : "";
    return `${deepest.error ?? "unknown error"}${reason} in call to ${deepest.to} (output ${(deepest.output ?? "0x").slice(0, 10)})`;
  } catch (e: any) {
    return `trace unavailable: ${e?.shortMessage ?? e?.message}`;
  }
}

export async function resetFork(client: Client, blockNumber: bigint) {
  await client.request({
    method: "anvil_reset" as any,
    params: [{ forking: { jsonRpcUrl: process.env.ARCHIVE_RPC_URL, blockNumber: Number(blockNumber) } }] as any,
  });
}
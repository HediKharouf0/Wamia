import { fork } from "../chain/client.js";
import { readPendleSnapshot } from "../snapshot/pendle.js";
import addresses from "../../config/addresses.json" with { type: "json" };
import { writeFileSync, readFileSync } from "fs";

async function main() {
  const fixture = JSON.parse(readFileSync("fixtures/attack-transactions.json", "utf8"));
  const receipts: any[] = JSON.parse(readFileSync("fixtures/attack-receipts.json", "utf8"));
  const mainnetGas = new Map(receipts.map((r) => [r.hash.toLowerCase(), BigInt(r.gasUsed)]));
  const pendleMarket = addresses.pendle.market as `0x${string}`;

  const results: any[] = [];

  let blockNumber = await fork.getBlockNumber();
  let snap = await readPendleSnapshot(fork, pendleMarket, blockNumber);
  results.push({ step: "t0", block: blockNumber.toString(), impliedYield: snap.impliedYield, ptSpotPrice: snap.ptSpotPrice });
  console.log(`t0: block ${blockNumber}, PT price ${snap.ptSpotPrice.toFixed(4)}, yield ${(snap.impliedYield * 100).toFixed(3)}%`);

  for (let i = 0; i < fixture.manipulator.length; i++) {
    const tx = fixture.manipulator[i];

    await fork.request({ method: "anvil_impersonateAccount" as any, params: [tx.from] });
    await fork.request({ method: "anvil_setBalance" as any, params: [tx.from, "0x56BC75E2D63100000"] });
    try {
      await fork.request({ method: "evm_setNextBlockTimestamp" as any, params: [Number(tx.timeStamp)] as any });
    } catch (e: any) {
      console.log(`  [timestamp warning tx ${i + 1}]: ${e?.shortMessage ?? e?.message}`);
    }

        const realGas = mainnetGas.get(tx.hash.toLowerCase()) ?? 0n;
    const gasLimit = realGas * 2n > 1_000_000n ? realGas * 2n : 1_000_000n;

    const hash = await fork.request({
      method: "eth_sendTransaction" as any,
      params: [{ from: tx.from, to: tx.to, data: tx.input, gas: `0x${gasLimit.toString(16)}` }],
    });
    const receipt = await fork.waitForTransactionReceipt({ hash: hash as `0x${string}` });
    console.log(`  tx ${i + 1}: mainnet gasUsed=${realGas}, limit=${gasLimit}, fork gasUsed=${receipt.gasUsed}`);

    blockNumber = receipt.blockNumber;

    if (receipt.status === "reverted") {
      console.log(`  [tx ${i + 1} REVERTED] hash=${hash} gasUsed=${receipt.gasUsed}`);
      try {
        const trace: any = await fork.request({
          method: "debug_traceTransaction" as any,
          params: [hash, { disableStorage: true, disableMemory: true }] as any,
        });
        console.log(`    trace.failed=${trace.failed}, gas=${trace.gas}`);
        console.log(`    returnValue (raw revert data): ${trace.returnValue}`);
        // try to decode a standard Error(string) revert
        if (trace.returnValue && trace.returnValue.startsWith("0x08c379a0")) {
          const hex = trace.returnValue.slice(10);
          const strLenHex = hex.slice(64, 128);
          const strLen = parseInt(strLenHex, 16);
          const strHex = hex.slice(128, 128 + strLen * 2);
          const decoded = Buffer.from(strHex, "hex").toString("utf8");
          console.log(`    decoded revert reason: "${decoded}"`);
        }
      } catch (e: any) {
        console.log(`    debug_traceTransaction failed: ${e?.shortMessage ?? e?.message}`);
      }
    }

    snap = await readPendleSnapshot(fork, pendleMarket, blockNumber);
    console.log(
      `manipulator tx ${i + 1}/${fixture.manipulator.length}: block ${blockNumber}, status ${receipt.status}, gasUsed ${receipt.gasUsed}, ` +
      `PT price ${snap.ptSpotPrice.toFixed(4)}, yield ${(snap.impliedYield * 100).toFixed(3)}%`
    );

    results.push({
      step: `manipulator-${i + 1}`,
      block: blockNumber.toString(),
      txStatus: receipt.status,
      gasUsed: receipt.gasUsed.toString(),
      impliedYield: snap.impliedYield,
      ptSpotPrice: snap.ptSpotPrice,
    });

    await fork.request({ method: "anvil_stopImpersonatingAccount" as any, params: [tx.from] });
  }

  writeFileSync("fixtures/pilot-pendle-timeseries.json", JSON.stringify(results, null, 2));

  const first = results[0].ptSpotPrice;
  const min = Math.min(...results.map((r) => r.ptSpotPrice));
  console.log(`\nPT price: started at ${first.toFixed(4)}, minimum ${min.toFixed(4)} (${((1 - min / first) * 100).toFixed(2)}% drop)`);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
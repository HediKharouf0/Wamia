import { fork } from "../chain/client.js";
import addresses from "../../config/addresses.json" with { type: "json" };

const loupeAbi = [
  {
    type: "function",
    name: "facetAddress",
    stateMutability: "view",
    inputs: [{ name: "_functionSelector", type: "bytes4" }],
    outputs: [{ name: "facetAddress_", type: "address" }],
  },
] as const;

async function main() {
  const router = addresses.pendle.router as `0x${string}`;

  const candidates = {
    swapExactSyForPt: "0x83c71b69",
    swapExactTokenForPt: "0xa5f9931b",
    swapExactPtForSy: "0x2032aecd",
    swapSyForExactPt: "0x6b8bdf32",
  };

  for (const [name, selector] of Object.entries(candidates)) {
    try {
      const facet = await fork.readContract({
        address: router,
        abi: loupeAbi,
        functionName: "facetAddress",
        args: [selector as `0x${string}`],
      });
      const registered = facet !== "0x0000000000000000000000000000000000000000";
      console.log(`  ${name} (${selector}): ${registered ? `registered, facet ${facet}` : "NOT registered (zero address)"}`);
    } catch (e: any) {
      console.log(`  ${name} (${selector}): facetAddress call itself failed: ${e?.shortMessage ?? e?.message}`);
    }
  }
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
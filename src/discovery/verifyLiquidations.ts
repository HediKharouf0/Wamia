import { createWalletClient, createPublicClient, http, parseAbi } from "viem";
import { mainnet } from "viem/chains";
import { readFileSync } from "fs";
import addresses from "../../config/addresses.json" with { type: "json" };

const fork = createPublicClient({ chain: mainnet, transport: http("http://127.0.0.1:8545") });

const morphoAbi = parseAbi([
  "function liquidate((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams, address borrower, uint256 seizedAssets, uint256 repaidShares, bytes data) returns (uint256, uint256)",
]);
const erc20Abi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

async function impersonateAndFund(address: `0x${string}`) {
  await fork.request({ method: "anvil_impersonateAccount" as any, params: [address] });
  await fork.request({ method: "anvil_setBalance" as any, params: [address, "0x56BC75E2D63100000"] }); // 100 ETH for gas
}

async function main() {
  const morphoBlue = addresses.morphoBlue as `0x${string}`;

  for (const [name, m] of Object.entries(addresses.morphoMarkets)) {
    const mkt = m as any;
    const whale = (addresses as any).whales[name] as `0x${string}`;
    const healths = JSON.parse(readFileSync(`fixtures/health-${name}-forkblock.json`, "utf8"));

    console.log(`\n${name.toUpperCase()}: verifying ${healths.length} positions via eth_call liquidate probe...`);
    await impersonateAndFund(whale);

    const client = createWalletClient({ account: whale, chain: mainnet, transport: http("http://127.0.0.1:8545") });

    // approve once, generously
    await client.writeContract({
      address: mkt.loanToken as `0x${string}`,
      abi: erc20Abi,
      functionName: "approve",
      args: [morphoBlue, 2n ** 256n - 1n],
    });

    let agree = 0;
    let disagree = 0;

    for (const h of healths) {
      const marketParams = {
        loanToken: mkt.loanToken,
        collateralToken: mkt.collateralToken,
        oracle: mkt.oracle,
        irm: mkt.irm,
        lltv: BigInt(mkt.lltv),
      };

      let onChainSaysLiquidatable: boolean;
      try {
        await fork.simulateContract({
          address: morphoBlue,
          abi: morphoAbi,
          functionName: "liquidate",
          args: [marketParams, h.user as `0x${string}`, 1n, 0n, "0x"],
          account: whale,
        });
        onChainSaysLiquidatable = true;
      } catch (e: any) {
        onChainSaysLiquidatable = false;
        if (!e?.message?.includes("healthy") && !e?.shortMessage?.includes("healthy")) {
          console.log(`  ${h.user}: unexpected revert reason (not "healthy"): ${e?.shortMessage ?? e?.message}`);
        }
      }

      const ourClassification = h.liquidatable;
      if (onChainSaysLiquidatable === ourClassification) {
        agree++;
      } else {
        disagree++;
        console.log(`  MISMATCH ${h.user}: ours=${ourClassification} chain=${onChainSaysLiquidatable} HF=${h.healthFactor}`);
      }
    }

    console.log(`  agree: ${agree}, disagree: ${disagree}`);
  }
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
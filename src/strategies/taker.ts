import type { Client } from "../chain/client.js";
import { encodeAbiParameters, decodeAbiParameters, concatHex, encodeFunctionData } from "viem";

// Confirmed by hashing the canonical signature and checking it against the sibling
// swapExactSyForYt selector (0x7b8b4b95), which matched a real transaction exactly.
const SWAP_EXACT_SY_FOR_PT_SELECTOR = "0x2a50917c" as const;

const approxParamsType = {
  type: "tuple",
  components: [
    { name: "guessMin", type: "uint256" },
    { name: "guessMax", type: "uint256" },
    { name: "guessOffchain", type: "uint256" },
    { name: "maxIteration", type: "uint256" },
    { name: "eps", type: "uint256" },
  ],
} as const;

// Confirmed via 4byte match on the real swapExactSyForYt selector used by the manipulator's
// own transaction (0x7b8b4b95). Order's 12 fields are unnamed in the canonical signature;
// field names below are our best labeling but the types and order are verified.
const orderType = {
  type: "tuple",
  components: [
    { name: "salt", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "orderType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "yt", type: "address" },
    { name: "maker", type: "address" },
    { name: "receiver", type: "address" },
    { name: "makingAmount", type: "uint256" },
    { name: "lnImpliedRate", type: "uint256" },
    { name: "failSafeRate", type: "uint256" },
    { name: "permit", type: "bytes" },
  ],
} as const;

const fillOrderParamsType = {
  type: "tuple",
  components: [
    { name: "order", ...orderType },
    { name: "signature", type: "bytes" },
    { name: "makingAmount", type: "uint256" },
  ],
} as const;

const limitOrderDataType = {
  type: "tuple",
  components: [
    { name: "limitRouter", type: "address" },
    { name: "epsSkipMarket", type: "uint256" },
    { name: "normalFills", type: "tuple[]", components: fillOrderParamsType.components },
    { name: "flashFills", type: "tuple[]", components: fillOrderParamsType.components },
    { name: "optData", type: "bytes" },
  ],
} as const;

const callParamTypes = [
  { name: "receiver", type: "address" },
  { name: "market", type: "address" },
  { name: "exactSyIn", type: "uint256" },
  { name: "minPtOut", type: "uint256" },
  { name: "guessPtOut", ...approxParamsType },
  { name: "limit", ...limitOrderDataType },
] as const;

const returnTypes = [
  { name: "netPtOut", type: "uint256" },
  { name: "netSyFee", type: "uint256" },
] as const;

const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

function buildSwapCalldata(receiver: `0x${string}`, market: `0x${string}`, exactSyIn: bigint, minPtOut: bigint) {
  const encodedParams = encodeAbiParameters(callParamTypes, [
    receiver,
    market,
    exactSyIn,
    minPtOut,
    { guessMin: 0n, guessMax: 2n ** 256n - 1n, guessOffchain: 0n, maxIteration: 256n, eps: 10n ** 14n },
    {
      limitRouter: "0x0000000000000000000000000000000000000000",
      epsSkipMarket: 0n,
      normalFills: [],
      flashFills: [],
      optData: "0x",
    },
  ]);
  return concatHex([SWAP_EXACT_SY_FOR_PT_SELECTOR, encodedParams]);
}

/** Simulates the swap via eth_call to get a real, on-chain-accurate quote without spending anything. */
export async function quoteBuyPt(
  client: Client,
  router: `0x${string}`,
  market: `0x${string}`,
  syAmount: bigint,
  buyer: `0x${string}`
): Promise<{ netPtOut: bigint; netSyFee: bigint }> {
  const data = buildSwapCalldata(buyer, market, syAmount, 0n);
  const result = await client.call({ to: router, data, account: buyer });
  const [netPtOut, netSyFee] = decodeAbiParameters(returnTypes, result.data!);
  return { netPtOut, netSyFee };
}

/** Executes the real swap on the fork. */
export async function buyPt(
  client: Client,
  router: `0x${string}`,
  market: `0x${string}`,
  syToken: `0x${string}`,
  syAmount: bigint,
  buyer: `0x${string}`
) {
  await client.request({ method: "anvil_impersonateAccount" as any, params: [buyer] });

  const approveData = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [router, syAmount],
  });
  const approveHash = await client.request({
    method: "eth_sendTransaction" as any,
    params: [{ from: buyer, to: syToken, data: approveData }],
  });
  await client.waitForTransactionReceipt({ hash: approveHash as `0x${string}` });

  const data = buildSwapCalldata(buyer, market, syAmount, 0n);
  const hash = await client.request({
    method: "eth_sendTransaction" as any,
    params: [{ from: buyer, to: router, data }],
  });
  const receipt = await client.waitForTransactionReceipt({ hash: hash as `0x${string}` });

  await client.request({ method: "anvil_stopImpersonatingAccount" as any, params: [buyer] });
  return receipt;
}
export type TakerTrigger = {
  spotBelowFairBps: number;
  targetBps: number;
  maxCapital: bigint;
};

export function decideTakerAction(
  ptSpotPrice: number,
  fairValuePrice: number,
  remainingCapitalSy: bigint,
  trigger: TakerTrigger
): { shouldBuy: boolean; targetSpendSy: bigint } {
  const discountBps = ((fairValuePrice - ptSpotPrice) / fairValuePrice) * 10_000;
  if (discountBps < trigger.spotBelowFairBps) return { shouldBuy: false, targetSpendSy: 0n };

  const spend = remainingCapitalSy / 4n > remainingCapitalSy ? remainingCapitalSy : remainingCapitalSy / 4n;
  return { shouldBuy: spend > 0n, targetSpendSy: spend };
}
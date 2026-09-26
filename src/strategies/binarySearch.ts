import type { Client } from "../chain/client.js";
import { quoteBuyPt } from "./taker.js";

export type SizingResult = {
  syAmount: bigint;
  netPtOut: bigint;
  effectivePrice: number;
  cappedByBudget: boolean;
};

/**
 * ONE quote call. Checks whether spending the full remaining capital stays under
 * the target price. If yes, spend it all. If no, spend nothing this trigger —
 * a real bot racing the clock doesn't have time to iterate toward a partial size;
 * it either commits its full available capital or waits for a better trigger.
 * This is the entire "computation": one eth_call, one comparison.
 */
export async function decideAndSizeBuy(
  client: Client,
  router: `0x${string}`,
  market: `0x${string}`,
  buyer: `0x${string}`,
  targetPrice: number,
  maxSy: bigint,
  decimals: { sy: number; pt: number }
): Promise<SizingResult> {
  if (maxSy <= 0n) {
    return { syAmount: 0n, netPtOut: 0n, effectivePrice: 0, cappedByBudget: false };
  }

  const quote = await quoteBuyPt(client, router, market, maxSy, buyer);
  const effectivePrice = Number(maxSy) / 10 ** decimals.sy / (Number(quote.netPtOut) / 10 ** decimals.pt);

  if (effectivePrice <= targetPrice) {
    return { syAmount: maxSy, netPtOut: quote.netPtOut, effectivePrice, cappedByBudget: true };
  }
  return { syAmount: 0n, netPtOut: 0n, effectivePrice, cappedByBudget: false };
}
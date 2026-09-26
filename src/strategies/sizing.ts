import type { Client } from "../chain/client.js";
import { quoteBuyPt } from "./taker.js";
import { exchangeRateAbi, pricePaidInAsset } from "../pricing/units.js";

export type SizingResult = {
  syAmount: bigint;
  netPtOut: bigint;
  /** Average price of the chosen buy, SY per PT (what Pendle quotes). */
  effectivePriceSy: number;
  /** Same price in asset per PT, comparable with spot, oracle and the risk target. */
  effectivePriceAsset: number;
  /** SY.exchangeRate() used for the conversion (raw). */
  syRate: bigint;
  quotes: number;
  reason: "full-budget" | "partial" | "spot-already-at-target" | "too-expensive";
};

const MAX_QUOTES = 4;

/**
 * Sizes a PT buy so the average price paid, in asset terms, stays at or below the target.
 *
 * 1. Quote the full remaining budget. If its average price is under the target, buy it all.
 * 2. Otherwise search for the largest size whose average price is under the target, with a
 *    secant step on (size, average price) starting from (0, spot). Stops at the first size
 *    within 5 bps under the target, after at most MAX_QUOTES quotes (a few ms each on a node),
 *    and buys the largest size that passed. Never buys a size that was not quoted.
 *
 * On the Aug 25 replay the average price of a Pendle buy ends close to the spot after the buy
 * (plus the ~0.06% fee), so capping the average at the target also stops spot near the target
 * instead of overshooting fair value.
 */
export async function decideAndSizeBuy(
  client: Client,
  router: `0x${string}`,
  market: `0x${string}`,
  syToken: `0x${string}`,
  buyer: `0x${string}`,
  targetPriceAsset: number,
  spotPriceAsset: number,
  maxSy: bigint,
  decimals: { sy: number; pt: number }
): Promise<SizingResult> {
  const syRate = await client.readContract({ address: syToken, abi: exchangeRateAbi, functionName: "exchangeRate" });
  const quotePt = async (sy: bigint) => (await quoteBuyPt(client, router, market, sy, buyer)).netPtOut;
  return sizeBuy(quotePt, syRate, targetPriceAsset, spotPriceAsset, maxSy, decimals);
}

/** The sizing rule on its own, with the Pendle quote injected so it can be tested offline. */
export async function sizeBuy(
  quotePt: (syAmount: bigint) => Promise<bigint>,
  syRate: bigint,
  targetPriceAsset: number,
  spotPriceAsset: number,
  maxSy: bigint,
  decimals: { sy: number; pt: number }
): Promise<SizingResult> {
  const none = (reason: SizingResult["reason"], quotes: number, sy = 0, asset = 0): SizingResult => ({
    syAmount: 0n,
    netPtOut: 0n,
    effectivePriceSy: sy,
    effectivePriceAsset: asset,
    syRate,
    quotes,
    reason,
  });

  if (maxSy <= 0n) return none("too-expensive", 0);
  if (spotPriceAsset >= targetPriceAsset) return none("spot-already-at-target", 0);

  // Secant search on "average price paid vs size", starting from (0, spot).
  // Aim 1 bp under the target so rounding in the last step does not tip us over.
  const aim = targetPriceAsset - 0.0001;
  let prev = { size: 0, price: spotPriceAsset };
  let size = maxSy;
  let best: SizingResult | null = null;
  let last = { sy: 0, asset: 0 };

  for (let q = 1; q <= MAX_QUOTES; q++) {
    const netPtOut = await quotePt(size);
    if (netPtOut === 0n) break;
    const priceSy = Number(size) / 10 ** decimals.sy / (Number(netPtOut) / 10 ** decimals.pt);
    const priceAsset = pricePaidInAsset(size, netPtOut, syRate, decimals);
    last = { sy: priceSy, asset: priceAsset };

    if (priceAsset <= targetPriceAsset && (!best || size > best.syAmount)) {
      best = {
        syAmount: size,
        netPtOut,
        effectivePriceSy: priceSy,
        effectivePriceAsset: priceAsset,
        syRate,
        quotes: q,
        reason: size === maxSy ? "full-budget" : "partial",
      };
      // Close enough to the target (or the whole budget fits): stop quoting.
      if (size === maxSy || targetPriceAsset - priceAsset < 0.0005) return best;
    }

    const cur = { size: Number(size), price: priceAsset };
    if (cur.price === prev.price) break;
    const nextSize = cur.size + ((aim - cur.price) * (cur.size - prev.size)) / (cur.price - prev.price);
    const next = BigInt(Math.floor(Math.min(Math.max(nextSize, 0), Number(maxSy))));
    if (next <= 0n || next === size) break;
    prev = cur;
    size = next;
  }

  if (best) return best;
  return none("too-expensive", MAX_QUOTES, last.sy, last.asset);
}

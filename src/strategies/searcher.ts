/**
 * A zero-capital searcher for P1nch: sells PT to P1nch strategies and buys it back on Pendle in
 * one P1nchArb transaction. It sizes the trade by simulating P1nchArb.arb with eth_call and
 * keeping the size that returns the most PT, so the search trusts no model of either pricing
 * curve: whatever P1nch and Pendle would do onchain is what it measures.
 */
import { encodeFunctionData, decodeFunctionResult, decodeErrorResult, BaseError, type Abi } from "viem";
import type { Order } from "@1inch/swap-vm-sdk";
import type { Client } from "../chain/client.js";

type Hex = `0x${string}`;

/**
 * Golden-section search for the maximum of `f` on (lo, hi). `f` returns null where the call
 * reverts; that region counts as below every real value. The arb's profit rises, peaks, falls to
 * zero, then reverts (Pendle cannot cover the PT), so the function is unimodal.
 * Returns the best point evaluated, or value null if every evaluation reverted.
 */
export async function maximize(
  f: (x: bigint) => Promise<bigint | null>,
  lo: bigint,
  hi: bigint,
  tol: bigint,
  maxEvals = 40
): Promise<{ x: bigint; value: bigint | null; evals: number }> {
  const phi = (Math.sqrt(5) - 1) / 2;
  const cache = new Map<bigint, bigint | null>();
  let best: { x: bigint; value: bigint | null } = { x: 0n, value: null };

  const g = async (xNum: number): Promise<number> => {
    const x = BigInt(Math.round(xNum));
    if (!cache.has(x)) {
      const v = await f(x);
      cache.set(x, v);
      if (v !== null && (best.value === null || v > best.value)) best = { x, value: v };
    }
    const v = cache.get(x)!;
    return v === null ? -1 : Number(v);
  };

  // Positions stay below 2^53 (5.6M PT is 5.6e12 raw), so Number arithmetic is exact enough.
  let a = Number(lo);
  let b = Number(hi);
  let c = b - phi * (b - a);
  let d = a + phi * (b - a);
  let fc = await g(c);
  let fd = await g(d);
  while (b - a > Number(tol) && cache.size < maxEvals) {
    if (fc >= fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - phi * (b - a);
      fc = await g(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + phi * (b - a);
      fd = await g(d);
    }
  }
  return { ...best, evals: cache.size };
}

export type ArbSource = { order: Order; balanceSy: bigint };

/**
 * Splits a PT amount across P1nch strategies in proportion to the SY each still holds. With the
 * same parameters and the same usage share, every strategy then quotes the same marginal bid.
 */
export function splitLegs(sources: ArbSource[], ptAmount: bigint) {
  const live = sources.filter((s) => s.balanceSy > 0n);
  const total = live.reduce((sum, s) => sum + s.balanceSy, 0n);
  const legs: { order: { maker: Hex; traits: bigint; data: Hex }; ptAmount: bigint }[] = [];
  let assigned = 0n;
  live.forEach((s, i) => {
    const amount = i === live.length - 1 ? ptAmount - assigned : (ptAmount * s.balanceSy) / total;
    assigned += amount;
    if (amount > 0n) legs.push({ order: s.order.build(), ptAmount: amount });
  });
  return legs;
}

export function arbCalldata(arbAbi: Abi, sources: ArbSource[], ptAmount: bigint, minProfitPt: bigint, profitTo: Hex): Hex {
  return encodeFunctionData({ abi: arbAbi, functionName: "arb", args: [splitLegs(sources, ptAmount), minProfitPt, profitTo] });
}

/** Best-effort name of a revert, from the P1nch ABIs (custom errors) or Error(string). */
export function revertReason(e: unknown, abi: Abi): string {
  const isHex = (v: unknown): v is Hex => typeof v === "string" && v.startsWith("0x");
  const found = e instanceof BaseError ? (e.walk((x: any) => isHex(x?.raw) || isHex(x?.data)) as any) : null;
  const data: Hex | undefined = isHex(found?.raw) ? found.raw : found?.data;
  if (!data || data === "0x") return e instanceof BaseError ? e.shortMessage : String(e);
  try {
    const decoded = decodeErrorResult({ abi, data });
    return `${decoded.errorName}(${(decoded.args ?? []).map(String).join(", ")})`;
  } catch {
    return `revert ${data.slice(0, 10)}`;
  }
}

export type ArbPlan = {
  ptAmount: bigint; // 0 when there is nothing worth doing
  profitPt: bigint;
  evals: number;
  ms: number;
  reason: string;
};

/**
 * Finds the profit-maximizing arb size. A small probe first: if even that reverts or earns too
 * little, Pendle already trades at or above P1nch's bid (or P1nch refuses), and the search stops.
 */
export async function planArb(
  client: Client,
  arbBot: Hex,
  arbAbi: Abi,
  errorAbi: Abi,
  searcher: Hex,
  sources: ArbSource[],
  opts: { maxPt: bigint; probePt: bigint; minProfitPt: bigint; tolPt: bigint }
): Promise<ArbPlan> {
  const start = Date.now();
  let firstRevert = "";

  const simulate = async (ptAmount: bigint): Promise<bigint | null> => {
    if (ptAmount <= 0n) return null;
    try {
      const { data } = await client.call({
        account: searcher,
        to: arbBot,
        data: arbCalldata(arbAbi, sources, ptAmount, 0n, searcher),
      });
      return decodeFunctionResult({ abi: arbAbi, functionName: "arb", data: data! }) as bigint;
    } catch (e) {
      if (!firstRevert) firstRevert = revertReason(e, errorAbi);
      return null;
    }
  };

  const probe = await simulate(opts.probePt);
  if (probe === null || probe <= 0n) {
    return { ptAmount: 0n, profitPt: 0n, evals: 1, ms: Date.now() - start, reason: firstRevert || "no profit at probe size" };
  }

  const best = await maximize(simulate, 0n, opts.maxPt, opts.tolPt);
  const ms = Date.now() - start;
  if (best.value === null || best.value < opts.minProfitPt) {
    return { ptAmount: 0n, profitPt: best.value ?? 0n, evals: best.evals + 1, ms, reason: "profit below minimum" };
  }
  return { ptAmount: best.x, profitPt: best.value, evals: best.evals + 1, ms, reason: "max profit" };
}

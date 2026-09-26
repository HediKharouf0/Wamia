/**
 * P1nch strategies built with 1inch's official SDKs:
 *   - @1inch/swap-vm-sdk: the SwapVM program, the order, taker traits, quote/swap calldata
 *   - @1inch/aqua-sdk:    ship/dock calldata
 *
 * Mirrors contracts/src/P1nchQuoter.sol and P1nchOrders.sol. contracts/test/SdkParity.t.sol
 * checks that both sides produce the same bytes.
 */
import { encodePacked, keccak256, encodeAbiParameters } from "viem";
import {
  Address,
  HexString,
  AquaProgramBuilder,
  MakerTraits,
  Order,
  TakerTraits,
  SwapVMContract,
  instructions,
} from "@1inch/swap-vm-sdk";
import { AquaProtocolContract, Address as AquaAddress, HexString as AquaHexString } from "@1inch/aqua-sdk";

type Hex = `0x${string}`;

/** Same fields and packing as P1nchQuoter.Params (129 bytes). */
export type P1nchParams = {
  pt: Hex;
  sy: Hex;
  market: Hex;
  curvePool: Hex; // Curve StableSwap-NG pool pricing the underlying vs its NAV; zero address disables the depeg stop
  refYieldWad: bigint; // e.g. 105830000000000000n for 10.583%
  discountMinBps: number; // discount when the backstop is untouched, e.g. 10
  discountMaxBps: number; // discount when it is fully used, e.g. 60
  shippedSy: bigint; // SY shipped to Aqua for this strategy (raw)
  minSyRate: bigint; // SY.exchangeRate() floor
  maxDepegBps: number; // underlying at most this far below NAV, e.g. 100
  maxDeviationBps: number; // Pendle spot at most this far below fair, e.g. 450
  flags: number; // 1 if the underlying is coins[1] in the Curve pool
};

export function encodeP1nchParams(p: P1nchParams): Hex {
  return encodePacked(
    ["address", "address", "address", "address", "uint64", "uint16", "uint16", "uint128", "uint128", "uint16", "uint16", "uint8"],
    [
      p.pt,
      p.sy,
      p.market,
      p.curvePool,
      p.refYieldWad,
      p.discountMinBps,
      p.discountMaxBps,
      p.shippedSy,
      p.minSyRate,
      p.maxDepegBps,
      p.maxDeviationBps,
      p.flags,
    ]
  );
}

/** Same fields and packing as P1nchSpendLimit.Params (34 bytes). */
export type SpendLimitParams = {
  shippedSy: bigint; // SY shipped with the strategy
  windowSec: number; // spending window, 12 = one mainnet block
  minCapBps: number; // share of shippedSy per window far from maturity, e.g. 2000
  horizonSec: number; // the cap grows linearly to 100% over the last horizonSec before expiry
  expiry: bigint; // PT maturity (unix seconds)
};

/** Same fields and packing as P1nchRateGuard.Params (60 bytes). */
export type RateGuardParams = {
  sy: Hex;
  rateAtShip: bigint; // SY.exchangeRate() at ship
  shipTimestamp: bigint;
  maxDropBps: number; // tolerated dip below the high-water mark, e.g. 0
  minElapsed: number; // seconds before the underlying-yield check starts, e.g. 3 days
  refYieldWad: bigint; // reference implied APY
  maxYieldGapBps: number; // refuse if the underlying earns more than reference + this, e.g. 1000
};

/** The v2 rules as extra Extruction steps: the rate guard before the quoter, the spend limit after. */
export type P1nchGuards = { rateGuard: Hex; rateGuardParams: RateGuardParams; spendLimit: Hex; spendLimitParams: SpendLimitParams };

export function encodeSpendLimitParams(p: SpendLimitParams): Hex {
  return encodePacked(["uint128", "uint32", "uint16", "uint32", "uint64"], [p.shippedSy, p.windowSec, p.minCapBps, p.horizonSec, p.expiry]);
}

export function encodeRateGuardParams(p: RateGuardParams): Hex {
  return encodePacked(
    ["address", "uint128", "uint64", "uint16", "uint32", "uint64", "uint16"],
    [p.sy, p.rateAtShip, p.shipTimestamp, p.maxDropBps, p.minElapsed, p.refYieldWad, p.maxYieldGapBps]
  );
}

function extructionIx(target: Hex, args: Hex) {
  return instructions.extruction.extruction.createIx(new instructions.extruction.ExtructionArgs(new Address(target), new HexString(args)));
}

/**
 * The strategy program on the Aqua opcode table of the deployed router: one Extruction calling the
 * quoter, or with guards [RateGuard][Quoter][SpendLimit]. The spend limit must come after the
 * quoter, since it checks the SY the quoter priced.
 */
export function buildP1nchProgram(quoter: Hex, params: P1nchParams, guards?: P1nchGuards) {
  const builder = new AquaProgramBuilder();
  if (guards) builder.add(extructionIx(guards.rateGuard, encodeRateGuardParams(guards.rateGuardParams)));
  builder.add(extructionIx(quoter, encodeP1nchParams(params)));
  if (guards) builder.add(extructionIx(guards.spendLimit, encodeSpendLimitParams(guards.spendLimitParams)));
  return builder.build();
}

/** Aqua-mode order: no signature, receiver = maker, no hooks (MakerTraits.default()). */
export function buildP1nchOrder(maker: Hex, quoter: Hex, params: P1nchParams, guards?: P1nchGuards): Order {
  return Order.new({ maker: new Address(maker), traits: MakerTraits.default(), program: buildP1nchProgram(quoter, params, guards) });
}

/** Aqua strategy hash = router.hash(order) for Aqua orders = keccak256(abi.encode(order)). */
export function strategyHash(order: Order): Hex {
  const built = order.build();
  return keccak256(encodeAbiParameters([Order.ABI], [built]));
}

export type CallInfo = { to: Hex; data: Hex; value: bigint };

const asCall = (c: { to: string; data: string; value: bigint }): CallInfo => ({
  to: c.to as Hex,
  data: c.data as Hex,
  value: c.value,
});

/** LP ships SY (the spending cap) and registers PT with 0 so the router can read both balances. */
export function shipTx(aqua: Hex, router: Hex, order: Order, sy: Hex, pt: Hex, syAmount: bigint): CallInfo {
  const contract = new AquaProtocolContract(new AquaAddress(aqua));
  return asCall(
    contract.ship({
      app: new AquaAddress(router),
      strategy: new AquaHexString(order.encode().toString()),
      amountsAndTokens: [
        { token: new AquaAddress(sy), amount: syAmount },
        { token: new AquaAddress(pt), amount: 0n },
      ],
    })
  );
}

export function dockTx(aqua: Hex, router: Hex, order: Order, sy: Hex, pt: Hex): CallInfo {
  const contract = new AquaProtocolContract(new AquaAddress(aqua));
  return asCall(
    contract.dock({
      app: new AquaAddress(router),
      strategyHash: new AquaHexString(strategyHash(order)),
      tokens: [new AquaAddress(sy), new AquaAddress(pt)],
    })
  );
}

export type SellPtOptions = {
  /** true: `amount` is PT in; false: `amount` is SY out */
  exactIn?: boolean;
  /** min SY out (exact in) or max PT in (exact out); 0 = none */
  threshold?: bigint;
  /** router pulls PT from the taker (taker approves the router); default true */
  pullPtFromTaker?: boolean;
  /** call taker.preTransferInCallback after SY is sent, before PT is collected (flash-style arb) */
  callbackData?: Hex;
};

export function sellPtTakerTraits(o: SellPtOptions = {}): TakerTraits {
  return TakerTraits.default().with({
    exactIn: o.exactIn ?? true,
    threshold: o.threshold ?? 0n,
    useTransferFromAndAquaPush: o.pullPtFromTaker ?? true,
    preTransferInCallbackEnabled: o.callbackData !== undefined,
    preTransferInCallbackData: o.callbackData ? new HexString(o.callbackData) : HexString.EMPTY,
  });
}

function swapArgs(order: Order, pt: Hex, sy: Hex, amount: bigint, traits: TakerTraits) {
  return { order, tokenIn: new Address(pt), tokenOut: new Address(sy), amount, takerTraits: traits };
}

/** router.quote(...) calldata; run it with eth_call from the taker. */
export function quoteSellPtTx(router: Hex, order: Order, pt: Hex, sy: Hex, amount: bigint, o: SellPtOptions = {}): CallInfo {
  return asCall(new SwapVMContract(new Address(router)).quote(swapArgs(order, pt, sy, amount, sellPtTakerTraits(o))));
}

/** router.swap(...) calldata; send it from the taker. */
export function swapSellPtTx(router: Hex, order: Order, pt: Hex, sy: Hex, amount: bigint, o: SellPtOptions = {}): CallInfo {
  return asCall(new SwapVMContract(new Address(router)).swap(swapArgs(order, pt, sy, amount, sellPtTakerTraits(o))));
}

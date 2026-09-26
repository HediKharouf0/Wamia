/**
 * The Aug 25 manipulator, in three modes:
 *
 *   historical  its exact calldata. Each trade carries a min YT out and tight bounds for Pendle's
 *               solver, both computed for the historical state. Once Wamia lifts the price between
 *               trades, some of them can revert, which would flatter Wamia.
 *   adaptive    the same SY per trade (same limit-order fills), with the min out and solver bounds
 *               reset for whatever the state is. The attack pushes with the same money whatever
 *               Wamia does. This is the fair comparison.
 *   persistent  adaptive, plus extra SY pushed after the last historical trade (see extraAttackEvents).
 *
 * Selector 0x7b8b4b95 matches this signature (checked against the manipulator's real calldata).
 */
import { parseAbi, decodeFunctionData, encodeFunctionData, maxUint256 } from "viem";

type Hex = `0x${string}`;

export type AttackerMode = "historical" | "adaptive";

const fill =
  "((uint256 salt,uint256 expiry,uint256 nonce,uint8 orderType,address token,address YT,address maker,address receiver,uint256 makingAmount,uint256 lnImpliedRate,uint256 failSafeRate,bytes permit) order,bytes signature,uint256 makingAmount)[]";

export const swapExactSyForYtAbi = parseAbi([
  `function swapExactSyForYt(address receiver,address market,uint256 exactSyIn,uint256 minYtOut,(uint256 guessMin,uint256 guessMax,uint256 guessOffchain,uint256 maxIteration,uint256 eps) guessYtOut,(address limitRouter,uint256 epsSkipMarket,${fill} normalFills,${fill} flashFills,bytes optData) limit) returns (uint256 netYtOut,uint256 netSyFee,uint256 netSyInterm)`,
]);

/** Pendle's default solver settings (the same ones WamiaArb uses). */
const OPEN_APPROX = { guessMin: 0n, guessMax: maxUint256, guessOffchain: 0n, maxIteration: 256n, eps: 10n ** 14n };

/** The manipulator's calldata for this mode; `syIn` replaces the amount (for extra pushes). */
export function attackInput(input: Hex, mode: AttackerMode, syIn?: bigint): Hex {
  if (mode === "historical" && syIn === undefined) return input;
  const { args } = decodeFunctionData({ abi: swapExactSyForYtAbi, data: input });
  const [receiver, market, exactSyIn, , , limit] = args;
  return encodeFunctionData({
    abi: swapExactSyForYtAbi,
    functionName: "swapExactSyForYt",
    args: [receiver, market, syIn ?? exactSyIn, 0n, OPEN_APPROX, limit],
  });
}

export function syInOf(input: Hex): bigint {
  const { args } = decodeFunctionData({ abi: swapExactSyForYtAbi, data: input });
  return args[2];
}

/**
 * Extra pushes for a persistent attacker: `extraSy` more SY, in `chunkSy` trades every 12 s
 * starting one block after the last historical push. Built from that push, which fills no
 * limit orders.
 */
export function extraAttackEvents(lastPush: any, extraSy: bigint, chunkSy: bigint): any[] {
  const events: any[] = [];
  let left = extraSy;
  let ts = Number(lastPush.timeStamp);
  for (let k = 1; left > 0n; k++) {
    const amount = left < chunkSy ? left : chunkSy;
    left -= amount;
    ts += 12;
    events.push({
      ...lastPush,
      hash: `extra-push-${k}`,
      extra: true,
      timeStamp: String(ts),
      input: attackInput(lastPush.input, "adaptive", amount),
    });
  }
  return events;
}

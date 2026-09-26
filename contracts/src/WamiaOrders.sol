// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/src/libs/TakerTraits.sol";

/// @title WamiaOrders
/// @notice Builds the SwapVM order a Wamia LP ships to Aqua, and the taker data used to fill it,
///         with swap-vm v1.0.2's own trait libraries (no hand-packed bits).
library WamiaOrders {
    /// @notice Aqua-mode order: no signature, balances read from and settled through Aqua,
    ///         receiver = maker, no hooks. Ship it with
    ///         `aqua.ship(router, abi.encode(order), [SY, PT], [syAmount, 0])`.
    function makerOrder(address maker, bytes memory program) internal pure returns (ISwapVM.Order memory) {
        return MakerTraitsLib.build(
            MakerTraitsLib.Args({
                maker: maker,
                receiver: address(0),
                shouldUnwrapWeth: false,
                useAquaInsteadOfSignature: true,
                allowZeroAmountIn: false,
                hasPreTransferInHook: false,
                hasPostTransferInHook: false,
                hasPreTransferOutHook: false,
                hasPostTransferOutHook: false,
                preTransferInTarget: address(0),
                preTransferInData: "",
                postTransferInTarget: address(0),
                postTransferInData: "",
                preTransferOutTarget: address(0),
                preTransferOutData: "",
                postTransferOutTarget: address(0),
                postTransferOutData: "",
                program: program
            })
        );
    }

    /// @notice Taker data for a PT sale.
    /// @param taker                  Address calling router.swap (must match msg.sender)
    /// @param isExactIn              true: `amount` is PT in; false: `amount` is SY out
    /// @param threshold              Min SY out (exact in) or max PT in (exact out); 0 = none
    /// @param pullPtFromTaker        true: the router transferFroms PT and pushes it to Aqua (taker
    ///                               approves the router); false: the taker pushes to Aqua itself
    /// @param preTransferInCallback  Call taker.preTransferInCallback after SY is sent and before PT is
    ///                               collected, so a contract can source the PT flash-swap style
    /// @param callbackData           Data passed to that callback
    function takerData(
        address taker,
        bool isExactIn,
        uint256 threshold,
        bool pullPtFromTaker,
        bool preTransferInCallback,
        bytes memory callbackData
    ) internal pure returns (bytes memory) {
        return TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: taker,
                isExactIn: isExactIn,
                shouldUnwrapWeth: false,
                isStrictThresholdAmount: false,
                isFirstTransferFromTaker: false,
                useTransferFromAndAquaPush: pullPtFromTaker,
                threshold: threshold == 0 ? bytes("") : abi.encodePacked(threshold),
                to: address(0),
                deadline: 0,
                hasPreTransferInCallback: preTransferInCallback,
                hasPreTransferOutCallback: false,
                preTransferInHookData: "",
                postTransferInHookData: "",
                preTransferOutHookData: "",
                postTransferOutHookData: "",
                preTransferInCallbackData: callbackData,
                preTransferOutCallbackData: "",
                instructionsArgs: "",
                signature: ""
            })
        );
    }
}

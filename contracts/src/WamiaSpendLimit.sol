// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IExtruction } from "@1inch/swap-vm/src/instructions/Extruction.sol";
import { SwapQuery, SwapRegisters } from "@1inch/swap-vm/src/libs/VM.sol";

/// @title WamiaSpendLimit
/// @notice Spec 7.4 v2: a Wamia strategy may pay out at most a share of its shipped SY per block
///         (a `windowSec` slot, 12 s on mainnet), so a pricing bug or an undetected real collapse
///         cannot empty it at once. The share grows linearly as maturity approaches, from
///         `minCapBps` when `horizonSec` or more remain to 100% at expiry: less time left, less can
///         go wrong. Size it so the whole backstop can still deploy well inside the oracle window.
/// @dev An Extruction step placed AFTER WamiaQuoter in the program, so `swap.amountOut` holds the SY
///      the trade pays. Spending is keyed by the router-provided order hash and recorded only in
///      swap mode and only when called by the router: quotes never consume budget, and nobody can
///      burn a strategy's budget by calling this contract directly.
contract WamiaSpendLimit is IExtruction {
    uint8 public constant EXTRUCTION_OPCODE = 0x20;
    /// @notice shippedSy 16 + windowSec 4 + minCapBps 2 + horizonSec 4 + expiry 8
    uint256 public constant PARAMS_LENGTH = 34;
    uint256 private constant BPS = 10_000;

    /// @notice The AquaSwapVMRouter allowed to record spending.
    address public immutable ROUTER;

    struct Params {
        uint128 shippedSy; // SY shipped with the strategy (same value as in WamiaQuoter's params)
        uint32 windowSec; // spending window, e.g. 12 (one mainnet slot)
        uint16 minCapBps; // share of shippedSy per window far from maturity, e.g. 2000
        uint32 horizonSec; // the cap starts growing when less than this remains, e.g. 180 days
        uint64 expiry; // PT maturity
    }

    struct Window {
        uint64 id; // block.timestamp / windowSec
        uint128 spent; // SY paid out in that window
    }

    mapping(bytes32 orderHash => Window) public windows;

    error NotRouter(address caller);
    error BadParamsLength(uint256 length);
    error BadParams();
    error NotPricedYet();
    error SpendLimitExceeded(uint256 spentInWindow, uint256 cap);

    constructor(address router) {
        require(router != address(0), BadParams());
        ROUTER = router;
    }

    /// @inheritdoc IExtruction
    function extruction(
        bool isStaticContext,
        uint256 nextPC,
        SwapQuery calldata query,
        SwapRegisters calldata swap,
        bytes calldata args,
        bytes calldata /* takerData */
    ) external returns (uint256 updatedNextPC, uint256 choppedLength, SwapRegisters memory updatedSwap) {
        Params memory p = decodeParams(args);
        // Placed before the quoter, an exact-in trade would show 0 here and pass unchecked.
        require(swap.amountOut != 0, NotPricedYet());

        uint256 cap = capOf(p);
        uint256 spent = spentInWindow(query.orderHash, p) + swap.amountOut;
        require(spent <= cap, SpendLimitExceeded(spent, cap));

        if (!isStaticContext) {
            require(msg.sender == ROUTER, NotRouter(msg.sender));
            // Safe: spent <= cap <= shippedSy (uint128); the window id is a timestamp / windowSec.
            // forge-lint: disable-next-line(unsafe-typecast)
            windows[query.orderHash] = Window(uint64(block.timestamp / p.windowSec), uint128(spent));
        }
        return (nextPC, 0, swap);
    }

    /// @notice Share of the shipped SY this strategy may pay per window right now, in bps.
    function capBps(Params memory p) public view returns (uint256) {
        // A validator can shift the timestamp by seconds; irrelevant against a maturity date.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= p.expiry) return BPS;
        uint256 left = p.expiry - block.timestamp;
        // forge-lint: disable-next-line(block-timestamp)
        if (left >= p.horizonSec) return p.minCapBps;
        return p.minCapBps + (BPS - p.minCapBps) * (p.horizonSec - left) / p.horizonSec;
    }

    /// @notice SY this strategy may pay per window right now.
    function capOf(Params memory p) public view returns (uint256) {
        return uint256(p.shippedSy) * capBps(p) / BPS;
    }

    /// @notice SY already paid by `orderHash` in the current window.
    function spentInWindow(bytes32 orderHash, Params memory p) public view returns (uint256) {
        Window memory w = windows[orderHash];
        // forge-lint: disable-next-line(block-timestamp)
        return w.id == block.timestamp / p.windowSec ? w.spent : 0;
    }

    /// @notice The Extruction instruction for this step: [0x20][54][this][params, 34 bytes].
    function program(Params memory p) external view returns (bytes memory) {
        // Safe: params are always PARAMS_LENGTH (34) bytes, so the length is 54.
        // forge-lint: disable-next-line(unsafe-typecast)
        return abi.encodePacked(EXTRUCTION_OPCODE, uint8(20 + PARAMS_LENGTH), address(this), encodeParams(p));
    }

    function encodeParams(Params memory p) public pure returns (bytes memory) {
        return abi.encodePacked(p.shippedSy, p.windowSec, p.minCapBps, p.horizonSec, p.expiry);
    }

    function decodeParams(bytes calldata args) public pure returns (Params memory p) {
        require(args.length == PARAMS_LENGTH, BadParamsLength(args.length));
        p.shippedSy = uint128(bytes16(args[0:16]));
        p.windowSec = uint32(bytes4(args[16:20]));
        p.minCapBps = uint16(bytes2(args[20:22]));
        p.horizonSec = uint32(bytes4(args[22:26]));
        p.expiry = uint64(bytes8(args[26:34]));
        require(p.shippedSy > 0 && p.windowSec > 0 && p.minCapBps > 0 && p.minCapBps <= BPS && p.horizonSec > 0, BadParams());
    }
}

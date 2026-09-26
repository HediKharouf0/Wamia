// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { FixedPointMathLib as FPM } from "solady/utils/FixedPointMathLib.sol";
import { IExtruction } from "@1inch/swap-vm/src/instructions/Extruction.sol";
import { SwapQuery, SwapRegisters } from "@1inch/swap-vm/src/libs/VM.sol";

import { IStandardizedYieldLike } from "./interfaces/IPendle.sol";

/// @title WamiaRateGuard
/// @notice Spec 7.4 v2, two checks on the SY exchange rate (reUSD's NAV), before Wamia prices:
///         1. High-water mark: the rate should only grow, so refuse on any drop below the highest
///            rate seen by this strategy (or the rate at ship), beyond `maxDropBps` of tolerance.
///            Tighter than WamiaQuoter's fixed floor once the rate has grown.
///         2. Underlying-yield check: once `minElapsed` has passed since ship, the yield reUSD
///            actually earned since then, annualized, must not exceed the reference rate by more
///            than `maxYieldGapBps`. If the underlying now earns far more than the reference, PT is
///            worth less than Wamia's fair value says, and Wamia would overpay.
/// @dev An Extruction step placed BEFORE WamiaQuoter; it never changes the registers. The high-water
///      mark is keyed by the router-provided order hash and written only in swap mode and only when
///      called by the router, so quotes never move it and nobody can set it from outside.
contract WamiaRateGuard is IExtruction {
    uint8 public constant EXTRUCTION_OPCODE = 0x20;
    /// @notice sy 20 + rateAtShip 16 + shipTimestamp 8 + maxDropBps 2 + minElapsed 4 + refYieldWad 8 + maxYieldGapBps 2
    uint256 public constant PARAMS_LENGTH = 60;
    uint256 private constant WAD = 1e18;
    uint256 private constant BPS = 10_000;
    /// @dev expWad overflows above ~135e18; any argument that large is an absurd yield anyway.
    int256 private constant MAX_EXP_ARG = 135e18;

    /// @notice The AquaSwapVMRouter allowed to record the high-water mark.
    address public immutable ROUTER;

    struct Params {
        address sy; // SY token (exchangeRate(): asset = sy * rate / 1e18)
        uint128 rateAtShip; // SY.exchangeRate() when the strategy was shipped
        uint64 shipTimestamp; // when it was shipped
        uint16 maxDropBps; // tolerated dip below the high-water mark, e.g. 0
        uint32 minElapsed; // the yield check starts after this long, e.g. 3 days
        uint64 refYieldWad; // reference implied APY (same as WamiaQuoter's), e.g. 0.10583e18
        uint16 maxYieldGapBps; // refuse if the underlying earns more than reference + this, e.g. 1000
    }

    mapping(bytes32 orderHash => uint256) public highWaterMark;

    error NotRouter(address caller);
    error BadParamsLength(uint256 length);
    error BadParams();
    error RateBelowHighWaterMark(uint256 rate, uint256 highWaterMark);
    error UnderlyingYieldAboveReference(uint256 realizedApyWad, uint256 maxApyWad);

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
        (uint256 rate, uint256 mark) = check(query.orderHash, p);
        if (!isStaticContext) {
            require(msg.sender == ROUTER, NotRouter(msg.sender));
            if (rate > mark) highWaterMark[query.orderHash] = rate;
        }
        return (nextPC, 0, swap);
    }

    /// @notice Runs both checks; returns the current rate and the high-water mark it was held to.
    function check(bytes32 orderHash, Params memory p) public view returns (uint256 rate, uint256 mark) {
        rate = IStandardizedYieldLike(p.sy).exchangeRate();
        mark = FPM.max(highWaterMark[orderHash], p.rateAtShip);
        require(rate * BPS >= mark * (BPS - p.maxDropBps), RateBelowHighWaterMark(rate, mark));

        // A validator can shift the timestamp by seconds; irrelevant against a window of days.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < uint256(p.shipTimestamp) + p.minElapsed || rate <= p.rateAtShip) return (rate, mark);
        uint256 realized = realizedApy(p, rate);
        uint256 maxApy = uint256(p.refYieldWad) + uint256(p.maxYieldGapBps) * WAD / BPS;
        require(realized <= maxApy, UnderlyingYieldAboveReference(realized, maxApy));
    }

    /// @notice Annualized yield of the SY rate since ship: (rate / rateAtShip)^(1 year / elapsed) - 1.
    function realizedApy(Params memory p, uint256 rate) public view returns (uint256) {
        uint256 elapsed = block.timestamp - p.shipTimestamp;
        // forge-lint: disable-next-line(block-timestamp)
        if (elapsed == 0 || rate <= p.rateAtShip) return 0;
        // Safe: rate / rateAtShip > 1 and both are exchange rates far below 2^128.
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 lnGrowth = FPM.lnWad(int256(rate * WAD / p.rateAtShip));
        // Safe: elapsed is a duration in seconds.
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 arg = lnGrowth * int256(365 days) / int256(elapsed);
        if (arg >= MAX_EXP_ARG) return type(uint256).max;
        // Safe: arg >= 0, so expWad(arg) >= WAD.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint256(FPM.expWad(arg)) - WAD;
    }

    /// @notice The Extruction instruction for this step: [0x20][80][this][params, 60 bytes].
    function program(Params memory p) external view returns (bytes memory) {
        // Safe: params are always PARAMS_LENGTH (60) bytes, so the length is 80.
        // forge-lint: disable-next-line(unsafe-typecast)
        return abi.encodePacked(EXTRUCTION_OPCODE, uint8(20 + PARAMS_LENGTH), address(this), encodeParams(p));
    }

    function encodeParams(Params memory p) public pure returns (bytes memory) {
        return abi.encodePacked(p.sy, p.rateAtShip, p.shipTimestamp, p.maxDropBps, p.minElapsed, p.refYieldWad, p.maxYieldGapBps);
    }

    function decodeParams(bytes calldata args) public pure returns (Params memory p) {
        require(args.length == PARAMS_LENGTH, BadParamsLength(args.length));
        p.sy = address(bytes20(args[0:20]));
        p.rateAtShip = uint128(bytes16(args[20:36]));
        p.shipTimestamp = uint64(bytes8(args[36:44]));
        p.maxDropBps = uint16(bytes2(args[44:46]));
        p.minElapsed = uint32(bytes4(args[46:50]));
        p.refYieldWad = uint64(bytes8(args[50:58]));
        p.maxYieldGapBps = uint16(bytes2(args[58:60]));
        require(p.sy != address(0) && p.rateAtShip > 0 && p.maxDropBps < BPS && p.minElapsed > 0, BadParams());
    }
}

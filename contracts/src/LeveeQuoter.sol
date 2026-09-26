// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IExtruction } from "@1inch/swap-vm/src/instructions/Extruction.sol";
import { SwapQuery, SwapRegisters } from "@1inch/swap-vm/src/libs/VM.sol";

import { LeveeMath } from "./LeveeMath.sol";
import { IPMarketLike, IStandardizedYieldLike } from "./interfaces/IPendle.sol";

/// @title LeveeQuoter
/// @notice Pricing and risk rules for Levee strategies, called by SwapVM's `Extruction`
///         instruction on the deployed AquaSwapVMRouter (swap-vm v1.0.2).
/// @dev A Levee strategy is an Aqua-shipped SwapVM order whose program is a single Extruction
///      pointing here. The LP ships SY (and PT with amount 0), and this contract decides on every
///      trade whether to buy PT for SY and at what price. The shipped SY is the hard spending cap.
///
///      v1 rules, all from maker parameters, onchain reads and block time (never taker data):
///        1. Direction: only PT in, SY out.
///        2. Maturity: refuse at or after the market's expiry.
///        3. Depeg stop: refuse if SY.exchangeRate() is below the maker's floor.
///        4. Price: fair value 1/(1+refYield)^tau minus a fixed discount, never above fair.
///        5. Size: refuse trades above maxPtPerTrade, or paying more SY than the strategy holds.
///
///      The contract is stateless, so the same view function serves quote() and swap(), which
///      keeps quotes and swaps identical as SwapVM requires.
contract LeveeQuoter is IExtruction {
    /// @notice Index of `Extruction._extruction` in the AquaOpcodes table of swap-vm v1.0.2.
    /// @dev The deployed router uses a jump table, not the banked OpcodeList of swap-vm `main`.
    uint8 public constant EXTRUCTION_OPCODE = 0x20;

    /// @notice Byte length of the packed parameters (see `encodeParams`).
    uint256 public constant PARAMS_LENGTH = 102;

    /// @notice Strategy parameters, packed into the Extruction args at ship time (immutable per strategy).
    /// @param pt            PT token (tokenIn)
    /// @param sy            SY token (tokenOut)
    /// @param market        Pendle market of this PT, read for the expiry
    /// @param refYieldWad   Reference implied APY for fair value, e.g. 0.10583e18
    /// @param discountBps   Bid discount below fair value, e.g. 10 = 0.10%
    /// @param maxPtPerTrade Largest PT amount accepted in one trade (PT raw units)
    /// @param minSyRate     Depeg floor for SY.exchangeRate(); below it every trade is refused
    struct Params {
        address pt;
        address sy;
        address market;
        uint64 refYieldWad;
        uint16 discountBps;
        uint128 maxPtPerTrade;
        uint128 minSyRate;
    }

    error BadParamsLength(uint256 length);
    error OnlyPtToSy(address tokenIn, address tokenOut);
    error MarketExpired(uint256 expiry);
    error SyBelowFloor(uint256 rate, uint256 minRate);
    error TradeTooLarge(uint256 ptIn, uint256 maxPtPerTrade);
    error InsufficientLiquidity(uint256 syOut, uint256 syAvailable);

    /// @inheritdoc IExtruction
    function extruction(
        bool, /* isStaticContext */
        uint256 nextPC,
        SwapQuery calldata query,
        SwapRegisters calldata swap,
        bytes calldata args,
        bytes calldata /* takerData: never used for risk decisions */
    ) external view returns (uint256 updatedNextPC, uint256 choppedLength, SwapRegisters memory updatedSwap) {
        Params memory p = decodeParams(args);
        require(query.tokenIn == p.pt && query.tokenOut == p.sy, OnlyPtToSy(query.tokenIn, query.tokenOut));

        (, uint256 bid, uint256 syRate) = bidPrice(p);

        updatedSwap = swap;
        if (query.isExactIn) {
            updatedSwap.amountOut = LeveeMath.ptToSyDown(swap.amountIn, bid, syRate);
        } else {
            updatedSwap.amountIn = LeveeMath.syToPtUp(swap.amountOut, bid, syRate);
        }

        require(updatedSwap.amountIn <= p.maxPtPerTrade, TradeTooLarge(updatedSwap.amountIn, p.maxPtPerTrade));
        require(updatedSwap.amountOut <= swap.balanceOut, InsufficientLiquidity(updatedSwap.amountOut, swap.balanceOut));

        return (nextPC, 0, updatedSwap);
    }

    /// @notice Current fair value and bid for a strategy, with the maturity and depeg checks applied.
    /// @return fairWad Fair PT price in asset terms (wad)
    /// @return bidWad  Price Levee pays, fair minus discount (wad)
    /// @return syRate  SY.exchangeRate() used for the conversion
    function bidPrice(Params memory p) public view returns (uint256 fairWad, uint256 bidWad, uint256 syRate) {
        uint256 expiry = IPMarketLike(p.market).expiry();
        // A validator can shift the timestamp by seconds; irrelevant against a maturity date.
        // forge-lint: disable-next-line(block-timestamp)
        require(block.timestamp < expiry, MarketExpired(expiry));

        syRate = IStandardizedYieldLike(p.sy).exchangeRate();
        require(syRate >= p.minSyRate, SyBelowFloor(syRate, p.minSyRate));

        fairWad = LeveeMath.ptPriceFromYield(p.refYieldWad, expiry - block.timestamp);
        bidWad = LeveeMath.applyDiscount(fairWad, p.discountBps);
    }

    /// @notice The SwapVM program for a Levee strategy: one Extruction instruction calling this contract.
    /// @dev Layout: [opcode 1 byte][args length 1 byte][this contract 20 bytes][params 102 bytes].
    function program(Params memory p) external view returns (bytes memory) {
        bytes memory params = encodeParams(p);
        // Safe: params are always PARAMS_LENGTH (102) bytes, so the length is 122.
        // forge-lint: disable-next-line(unsafe-typecast)
        return abi.encodePacked(EXTRUCTION_OPCODE, uint8(20 + params.length), address(this), params);
    }

    /// @notice Pack parameters into 102 bytes (the Extruction args limit is 255 bytes including the target).
    function encodeParams(Params memory p) public pure returns (bytes memory) {
        return abi.encodePacked(p.pt, p.sy, p.market, p.refYieldWad, p.discountBps, p.maxPtPerTrade, p.minSyRate);
    }

    function decodeParams(bytes calldata args) public pure returns (Params memory p) {
        require(args.length == PARAMS_LENGTH, BadParamsLength(args.length));
        p.pt = address(bytes20(args[0:20]));
        p.sy = address(bytes20(args[20:40]));
        p.market = address(bytes20(args[40:60]));
        p.refYieldWad = uint64(bytes8(args[60:68]));
        p.discountBps = uint16(bytes2(args[68:70]));
        p.maxPtPerTrade = uint128(bytes16(args[70:86]));
        p.minSyRate = uint128(bytes16(args[86:102]));
    }
}

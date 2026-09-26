// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { FixedPointMathLib as FPM } from "solady/utils/FixedPointMathLib.sol";
import { IExtruction } from "@1inch/swap-vm/src/instructions/Extruction.sol";
import { SwapQuery, SwapRegisters } from "@1inch/swap-vm/src/libs/VM.sol";

import { P1nchMath } from "./P1nchMath.sol";
import { IPMarketLike, IStandardizedYieldLike, ICurveStableSwapNGLike } from "./interfaces/IPendle.sol";

/// @title P1nchQuoter
/// @notice Pricing and risk rules for P1nch strategies, called by SwapVM's `Extruction`
///         instruction on the deployed AquaSwapVMRouter (swap-vm v1.0.2).
/// @dev A P1nch strategy is an Aqua-shipped SwapVM order whose program is a single Extruction
///      pointing here. The LP ships SY (and PT with amount 0); this contract decides on every trade
///      whether to buy PT for SY and at what price. The shipped SY is the hard spending cap.
///
///      Rules, all from maker parameters, onchain reads and block time (never taker data):
///        1. Direction: only PT in, SY out.
///        2. Maturity: refuse at or after the market's expiry.
///        3. SY exchange-rate floor: catches a loss in reUSD's internal accounting (NAV).
///        4. Market depeg stop: refuse if the underlying trades more than `maxDepegBps` below its
///           NAV on the Curve pool, by the pool's EMA price. Catches a run, where the market price
///           falls while the NAV (and so the exchange rate) does not move. The EMA only, not the
///           last trade: on a thin pool one dump moves the last price, so an attacker could switch
///           P1nch off for the cost of that dump right before pushing Pendle (60k reUSD did it on
///           the fork). Holding the EMA down takes a depeg sustained for minutes.
///        5. Max deviation: refuse if Pendle's spot is more than `maxDeviationBps` below fair
///           value. A gap that large suggests real news rather than a push.
///        6. Price: fair value 1/(1+refYield)^tau minus a discount that deepens linearly with the
///           share of the backstop already used, from `discountMinBps` to `discountMaxBps`. A trade
///           is priced at the average discount over the usage range it covers, so splitting a
///           trade into smaller ones never pays the taker more in total.
///        7. Never pay more SY than the strategy holds. No per-trade cap: trades can be split,
///           so the only meaningful cap is the shipped SY.
///
///      Stateless, so the same view function serves quote() and swap().
contract P1nchQuoter is IExtruction {
    /// @notice Index of `Extruction._extruction` in the AquaOpcodes table of swap-vm v1.0.2.
    uint8 public constant EXTRUCTION_OPCODE = 0x20;
    /// @notice Byte length of the packed parameters (see `encodeParams`).
    uint256 public constant PARAMS_LENGTH = 129;
    /// @notice `flags` bit: the underlying is coins[1] of the Curve pool (default: coins[0]).
    uint8 public constant FLAG_UNDERLYING_IS_COIN1 = 1;

    uint256 private constant WAD = 1e18;
    uint256 private constant BPS = 10_000;

    /// @notice Strategy parameters, packed into the Extruction args at ship time (immutable per strategy).
    /// @param pt              PT token (tokenIn)
    /// @param sy              SY token (tokenOut)
    /// @param market          Pendle market of this PT: expiry and current implied rate
    /// @param curvePool       Curve StableSwap-NG pool pricing the underlying against USD, NAV-adjusted;
    ///                        address(0) disables the depeg stop (only for markets without a feed)
    /// @param refYieldWad     Reference implied APY for fair value, e.g. 0.10583e18
    /// @param discountMinBps  Discount below fair when the backstop is untouched, e.g. 10
    /// @param discountMaxBps  Discount when the backstop is fully used, e.g. 60
    /// @param shippedSy       SY shipped to Aqua for this strategy (to measure usage)
    /// @param minSyRate       Floor for SY.exchangeRate(), just below the rate at ship time
    /// @param maxDepegBps     Largest accepted discount of the underlying's market price to its NAV, e.g. 100
    /// @param maxDeviationBps Largest accepted gap of Pendle spot below fair, e.g. 450
    /// @param flags           FLAG_UNDERLYING_IS_COIN1 if the underlying is coins[1] in `curvePool`
    struct Params {
        address pt;
        address sy;
        address market;
        address curvePool;
        uint64 refYieldWad;
        uint16 discountMinBps;
        uint16 discountMaxBps;
        uint128 shippedSy;
        uint128 minSyRate;
        uint16 maxDepegBps;
        uint16 maxDeviationBps;
        uint8 flags;
    }

    error BadParamsLength(uint256 length);
    error BadParams();
    error OnlyPtToSy(address tokenIn, address tokenOut);
    error MarketExpired(uint256 expiry);
    error SyBelowFloor(uint256 rate, uint256 minRate);
    error UnderlyingDepegged(uint256 marketToNavWad, uint256 minWad);
    error SpotTooFarBelowFair(uint256 spotWad, uint256 fairWad);
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

        (uint256 fair,, uint256 syRate) = checkMarket(p);

        updatedSwap = swap;
        if (query.isExactIn) {
            updatedSwap.amountOut = syOutForPtIn(p, fair, syRate, swap.balanceOut, swap.amountIn);
        } else {
            updatedSwap.amountIn = ptInForSyOut(p, fair, syRate, swap.balanceOut, swap.amountOut);
        }
        require(updatedSwap.amountOut <= swap.balanceOut, InsufficientLiquidity(updatedSwap.amountOut, swap.balanceOut));

        return (nextPC, 0, updatedSwap);
    }

    /// @notice Runs rules 2 to 5 and returns the inputs to pricing.
    /// @return fairWad Fair PT price in asset terms (USD per PT, wad)
    /// @return spotWad Pendle's current PT price in asset terms (wad)
    /// @return syRate  SY.exchangeRate() used for conversions
    function checkMarket(Params memory p) public view returns (uint256 fairWad, uint256 spotWad, uint256 syRate) {
        uint256 expiry = IPMarketLike(p.market).expiry();
        // A validator can shift the timestamp by seconds; irrelevant against a maturity date.
        // forge-lint: disable-next-line(block-timestamp)
        require(block.timestamp < expiry, MarketExpired(expiry));
        uint256 secondsLeft = expiry - block.timestamp;

        syRate = IStandardizedYieldLike(p.sy).exchangeRate();
        require(syRate >= p.minSyRate, SyBelowFloor(syRate, p.minSyRate));

        if (p.curvePool != address(0)) {
            uint256 ratio = marketToNav(p);
            uint256 minRatio = (BPS - p.maxDepegBps) * WAD / BPS;
            require(ratio >= minRatio, UnderlyingDepegged(ratio, minRatio));
        }

        fairWad = P1nchMath.ptPriceFromYield(p.refYieldWad, secondsLeft);
        // Only the implied rate is needed from the market's storage tuple.
        // forge-lint: disable-next-line(unused-return)
        (,, uint96 lastLnImpliedRate,,,) = IPMarketLike(p.market)._storage();
        spotWad = P1nchMath.ptPriceFromLnRate(lastLnImpliedRate, secondsLeft);
        require(spotWad * BPS >= fairWad * (BPS - p.maxDeviationBps), SpotTooFarBelowFair(spotWad, fairWad));
    }

    /// @notice The underlying's market price divided by its NAV (wad), from the pool's EMA price.
    function marketToNav(Params memory p) public view returns (uint256) {
        uint256 ema = ICurveStableSwapNGLike(p.curvePool).price_oracle(0);
        // coins[1] underlying: the price is the underlying in USD-coin units (lower = cheaper).
        // coins[0] underlying: the price is the USD coin in underlying units (higher = cheaper).
        return p.flags & FLAG_UNDERLYING_IS_COIN1 != 0 ? ema : WAD * WAD / ema;
    }

    /// @notice Current marginal bid (USD per PT, wad) given the SY still in the strategy.
    function marginalBid(Params memory p, uint256 fairWad, uint256 balanceOut) public pure returns (uint256) {
        return fairWad * _discountFactor(p, _used(p, balanceOut)) / WAD;
    }

    /// @notice SY paid for `ptIn` PT, priced at the average discount over the usage range covered.
    /// @dev Solves y = A * (1 - dMin - k * (u0 + y / 2)) with A the SY value at zero discount,
    ///      u0 the SY already used and k the discount slope per SY: y = A * f(u0) / (1 + A * k / 2).
    ///      Rounded down (maker-favoring).
    function syOutForPtIn(Params memory p, uint256 fairWad, uint256 syRate, uint256 balanceOut, uint256 ptIn)
        public
        pure
        returns (uint256)
    {
        uint256 a = P1nchMath.ptToSyDown(ptIn, fairWad, syRate);
        uint256 spanWad = uint256(p.discountMaxBps - p.discountMinBps) * WAD / BPS;
        uint256 den = WAD + FPM.mulDivUp(spanWad, a, 2 * uint256(p.shippedSy));
        return FPM.fullMulDiv(a, _discountFactor(p, _used(p, balanceOut)), den);
    }

    /// @notice PT needed to receive `syOut` SY, priced at the discount at the middle of the usage
    ///         range the trade covers. Rounded up (maker-favoring).
    function ptInForSyOut(Params memory p, uint256 fairWad, uint256 syRate, uint256 balanceOut, uint256 syOut)
        public
        pure
        returns (uint256)
    {
        uint256 mid = _used(p, balanceOut) + (syOut + 1) / 2;
        uint256 bid = fairWad * _discountFactor(p, mid) / WAD;
        return P1nchMath.syToPtUp(syOut, bid, syRate);
    }

    /// @notice The SwapVM program for a P1nch strategy: one Extruction instruction calling this contract.
    /// @dev Layout: [opcode 1 byte][args length 1 byte][this contract 20 bytes][params 129 bytes].
    function program(Params memory p) external view returns (bytes memory) {
        bytes memory params = encodeParams(p);
        // Safe: params are always PARAMS_LENGTH (129) bytes, so the length is 149.
        // forge-lint: disable-next-line(unsafe-typecast)
        return abi.encodePacked(EXTRUCTION_OPCODE, uint8(20 + params.length), address(this), params);
    }

    /// @notice Pack parameters into 129 bytes (an instruction's args are limited to 255 bytes).
    function encodeParams(Params memory p) public pure returns (bytes memory) {
        return abi.encodePacked(
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
            p.flags
        );
    }

    function decodeParams(bytes calldata args) public pure returns (Params memory p) {
        require(args.length == PARAMS_LENGTH, BadParamsLength(args.length));
        p.pt = address(bytes20(args[0:20]));
        p.sy = address(bytes20(args[20:40]));
        p.market = address(bytes20(args[40:60]));
        p.curvePool = address(bytes20(args[60:80]));
        p.refYieldWad = uint64(bytes8(args[80:88]));
        p.discountMinBps = uint16(bytes2(args[88:90]));
        p.discountMaxBps = uint16(bytes2(args[90:92]));
        p.shippedSy = uint128(bytes16(args[92:108]));
        p.minSyRate = uint128(bytes16(args[108:124]));
        p.maxDepegBps = uint16(bytes2(args[124:126]));
        p.maxDeviationBps = uint16(bytes2(args[126:128]));
        p.flags = uint8(args[128]);
        require(
            p.discountMinBps <= p.discountMaxBps && p.discountMaxBps < BPS && p.shippedSy > 0
                && p.maxDepegBps < BPS && p.maxDeviationBps < BPS,
            BadParams()
        );
    }

    /// @dev SY already paid out by this strategy, capped at the shipped amount.
    function _used(Params memory p, uint256 balanceOut) private pure returns (uint256) {
        return balanceOut >= p.shippedSy ? 0 : p.shippedSy - balanceOut;
    }

    /// @dev 1 - discount(used), in wad. The discount term rounds up (maker-favoring).
    function _discountFactor(Params memory p, uint256 used) private pure returns (uint256) {
        if (used > p.shippedSy) used = p.shippedSy;
        uint256 minWad = uint256(p.discountMinBps) * WAD / BPS;
        uint256 spanWad = uint256(p.discountMaxBps - p.discountMinBps) * WAD / BPS;
        return WAD - minWad - FPM.mulDivUp(spanWad, used, p.shippedSy);
    }
}

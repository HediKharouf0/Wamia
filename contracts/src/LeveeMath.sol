// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { FixedPointMathLib as FPM } from "solady/utils/FixedPointMathLib.sol";

/// @title LeveeMath
/// @notice Pricing math for Levee: PT fair value from a reference yield, the maker discount,
///         and conversions between PT and SY amounts.
/// @dev Units:
///      - Yields and prices are 1e18 fixed point ("wad"). A PT price is in underlying asset per PT
///        and reaches 1.0 at maturity (1 PT redeems for 1 unit of asset).
///      - The SY exchange rate follows Pendle's SYBase convention: assetAmount = syAmount * rate / 1e18,
///        each amount in its own token's raw units. For SY-reUSD (SY 18dp, asset 6dp) the rate is
///        ~1.0968e6, which is why it looked "1e6-scaled" on the fork.
///      - PT has the asset's decimals, so raw PT units are raw asset units at maturity.
///      - Every rounding choice favors the maker (the LP): SY out rounds down, PT in rounds up,
///        and the price itself rounds down.
library LeveeMath {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant ONE_YEAR = 365 days;

    error DiscountTooHigh(uint256 discountBps);
    error ZeroPrice();

    /// @notice ln(1 + y), the form Pendle stores as `lnImpliedRate`.
    function lnImpliedRate(uint256 yieldWad) internal pure returns (uint256) {
        // Safe: yieldWad is a uint64 in practice, so WAD + yieldWad fits int256, and ln(x >= 1) >= 0.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint256(FPM.lnWad(int256(WAD + yieldWad)));
    }

    /// @notice PT price in asset terms: exp(-lnRate * t / 1 year), i.e. 1 / (1 + y)^tau.
    /// @dev The exponent rounds up so the price rounds down.
    function ptPriceFromLnRate(uint256 lnRateWad, uint256 secondsToExpiry) internal pure returns (uint256) {
        if (secondsToExpiry == 0) return WAD;
        uint256 exponent = FPM.mulDivUp(lnRateWad, secondsToExpiry, ONE_YEAR);
        // Safe: exponent = ln(1+y) * t / year is far below 2^255, and exp(-x) is always >= 0.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint256(FPM.expWad(-int256(exponent)));
    }

    /// @notice PT price in asset terms from an annual implied yield: 1 / (1 + y)^tau.
    function ptPriceFromYield(uint256 yieldWad, uint256 secondsToExpiry) internal pure returns (uint256) {
        return ptPriceFromLnRate(lnImpliedRate(yieldWad), secondsToExpiry);
    }

    /// @notice price * (1 - discount), rounded down.
    function applyDiscount(uint256 priceWad, uint256 discountBps) internal pure returns (uint256) {
        require(discountBps < BPS, DiscountTooHigh(discountBps));
        return priceWad * (BPS - discountBps) / BPS;
    }

    /// @notice SY paid for `ptAmount` PT at `priceWad` (asset per PT), rounded down.
    function ptToSyDown(uint256 ptAmount, uint256 priceWad, uint256 syRate) internal pure returns (uint256) {
        return FPM.fullMulDiv(ptAmount, priceWad, syRate);
    }

    /// @notice PT needed to receive `syAmount` SY at `priceWad` (asset per PT), rounded up.
    function syToPtUp(uint256 syAmount, uint256 priceWad, uint256 syRate) internal pure returns (uint256) {
        require(priceWad > 0, ZeroPrice());
        return FPM.fullMulDivUp(syAmount, syRate, priceWad);
    }
}

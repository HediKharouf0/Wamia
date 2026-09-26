// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { WamiaMath } from "../src/WamiaMath.sol";

/// Reference prices are 1 / (1 + y)^tau computed with 60-digit decimals, the same formula as
/// src/pricing/fairValue.ts (ptPriceFromYield). Tolerance is 1e-12 relative.
contract WamiaMathTest is Test {
    uint256 constant YEAR = 365 days;
    uint256 constant DAY = 1 days;
    // Fork block 25829822 (ts 1787632115) to PT-reUSD expiry 2026-12-10 (1796860800)
    uint256 constant SECS_AT_FORK = 1796860800 - 1787632115;
    uint256 constant REL_TOL = 1e6; // 1e-12 relative, in wad

    function _check(uint256 yieldWad, uint256 secs, uint256 expected) internal pure {
        assertApproxEqRel(WamiaMath.ptPriceFromYield(yieldWad, secs), expected, REL_TOL);
    }

    function test_PriceMatchesReference() public pure {
        _check(0.10583e18, SECS_AT_FORK, 970990654522581086); // fork state; oracle read 0.970991
        _check(0.11e18, 107 * DAY, 969870026296150175);
        _check(0.20e18, 107 * DAY, 947955527969634774);
        _check(0.22e18, 107 * DAY, 943373248094574814);
        _check(0.05e18, YEAR, 952380952380952380); // exactly 1 / 1.05
        _check(0.15e18, DAY, 999617163869295308);
        _check(1e18, 2 * YEAR, 0.25e18); // 1 / 2^2
        _check(0.10583e18, 1, 999999996810115928);
    }

    /// Same checks as src/pricing/fairValue.test.ts (tau = 107/365).
    function test_PriceMatchesTsTests() public pure {
        assertApproxEqAbs(WamiaMath.ptPriceFromYield(0.11e18, 107 * DAY), 0.9699e18, 0.001e18);
        assertApproxEqAbs(WamiaMath.ptPriceFromYield(0.20e18, 107 * DAY), 0.9480e18, 0.001e18);
        assertApproxEqAbs(WamiaMath.ptPriceFromYield(0.22e18, 107 * DAY), 0.9434e18, 0.001e18);
    }

    function test_PriceIsOneAtMaturityAndWithZeroYield() public pure {
        assertEq(WamiaMath.ptPriceFromYield(0.10583e18, 0), 1e18);
        assertEq(WamiaMath.ptPriceFromYield(0, 100 * DAY), 1e18);
    }

    function test_PriceNeverAboveReference() public pure {
        // Rounding must never push the bid above the exact fair value.
        assertLe(WamiaMath.ptPriceFromYield(0.05e18, YEAR), 952380952380952381);
        assertLe(WamiaMath.ptPriceFromYield(1e18, 2 * YEAR), 0.25e18);
    }

    function testFuzz_PriceDecreasesWithTimeAndYield(uint64 yieldWad, uint32 secs) public pure {
        yieldWad = uint64(bound(yieldWad, 0.001e18, 5e18));
        secs = uint32(bound(secs, 1, 5 * YEAR));
        uint256 p = WamiaMath.ptPriceFromYield(yieldWad, secs);
        assertLe(p, 1e18);
        assertLe(WamiaMath.ptPriceFromYield(yieldWad, uint256(secs) + DAY), p);
        assertLe(WamiaMath.ptPriceFromYield(uint256(yieldWad) + 0.01e18, secs), p);
    }

    function test_Discount() public pure {
        assertEq(WamiaMath.applyDiscount(1e18, 10), 0.999e18);
        assertEq(WamiaMath.applyDiscount(0.97e18, 0), 0.97e18);
        assertEq(WamiaMath.applyDiscount(3, 5000), 1); // rounds down
    }

    function test_RevertWhen_DiscountIsWholePrice() public {
        vm.expectRevert(abi.encodeWithSelector(WamiaMath.DiscountTooHigh.selector, 10_000));
        this.discount(1e18, 10_000);
    }

    function discount(uint256 p, uint256 bps) external pure returns (uint256) {
        return WamiaMath.applyDiscount(p, bps);
    }

    /// 1M PT (6dp) at 0.97 asset/PT, SY rate 1.0968e6 (SY 18dp, asset 6dp):
    /// 1,000,000 * 0.97 / 1.0968 = 884,390.955506929248723559 SY
    function test_PtToSyUsesPendleRateConvention() public pure {
        uint256 syOut = WamiaMath.ptToSyDown(1_000_000e6, 0.97e18, 1.0968e6);
        assertEq(syOut, 884390955506929248723559);
    }

    function test_SyToPtRoundsUpAndCoversRequest() public pure {
        uint256 price = 0.97e18;
        uint256 rate = 1.0968e6;
        uint256 syWanted = 884390955506929248723559;
        uint256 ptIn = WamiaMath.syToPtUp(syWanted, price, rate);
        assertEq(ptIn, 1_000_000e6);
        assertGe(WamiaMath.ptToSyDown(ptIn, price, rate), syWanted);
    }

    function testFuzz_RoundTripFavorsMaker(uint128 ptIn, uint64 price, uint64 rate) public pure {
        vm.assume(ptIn > 0);
        uint256 p = bound(price, 0.5e18, 1e18);
        uint256 r = bound(rate, 0.5e6, 2e6);
        uint256 syOut = WamiaMath.ptToSyDown(ptIn, p, r);
        // Buying back the same SY never costs the taker less PT than they sold.
        if (syOut > 0) assertLe(WamiaMath.syToPtUp(syOut, p, r), ptIn);
        // And asking for exact SY never gives more SY than the PT paid is worth.
        uint256 ptNeeded = WamiaMath.syToPtUp(syOut, p, r);
        assertGe(WamiaMath.ptToSyDown(ptNeeded, p, r), syOut);
    }
}

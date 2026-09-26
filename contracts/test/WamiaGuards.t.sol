// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { AquaSwapVMRouter } from "@1inch/swap-vm/src/routers/AquaSwapVMRouter.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { SwapQuery, SwapRegisters } from "@1inch/swap-vm/src/libs/VM.sol";

import { WamiaQuoter } from "../src/WamiaQuoter.sol";
import { WamiaOrders } from "../src/WamiaOrders.sol";
import { WamiaSpendLimit } from "../src/WamiaSpendLimit.sol";
import { WamiaRateGuard } from "../src/WamiaRateGuard.sol";
import { MockToken, MockSY, MockPendleMarket, MockCurvePool } from "./mocks/Mocks.sol";
import { WamiaTestParams } from "./utils/WamiaTestParams.sol";

/// The v2 rules as Extruction steps. Unit tests call each guard the way the router does; the end-to-end
/// tests ship the three-step program [RateGuard][Quoter][SpendLimit] to Aqua and trade through the
/// official AquaSwapVMRouter.
contract WamiaGuardsTest is Test {
    uint256 constant FORK_TS = 1787632115;
    uint256 constant EXPIRY = 1796860800;
    uint256 constant SHIPPED = 500_000e18;
    bytes32 constant ORDER = bytes32(uint256(1));

    Aqua aqua;
    AquaSwapVMRouter router;
    WamiaQuoter quoter;
    WamiaSpendLimit spendLimit;
    WamiaRateGuard rateGuard;
    MockToken pt;
    MockSY sy;
    MockPendleMarket market;
    MockCurvePool curve;

    address lp = makeAddr("lp");
    address taker = makeAddr("taker");

    function setUp() public {
        vm.warp(FORK_TS);
        aqua = new Aqua();
        router = new AquaSwapVMRouter(address(aqua), makeAddr("weth"), address(this), "AquaSwapVMRouter", "1.0.2");
        quoter = new WamiaQuoter();
        spendLimit = new WamiaSpendLimit(address(router));
        rateGuard = new WamiaRateGuard(address(router));
        pt = new MockToken("PT", 6);
        sy = new MockSY(1.0968e6);
        market = new MockPendleMarket(EXPIRY, address(sy), address(pt));
        curve = new MockCurvePool();

        sy.mint(lp, 1_000_000e18);
        vm.prank(lp);
        sy.approve(address(aqua), type(uint256).max);
        pt.mint(taker, 1_000_000e6);
        vm.prank(taker);
        pt.approve(address(router), type(uint256).max);
    }

    // ---------------------------------------------------------------- params

    /// 20% of the shipped SY per 12 s window; the cap starts growing 30 days before maturity.
    function _spend() internal pure returns (WamiaSpendLimit.Params memory p) {
        p = WamiaSpendLimit.Params({ shippedSy: uint128(SHIPPED), windowSec: 12, minCapBps: 2000, horizonSec: 30 days, expiry: uint64(EXPIRY) });
    }

    function _rate() internal view returns (WamiaRateGuard.Params memory p) {
        p = WamiaRateGuard.Params({
            sy: address(sy),
            rateAtShip: 1.0968e6,
            shipTimestamp: uint64(FORK_TS),
            maxDropBps: 0,
            minElapsed: 3 days,
            refYieldWad: 0.10583e18,
            maxYieldGapBps: 1000
        });
    }

    function _query() internal pure returns (SwapQuery memory) {
        return SwapQuery({ orderHash: ORDER, maker: address(0xA11CE), taker: address(0xB0B), tokenIn: address(1), tokenOut: address(2), isExactIn: true });
    }

    function _regs(uint256 amountOut) internal pure returns (SwapRegisters memory) {
        return SwapRegisters({ balanceIn: 0, balanceOut: SHIPPED, amountIn: 1e6, amountOut: amountOut, amountNetPulled: 0 });
    }

    // Arguments are built before vm.prank / vm.expectRevert, which apply to the next external call.
    function _spendCall(uint256 amountOut) internal {
        bytes memory args = spendLimit.encodeParams(_spend());
        vm.prank(address(router));
        spendLimit.extruction(false, 0, _query(), _regs(amountOut), args, "");
    }

    function _rateCall() internal {
        bytes memory args = rateGuard.encodeParams(_rate());
        vm.prank(address(router));
        rateGuard.extruction(false, 0, _query(), _regs(0), args, "");
    }

    // ---------------------------------------------------------------- spend limit

    function test_SpendLimitCapsEachWindow() public {
        assertEq(spendLimit.capOf(_spend()), 100_000e18, "20% of 500k far from maturity");
        _spendCall(60_000e18);
        _spendCall(40_000e18); // exactly the cap
        bytes memory args = spendLimit.encodeParams(_spend());
        vm.prank(address(router));
        vm.expectRevert(abi.encodeWithSelector(WamiaSpendLimit.SpendLimitExceeded.selector, 100_000e18 + 1, 100_000e18));
        spendLimit.extruction(false, 0, _query(), _regs(1), args, "");

        vm.warp(block.timestamp + 12); // next block: a fresh window
        _spendCall(100_000e18);
    }

    function test_SpendLimitGrowsNearMaturity() public {
        vm.warp(EXPIRY - 15 days); // halfway through the 30-day horizon
        assertEq(spendLimit.capBps(_spend()), 6000);
        vm.warp(EXPIRY);
        assertEq(spendLimit.capBps(_spend()), 10_000);
    }

    function test_SpendLimitQuoteDoesNotConsumeBudget() public {
        bytes memory args = spendLimit.encodeParams(_spend());
        spendLimit.extruction(true, 0, _query(), _regs(100_000e18), args, ""); // static: anyone, no write
        spendLimit.extruction(true, 0, _query(), _regs(100_000e18), args, "");
        _spendCall(100_000e18); // the whole budget is still there
    }

    function test_SpendLimitOnlyRouterRecords() public {
        bytes memory args = spendLimit.encodeParams(_spend());
        vm.expectRevert(abi.encodeWithSelector(WamiaSpendLimit.NotRouter.selector, address(this)));
        spendLimit.extruction(false, 0, _query(), _regs(1e18), args, "");
    }

    function test_SpendLimitMustRunAfterPricing() public {
        bytes memory args = spendLimit.encodeParams(_spend());
        vm.expectRevert(WamiaSpendLimit.NotPricedYet.selector);
        spendLimit.extruction(true, 0, _query(), _regs(0), args, "");
    }

    function test_SpendLimitParamsRoundTrip() public view {
        WamiaSpendLimit.Params memory p = spendLimit.decodeParams(spendLimit.encodeParams(_spend()));
        assertEq(p.shippedSy, SHIPPED);
        assertEq(p.horizonSec, 30 days);
        assertEq(p.expiry, EXPIRY);
        assertEq(spendLimit.program(_spend()).length, 2 + 20 + 34);
    }

    // ---------------------------------------------------------------- rate guard

    function test_RateGuardRefusesAnyDropBelowHighWaterMark() public {
        sy.setExchangeRate(1.0975e6);
        _rateCall(); // records 1.0975
        assertEq(rateGuard.highWaterMark(ORDER), 1.0975e6);
        sy.setExchangeRate(1.0974e6); // still above the ship rate, but below the mark
        bytes memory args = rateGuard.encodeParams(_rate());
        vm.prank(address(router));
        vm.expectRevert(abi.encodeWithSelector(WamiaRateGuard.RateBelowHighWaterMark.selector, 1.0974e6, 1.0975e6));
        rateGuard.extruction(false, 0, _query(), _regs(0), args, "");
    }

    function test_RateGuardQuoteDoesNotMoveTheMark() public {
        sy.setExchangeRate(1.0975e6);
        bytes memory args = rateGuard.encodeParams(_rate());
        rateGuard.extruction(true, 0, _query(), _regs(0), args, "");
        assertEq(rateGuard.highWaterMark(ORDER), 0);
        vm.expectRevert(abi.encodeWithSelector(WamiaRateGuard.NotRouter.selector, address(this)));
        rateGuard.extruction(false, 0, _query(), _regs(0), args, "");
    }

    function test_RateGuardRefusesUnderlyingYieldFarAboveReference() public {
        vm.warp(FORK_TS + 30 days);
        sy.setExchangeRate(1.1171e6); // ~25% a year over 30 days: above 10.58% + 10 points
        bytes memory args = rateGuard.encodeParams(_rate());
        vm.prank(address(router));
        vm.expectPartialRevert(WamiaRateGuard.UnderlyingYieldAboveReference.selector);
        rateGuard.extruction(false, 0, _query(), _regs(0), args, "");

        sy.setExchangeRate(1.1062e6); // ~11% a year: fine
        _rateCall();
        assertApproxEqAbs(rateGuard.realizedApy(_rate(), 1.1062e6), 0.11e18, 0.005e18);
    }

    function test_RateGuardYieldCheckWaitsForMinElapsed() public {
        vm.warp(FORK_TS + 1 days);
        sy.setExchangeRate(1.0975e6); // a jump that annualizes to a huge yield over one day
        _rateCall(); // not checked yet: minElapsed is 3 days
    }

    function test_RateGuardParamsRoundTrip() public view {
        WamiaRateGuard.Params memory p = rateGuard.decodeParams(rateGuard.encodeParams(_rate()));
        assertEq(p.sy, address(sy));
        assertEq(p.rateAtShip, 1.0968e6);
        assertEq(p.maxYieldGapBps, 1000);
        assertEq(rateGuard.program(_rate()).length, 2 + 20 + 60);
    }

    // ---------------------------------------------------------------- end to end: [RateGuard][Quoter][SpendLimit]

    function guardedProgram() external view returns (bytes memory) {
        WamiaQuoter.Params memory q = WamiaTestParams.defaults(address(pt), address(sy), address(market), address(curve), SHIPPED, 1.09e6);
        return bytes.concat(rateGuard.program(_rate()), quoter.program(q), spendLimit.program(_spend()));
    }

    function _shipGuarded() internal returns (ISwapVM.Order memory order) {
        order = WamiaOrders.makerOrder(lp, this.guardedProgram());
        address[] memory tokens = new address[](2);
        tokens[0] = address(sy);
        tokens[1] = address(pt);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = SHIPPED;
        vm.prank(lp);
        aqua.ship(address(router), abi.encode(order), tokens, amounts);
    }

    function _sell(ISwapVM.Order memory order, uint256 ptIn) internal returns (uint256 syOut) {
        bytes memory td = WamiaOrders.takerData(taker, true, 0, true, false, "");
        vm.prank(taker);
        (, syOut,) = router.swap(order, address(pt), address(sy), ptIn, td);
    }

    function test_GuardedStrategyTradesAndHoldsTheSpendLimit() public {
        ISwapVM.Order memory order = _shipGuarded();
        bytes memory td = WamiaOrders.takerData(taker, true, 0, true, false, "");
        (, uint256 quoted,) = router.quote(order, address(pt), address(sy), 100_000e6, td);

        uint256 syOut = _sell(order, 100_000e6);
        assertEq(syOut, quoted, "the guards do not change the price");
        assertApproxEqRel(syOut, 88_402e18, 0.0001e18, "same as the unguarded strategy");
        assertEq(pt.balanceOf(lp), 100_000e6);

        // ~88.4k of the 100k window budget is used: another 20k PT (~17.7k SY) in the same block is refused.
        vm.expectPartialRevert(WamiaSpendLimit.SpendLimitExceeded.selector);
        _sell(order, 20_000e6);

        vm.warp(block.timestamp + 12);
        assertGt(_sell(order, 20_000e6), 0, "next block, fresh budget");
    }

    function test_GuardedStrategyRefusesAfterARateDrop() public {
        ISwapVM.Order memory order = _shipGuarded();
        sy.setExchangeRate(1.0975e6);
        _sell(order, 1_000e6); // a trade records the high-water mark
        vm.warp(block.timestamp + 12);
        sy.setExchangeRate(1.0974e6); // tiny drop, still far above WamiaQuoter's 1.09 floor
        vm.expectPartialRevert(WamiaRateGuard.RateBelowHighWaterMark.selector);
        _sell(order, 1_000e6);
    }
}

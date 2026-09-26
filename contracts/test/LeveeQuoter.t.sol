// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { SwapQuery, SwapRegisters } from "@1inch/swap-vm/src/libs/VM.sol";

import { LeveeQuoter } from "../src/LeveeQuoter.sol";
import { LeveeMath } from "../src/LeveeMath.sol";
import { MockToken, MockSY, MockPendleMarket, MockCurvePool } from "./mocks/Mocks.sol";

/// Unit tests: the quoter is called directly, the way SwapVM's Extruction calls it.
/// Numbers mirror the fork: ts 1787632115, expiry 2026-12-10, SY rate 1.0968e6.
contract LeveeQuoterTest is Test {
    uint256 constant FORK_TS = 1787632115;
    uint256 constant EXPIRY = 1796860800;
    uint256 constant SHIPPED = 1_000_000e18;
    uint256 constant RATE = 1.0968e6;

    LeveeQuoter quoter;
    MockToken pt;
    MockSY sy;
    MockPendleMarket market;
    MockCurvePool curve;
    LeveeQuoter.Params params;
    bytes args; // encoded once so expectRevert targets the quoter call itself

    function setUp() public {
        vm.warp(FORK_TS);
        quoter = new LeveeQuoter();
        pt = new MockToken("PT", 6);
        sy = new MockSY(RATE);
        market = new MockPendleMarket(EXPIRY, address(sy), address(pt));
        curve = new MockCurvePool();
        params = LeveeQuoter.Params({
            pt: address(pt),
            sy: address(sy),
            market: address(market),
            curvePool: address(curve),
            refYieldWad: 0.10583e18,
            discountMinBps: 10,
            discountMaxBps: 60,
            shippedSy: uint128(SHIPPED),
            minSyRate: 1.09e6,
            maxDepegBps: 100,
            maxDeviationBps: 450,
            flags: 0
        });
        args = quoter.encodeParams(params);
    }

    function _query(address tokenIn, address tokenOut, bool exactIn) internal pure returns (SwapQuery memory) {
        return SwapQuery({
            orderHash: bytes32(uint256(1)),
            maker: address(0xA11CE),
            taker: address(0xB0B),
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            isExactIn: exactIn
        });
    }

    function _regs(uint256 amountIn, uint256 amountOut, uint256 balanceOut) internal pure returns (SwapRegisters memory) {
        return SwapRegisters({ balanceIn: 0, balanceOut: balanceOut, amountIn: amountIn, amountOut: amountOut, amountNetPulled: 0 });
    }

    function _sell(uint256 ptIn, uint256 balanceOut) internal view returns (SwapRegisters memory out) {
        (,, out) = quoter.extruction(false, 0, _query(address(pt), address(sy), true), _regs(ptIn, 0, balanceOut), args, "");
    }

    function _fair() internal view returns (uint256 fair) {
        (fair,,) = quoter.checkMarket(params);
    }

    // ---------------------------------------------------------------- pricing

    function test_SmallFirstTradeGetsMinDiscount() public view {
        uint256 fair = _fair();
        assertApproxEqRel(fair, 970990654522581086, 1e6);
        SwapRegisters memory out = _sell(1_000e6, SHIPPED);
        uint256 atMinDiscount = LeveeMath.ptToSyDown(1_000e6, fair * 9990 / 10_000, RATE);
        assertLe(out.amountOut, atMinDiscount);
        assertApproxEqRel(out.amountOut, atMinDiscount, 0.00001e18);
    }

    function test_DiscountDeepensWithUsage() public view {
        uint256 fair = _fair();
        assertEq(quoter.marginalBid(params, fair, SHIPPED), fair * 9990 / 10_000);
        assertApproxEqAbs(quoter.marginalBid(params, fair, SHIPPED / 2), fair * 9965 / 10_000, 1);
        assertApproxEqAbs(quoter.marginalBid(params, fair, 0), fair * 9940 / 10_000, 1);
    }

    function test_LaterTradesGetWorsePrices() public view {
        SwapRegisters memory first = _sell(100_000e6, SHIPPED);
        SwapRegisters memory later = _sell(100_000e6, SHIPPED / 4);
        assertLt(later.amountOut, first.amountOut);
    }

    function testFuzz_SplittingNeverPaysMore(uint64 x1, uint64 x2) public view {
        uint256 a = bound(x1, 1e6, 400_000e6);
        uint256 b = bound(x2, 1e6, 400_000e6);
        uint256 whole = _sell(a + b, SHIPPED).amountOut;
        uint256 first = _sell(a, SHIPPED).amountOut;
        uint256 second = _sell(b, SHIPPED - first).amountOut;
        assertLe(first + second, whole);
    }

    function test_ExactOutMatchesExactIn() public view {
        uint256 ptIn = 250_000e6;
        uint256 balance = SHIPPED * 3 / 4;
        uint256 syOut = _sell(ptIn, balance).amountOut;
        (,, SwapRegisters memory back) =
            quoter.extruction(false, 0, _query(address(pt), address(sy), false), _regs(0, syOut, balance), args, "");
        assertEq(back.amountOut, syOut);
        // Both directions round toward the maker, so they may differ by one PT wei.
        assertLe(back.amountIn, ptIn + 1, "exact out costs at most 1 wei more than exact in");
        assertApproxEqRel(back.amountIn, ptIn, 1e9);
    }

    function testFuzz_NeverAboveFair(uint64 ptIn, uint128 balance) public view {
        uint256 x = bound(ptIn, 1e6, 900_000e6);
        uint256 bal = bound(balance, 0, SHIPPED);
        uint256 fair = _fair();
        uint256 y = quoter.syOutForPtIn(params, fair, RATE, bal, x);
        assertLe(y, LeveeMath.ptToSyDown(x, fair, RATE));
        assertLe(quoter.marginalBid(params, fair, bal), fair);
    }

    function test_Aug25StateIsAccepted() public {
        market.setSpot(0.9472e18); // 2.45% below fair
        curve.set(1.0000312e18, 1.0000312e18); // reUSD at 0.99997 of NAV on the fork block
        (uint256 fair, uint256 spot,) = quoter.checkMarket(params);
        assertApproxEqRel(spot, 0.9472e18, 1e12);
        assertGt(fair, spot);
        assertApproxEqRel(quoter.marketToNav(params), 0.99997e18, 1e13);
    }

    // ---------------------------------------------------------------- refusals

    function test_RevertWhen_SyToPt() public {
        vm.expectRevert(abi.encodeWithSelector(LeveeQuoter.OnlyPtToSy.selector, address(sy), address(pt)));
        quoter.extruction(false, 0, _query(address(sy), address(pt), true), _regs(1e18, 0, SHIPPED), args, "");
    }

    function test_RevertWhen_Expired() public {
        vm.warp(EXPIRY);
        vm.expectRevert(abi.encodeWithSelector(LeveeQuoter.MarketExpired.selector, EXPIRY));
        quoter.extruction(false, 0, _query(address(pt), address(sy), true), _regs(1e6, 0, SHIPPED), args, "");
    }

    function test_RevertWhen_SyRateDrops() public {
        sy.setExchangeRate(1.05e6);
        vm.expectRevert(abi.encodeWithSelector(LeveeQuoter.SyBelowFloor.selector, 1.05e6, 1.09e6));
        quoter.extruction(false, 0, _query(address(pt), address(sy), true), _regs(1e6, 0, SHIPPED), args, "");
    }

    /// A run: reUSD trades 2% below NAV on Curve while the exchange rate does not move.
    function test_RevertWhen_MarketDepegOnEma() public {
        curve.set(1.02e18, 1.0e18);
        vm.expectPartialRevert(LeveeQuoter.UnderlyingDepegged.selector);
        quoter.extruction(false, 0, _query(address(pt), address(sy), true), _regs(1e6, 0, SHIPPED), args, "");
    }

    /// One dump on a thin pool moves the last price but not the EMA: that must not switch Levee off.
    function test_LastPriceAloneDoesNotStopLevee() public {
        curve.set(1.0e18, 1.02e18); // last trade 2% below NAV, EMA still at NAV
        assertEq(quoter.marketToNav(params), 1e18);
        assertGt(_sell(1e6, SHIPPED).amountOut, 0);
    }

    function test_DepegCheckWhenUnderlyingIsCoin1() public {
        params.flags = 1; // prices now quote the underlying itself in USD-coin units
        args = quoter.encodeParams(params);
        curve.set(0.995e18, 0.995e18);
        _sell(1e6, SHIPPED); // 0.5% below NAV: accepted
        curve.set(0.98e18, 1e18);
        vm.expectPartialRevert(LeveeQuoter.UnderlyingDepegged.selector);
        quoter.extruction(false, 0, _query(address(pt), address(sy), true), _regs(1e6, 0, SHIPPED), args, "");
    }

    function test_NoCurvePoolSkipsDepegCheck() public {
        params.curvePool = address(0);
        args = quoter.encodeParams(params);
        curve.set(2e18, 2e18); // would be a 50% depeg, but the pool is not configured
        assertGt(_sell(1e6, SHIPPED).amountOut, 0);
    }

    function test_RevertWhen_SpotFarBelowFair() public {
        market.setSpot(0.92e18); // ~5.3% below fair: looks like real news, not a push
        vm.expectPartialRevert(LeveeQuoter.SpotTooFarBelowFair.selector);
        quoter.extruction(false, 0, _query(address(pt), address(sy), true), _regs(1e6, 0, SHIPPED), args, "");
    }

    function test_RevertWhen_NotEnoughShippedSy() public {
        uint256 need = _sell(100_000e6, SHIPPED).amountOut;
        uint256 have = need / 2; // the strategy is mostly used, so the price is worse too
        uint256 wouldPay = quoter.syOutForPtIn(params, _fair(), RATE, have, 100_000e6);
        vm.expectRevert(abi.encodeWithSelector(LeveeQuoter.InsufficientLiquidity.selector, wouldPay, have));
        quoter.extruction(false, 0, _query(address(pt), address(sy), true), _regs(100_000e6, 0, have), args, "");
    }

    function test_RevertWhen_ParamsHaveWrongLength() public {
        vm.expectRevert(abi.encodeWithSelector(LeveeQuoter.BadParamsLength.selector, 128));
        quoter.extruction(false, 0, _query(address(pt), address(sy), true), _regs(1e6, 0, SHIPPED), new bytes(128), "");
    }

    function test_RevertWhen_ParamsInconsistent() public {
        params.discountMinBps = 70; // above the max
        bytes memory bad = quoter.encodeParams(params);
        vm.expectRevert(LeveeQuoter.BadParams.selector);
        quoter.decodeParams(bad);
    }

    // ---------------------------------------------------------------- encoding

    function test_TakerDataIsIgnored() public view {
        SwapQuery memory q = _query(address(pt), address(sy), true);
        SwapRegisters memory r = _regs(100_000e6, 0, SHIPPED);
        (,, SwapRegisters memory a) = quoter.extruction(false, 0, q, r, args, "");
        (,, SwapRegisters memory b) = quoter.extruction(true, 0, q, r, args, hex"deadbeef");
        assertEq(a.amountOut, b.amountOut);
    }

    function test_ProgramCounterAndBalancesUntouched() public view {
        (uint256 pc, uint256 chopped, SwapRegisters memory out) =
            quoter.extruction(false, 124, _query(address(pt), address(sy), true), _regs(1e6, 0, SHIPPED), args, "");
        assertEq(pc, 124);
        assertEq(chopped, 0);
        assertEq(out.balanceOut, SHIPPED);
        assertEq(out.amountIn, 1e6);
    }

    function test_ParamsRoundTrip() public view {
        bytes memory encoded = quoter.encodeParams(params);
        assertEq(encoded.length, quoter.PARAMS_LENGTH());
        LeveeQuoter.Params memory p = quoter.decodeParams(encoded);
        assertEq(keccak256(abi.encode(p)), keccak256(abi.encode(params)));
    }

    function test_ProgramLayout() public view {
        bytes memory prog = quoter.program(params);
        assertEq(prog.length, 2 + 20 + 129);
        assertEq(uint8(prog[0]), 0x20, "Extruction opcode in swap-vm v1.0.2");
        assertEq(uint8(prog[1]), 149, "args length");
        address target;
        assembly {
            target := shr(96, mload(add(prog, 34)))
        }
        assertEq(target, address(quoter));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { AquaSwapVMRouter } from "@1inch/swap-vm/src/routers/AquaSwapVMRouter.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/src/libs/TakerTraits.sol";

import { P1nchQuoter } from "../src/P1nchQuoter.sol";
import { P1nchOrders } from "../src/P1nchOrders.sol";
import { MockToken, MockSY, MockPendleMarket, MockCurvePool } from "./mocks/Mocks.sol";
import { P1nchTestParams } from "./utils/P1nchTestParams.sol";

/// End to end on the official sources: Aqua v1.0.0 and AquaSwapVMRouter v1.0.2 compiled from
/// their release tags, with mock Pendle tokens. Ship -> quote -> swap with real token movement.
/// The fork test repeats this against the deployed contracts and real PT/SY.
contract P1nchAquaLocalTest is Test {
    uint256 constant FORK_TS = 1787632115;
    uint256 constant EXPIRY = 1796860800;

    Aqua aqua;
    AquaSwapVMRouter router;
    P1nchQuoter quoter;
    MockToken pt;
    MockSY sy;
    MockPendleMarket market;
    MockCurvePool curve;

    address lp = makeAddr("lp");
    address lp2 = makeAddr("lp2");
    address taker = makeAddr("taker");

    function setUp() public {
        vm.warp(FORK_TS);
        aqua = new Aqua();
        router = new AquaSwapVMRouter(address(aqua), makeAddr("weth"), address(this), "AquaSwapVMRouter", "1.0.2");
        quoter = new P1nchQuoter();
        pt = new MockToken("PT", 6);
        sy = new MockSY(1.0968e6);
        market = new MockPendleMarket(EXPIRY, address(sy), address(pt));
        curve = new MockCurvePool();

        sy.mint(lp, 1_000_000e18);
        sy.mint(lp2, 1_000_000e18);
        vm.prank(lp);
        sy.approve(address(aqua), type(uint256).max);
        vm.prank(lp2);
        sy.approve(address(aqua), type(uint256).max);

        pt.mint(taker, 1_000_000e6);
        vm.prank(taker);
        pt.approve(address(router), type(uint256).max);
    }

    function _params(uint256 shippedSy) internal view returns (P1nchQuoter.Params memory) {
        return P1nchTestParams.defaults(address(pt), address(sy), address(market), address(curve), shippedSy, 1.09e6);
    }

    function programFor(uint256 shippedSy) external view returns (bytes memory) {
        return quoter.program(_params(shippedSy));
    }

    function _ship(address maker, uint256 syAmount) internal returns (ISwapVM.Order memory order, bytes32 hash) {
        bytes memory prog = this.programFor(syAmount); // external self-call keeps the stack shallow
        order = P1nchOrders.makerOrder(maker, prog);
        address[] memory tokens = new address[](2);
        tokens[0] = address(sy);
        tokens[1] = address(pt);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = syAmount;
        amounts[1] = 0; // PT registered with zero balance so safeBalances accepts the pair
        vm.prank(maker);
        hash = aqua.ship(address(router), abi.encode(order), tokens, amounts);
    }

    function _sellPt(ISwapVM.Order memory order, uint256 ptIn, uint256 minSyOut) internal returns (uint256, uint256) {
        bytes memory td = P1nchOrders.takerData(taker, true, minSyOut, true, false, "");
        vm.prank(taker);
        (uint256 amountIn, uint256 amountOut,) = router.swap(order, address(pt), address(sy), ptIn, td);
        return (amountIn, amountOut);
    }

    function test_ShipQuoteSwap() public {
        (ISwapVM.Order memory order, bytes32 hash) = _ship(lp, 500_000e18);
        assertEq(hash, router.hash(order), "Aqua strategy hash is the SwapVM order hash");

        bytes memory td = P1nchOrders.takerData(taker, true, 0, true, false, "");
        (uint256 qIn, uint256 qOut,) = router.quote(order, address(pt), address(sy), 100_000e6, td);

        uint256 lpSyBefore = sy.balanceOf(lp);
        (uint256 amountIn, uint256 amountOut) = _sellPt(order, 100_000e6, qOut);

        assertEq(amountIn, qIn);
        assertEq(amountOut, qOut, "swap pays exactly the quote");
        // 100k PT at fair 0.970991, 0.10% to 0.15% discount on a 500k strategy: ~88,402 SY
        assertApproxEqRel(amountOut, 88_402e18, 0.0001e18);

        // Real token movement: SY left the LP wallet, PT arrived in it.
        assertEq(sy.balanceOf(taker), amountOut);
        assertEq(pt.balanceOf(lp), 100_000e6);
        assertEq(lpSyBefore - sy.balanceOf(lp), amountOut);

        // Aqua virtual balances track the strategy.
        (uint248 syLeft,) = aqua.rawBalances(lp, address(router), hash, address(sy));
        (uint248 ptHeld,) = aqua.rawBalances(lp, address(router), hash, address(pt));
        assertEq(syLeft, 500_000e18 - amountOut);
        assertEq(ptHeld, 100_000e6);
    }

    function test_ExactOutSwap() public {
        (ISwapVM.Order memory order,) = _ship(lp, 500_000e18);
        bytes memory td = P1nchOrders.takerData(taker, false, 0, true, false, "");
        vm.prank(taker);
        (uint256 amountIn, uint256 amountOut,) = router.swap(order, address(pt), address(sy), 50_000e18, td);
        assertEq(amountOut, 50_000e18);
        assertEq(pt.balanceOf(lp), amountIn);
        assertApproxEqRel(amountIn, 56_549e6, 0.0001e18); // 50,000 * 1.0968 / (0.970991 * (1 - 0.125%))
    }

    function test_ShippedSyIsTheSpendingCap() public {
        (ISwapVM.Order memory order,) = _ship(lp, 50_000e18);
        vm.expectPartialRevert(P1nchQuoter.InsufficientLiquidity.selector);
        _sellPt(order, 100_000e6, 0);
        // Wallet holds 1M SY, but only the shipped 50k is at risk.
        assertEq(sy.balanceOf(lp), 1_000_000e18);
    }

    function test_RefusesWhenSyDepegs() public {
        (ISwapVM.Order memory order,) = _ship(lp, 500_000e18);
        sy.setExchangeRate(1.05e6);
        vm.expectRevert(abi.encodeWithSelector(P1nchQuoter.SyBelowFloor.selector, 1.05e6, 1.09e6));
        _sellPt(order, 100_000e6, 0);
        assertEq(pt.balanceOf(taker), 1_000_000e6, "nothing moved");
    }

    function test_RefusesToSellPt() public {
        (ISwapVM.Order memory order,) = _ship(lp, 500_000e18);
        sy.mint(taker, 1_000e18);
        vm.prank(taker);
        sy.approve(address(router), type(uint256).max);
        bytes memory td = P1nchOrders.takerData(taker, true, 0, true, false, "");
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(P1nchQuoter.OnlyPtToSy.selector, address(sy), address(pt)));
        router.swap(order, address(sy), address(pt), 1_000e18, td);
    }

    function test_MinOutProtectsTaker() public {
        (ISwapVM.Order memory order,) = _ship(lp, 500_000e18);
        vm.expectPartialRevert(TakerTraitsLib.TakerTraitsInsufficientMinOutputAmount.selector);
        _sellPt(order, 100_000e6, 100_000e18);
    }

    function test_SeveralLpsSameParams() public {
        (ISwapVM.Order memory o1, bytes32 h1) = _ship(lp, 300_000e18);
        (ISwapVM.Order memory o2, bytes32 h2) = _ship(lp2, 300_000e18);
        assertTrue(h1 != h2, "one strategy per wallet: maker is part of the hash");

        (, uint256 out1) = _sellPt(o1, 100_000e6, 0);
        (, uint256 out2) = _sellPt(o2, 100_000e6, 0);
        assertEq(out1, out2, "same params, same price");
        assertEq(pt.balanceOf(lp), 100_000e6);
        assertEq(pt.balanceOf(lp2), 100_000e6);
    }

    function test_DockStopsTrading() public {
        (ISwapVM.Order memory order, bytes32 hash) = _ship(lp, 500_000e18);
        address[] memory tokens = new address[](2);
        tokens[0] = address(sy);
        tokens[1] = address(pt);
        vm.prank(lp);
        aqua.dock(address(router), hash, tokens);
        vm.expectPartialRevert(IAqua.SafeBalancesForTokenNotInActiveStrategy.selector);
        _sellPt(order, 100_000e6, 0);
    }
}

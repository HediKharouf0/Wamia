// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { AquaSwapVMRouter } from "@1inch/swap-vm/src/routers/AquaSwapVMRouter.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { LeveeQuoter } from "../src/LeveeQuoter.sol";
import { LeveeOrders } from "../src/LeveeOrders.sol";
import { LeveeArb } from "../src/LeveeArb.sol";
import { IPendleRouterV4 } from "../src/interfaces/IPendleRouterV4.sol";
import { MockToken, MockSY, MockPendleMarket, MockPendleRouter, MockCurvePool } from "./mocks/Mocks.sol";
import { LeveeTestParams } from "./utils/LeveeTestParams.sol";

/// LeveeArb on the official Aqua v1.0.0 + AquaSwapVMRouter v1.0.2 sources, with a mock Pendle
/// router at a fixed PT price. Fork version: fork/LeveeArbFork.t.sol.
contract LeveeArbTest is Test {
    uint256 constant FORK_TS = 1787632115;
    uint256 constant EXPIRY = 1796860800;
    uint256 constant PUSHED_PRICE = 0.9472e18; // Pendle spot after the 11 manipulator trades
    uint256 constant FAIR_PRICE = 0.971e18; // Pendle spot before the attack

    Aqua aqua;
    AquaSwapVMRouter router;
    LeveeQuoter quoter;
    MockToken pt;
    MockSY sy;
    MockPendleMarket market;
    MockPendleRouter pendle;
    MockCurvePool curve;
    LeveeArb arbBot;

    address lp = makeAddr("lp");
    address lp2 = makeAddr("lp2");
    address searcher = makeAddr("searcher");

    function setUp() public {
        vm.warp(FORK_TS);
        aqua = new Aqua();
        router = new AquaSwapVMRouter(address(aqua), makeAddr("weth"), address(this), "AquaSwapVMRouter", "1.0.2");
        quoter = new LeveeQuoter();
        pt = new MockToken("PT", 6);
        sy = new MockSY(1.0968e6);
        market = new MockPendleMarket(EXPIRY, address(sy), address(pt));
        pendle = new MockPendleRouter(pt, sy, PUSHED_PRICE);
        market.setSpot(PUSHED_PRICE); // the market Levee checks shows the pushed price too
        curve = new MockCurvePool();
        arbBot = new LeveeArb(ISwapVM(address(router)), IPendleRouterV4(address(pendle)), address(market), IERC20(address(pt)), IERC20(address(sy)));

        for (uint256 i = 0; i < 2; i++) {
            address who = i == 0 ? lp : lp2;
            sy.mint(who, 1_000_000e18);
            vm.prank(who);
            sy.approve(address(aqua), type(uint256).max);
        }
    }

    function _params(uint256 shippedSy) internal view returns (LeveeQuoter.Params memory) {
        return LeveeTestParams.defaults(address(pt), address(sy), address(market), address(curve), shippedSy, 1.09e6);
    }

    function _ship(address maker, uint256 syAmount) internal returns (ISwapVM.Order memory order) {
        order = LeveeOrders.makerOrder(maker, quoter.program(_params(syAmount)));
        address[] memory tokens = new address[](2);
        tokens[0] = address(sy);
        tokens[1] = address(pt);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = syAmount;
        vm.prank(maker);
        aqua.ship(address(router), abi.encode(order), tokens, amounts);
    }

    function _legs(ISwapVM.Order memory order, uint256 ptAmount) internal pure returns (LeveeArb.Leg[] memory legs) {
        legs = new LeveeArb.Leg[](1);
        legs[0] = LeveeArb.Leg({ order: order, ptAmount: ptAmount });
    }

    function test_SelectorMatchesVerifiedPendleRouter() public pure {
        assertEq(IPendleRouterV4.swapExactSyForPt.selector, bytes4(0x2a50917c));
    }

    function test_ArbWithZeroCapital() public {
        ISwapVM.Order memory order = _ship(lp, 500_000e18);
        assertEq(pt.balanceOf(address(arbBot)) + sy.balanceOf(address(arbBot)), 0, "starts empty");
        uint256 lpSyBefore = sy.balanceOf(lp);

        vm.prank(searcher);
        uint256 profit = arbBot.arb(_legs(order, 100_000e6), 1, searcher);

        // Levee paid ~88,402 SY for 100k PT; that SY bought ~102,370 PT on Pendle at 0.9472.
        uint256 syPaid = lpSyBefore - sy.balanceOf(lp);
        assertApproxEqRel(syPaid, 88_402e18, 0.0001e18);
        assertEq(pt.balanceOf(lp), 100_000e6, "LP holds the PT");
        assertEq(profit, pt.balanceOf(searcher), "profit paid out");
        assertApproxEqRel(profit, syPaid * 1.0968e6 / PUSHED_PRICE - 100_000e6, 1e12);
        assertGt(profit, 2_000e6);
        assertEq(pt.balanceOf(address(arbBot)) + sy.balanceOf(address(arbBot)), 0, "ends empty");
    }

    function test_RevertsWhenPendleIsNotCheaper() public {
        ISwapVM.Order memory order = _ship(lp, 500_000e18);
        pendle.setPrice(FAIR_PRICE); // Levee bids ~0.970, Pendle asks 0.971: no arb
        market.setSpot(FAIR_PRICE);
        uint256 lpSyBefore = sy.balanceOf(lp);

        vm.expectPartialRevert(MockPendleRouter.Slippage.selector);
        arbBot.arb(_legs(order, 100_000e6), 0, searcher);

        assertEq(sy.balanceOf(lp), lpSyBefore, "LP untouched");
        assertEq(pt.balanceOf(lp), 0);
    }

    function test_RevertsBelowMinProfit() public {
        ISwapVM.Order memory order = _ship(lp, 500_000e18);
        vm.expectPartialRevert(LeveeArb.ProfitTooLow.selector);
        arbBot.arb(_legs(order, 100_000e6), 1_000_000e6, searcher);
    }

    function test_RevertsWhenLeveeRefuses() public {
        ISwapVM.Order memory order = _ship(lp, 500_000e18);
        sy.setExchangeRate(1.05e6); // SY depeg: the quoter refuses, the whole arb reverts
        vm.expectPartialRevert(LeveeQuoter.SyBelowFloor.selector);
        arbBot.arb(_legs(order, 100_000e6), 0, searcher);
        assertEq(sy.balanceOf(lp), 1_000_000e18);
    }

    function test_SeveralLpsInOneTransaction() public {
        LeveeArb.Leg[] memory legs = new LeveeArb.Leg[](2);
        legs[0] = LeveeArb.Leg({ order: _ship(lp, 300_000e18), ptAmount: 100_000e6 });
        legs[1] = LeveeArb.Leg({ order: _ship(lp2, 300_000e18), ptAmount: 150_000e6 });

        uint256 profit = arbBot.arb(legs, 1, searcher);
        assertEq(pt.balanceOf(lp), 100_000e6);
        assertEq(pt.balanceOf(lp2), 150_000e6);
        assertGt(profit, 5_000e6);
    }

    function test_CallbackOnlyFromRouterDuringArb() public {
        vm.expectRevert(abi.encodeWithSelector(LeveeArb.NotRouter.selector, address(this)));
        arbBot.preTransferInCallback(lp, address(arbBot), address(pt), address(sy), 1, 1, bytes32(0), "");

        vm.prank(address(router));
        vm.expectRevert(LeveeArb.NotInArb.selector);
        arbBot.preTransferInCallback(lp, address(arbBot), address(pt), address(sy), 1, 1, bytes32(0), "");
    }
}

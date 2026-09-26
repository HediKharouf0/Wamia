// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test, console2 } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";

import { P1nchQuoter } from "../../src/P1nchQuoter.sol";
import { P1nchOrders } from "../../src/P1nchOrders.sol";
import { P1nchArb } from "../../src/P1nchArb.sol";
import { P1nchMath } from "../../src/P1nchMath.sol";
import { IPendleRouterV4 } from "../../src/interfaces/IPendleRouterV4.sol";
import { IStandardizedYieldLike } from "../../src/interfaces/IPendle.sol";
import { P1nchTestParams } from "../utils/P1nchTestParams.sol";

interface IPMarketState {
    function _storage() external view returns (int128, int128, uint96 lastLnImpliedRate, uint16, uint16, uint16);
    function expiry() external view returns (uint256);
}

/// The Aug 25 attack replayed on a mainnet fork, with a P1nch strategy on the deployed Aqua +
/// AquaSwapVMRouter and a zero-capital P1nchArb buying PT on the real PendleRouterV4.
/// Skipped unless ARCHIVE_RPC_URL is set:
///   cd contracts && set -a && source ../.env && set +a && forge test --mc P1nchArbForkTest -vv
contract P1nchArbForkTest is Test {
    uint256 constant FORK_BLOCK = 25829822;

    address constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    address constant ROUTER = 0x111111338c5091E8440b67B168bAe16a668AC0De;
    address constant PENDLE_ROUTER = 0x888888888889758F76e7103c6CbF23ABbF58F946;
    address constant MARKET = 0x13285bCbc27F92b47B4EDB99D744C07B48C977c0;
    address constant PT = 0xeCfaFdC7741323a945A163ed068B5a3C43483957;
    address constant SY = 0x9487Bd5A3b16Ecb5F3184453E3ee75B800141648;
    address constant CURVE_REUSD_USDC = 0xf74c91b36C26543A0Aa820bEf407A577e5498BF0;

    P1nchQuoter quoter;
    P1nchArb arbBot;
    ISwapVM.Order order;
    P1nchQuoter.Params params;
    address lp = makeAddr("lp");
    address searcher = makeAddr("searcher");

    function setUp() public {
        string memory rpc = vm.envOr("ARCHIVE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, FORK_BLOCK);

        quoter = new P1nchQuoter();
        arbBot = new P1nchArb(ISwapVM(ROUTER), IPendleRouterV4(PENDLE_ROUTER), MARKET, IERC20(PT), IERC20(SY));

        uint256 syRate = IStandardizedYieldLike(SY).exchangeRate();
        params = P1nchTestParams.defaults(PT, SY, MARKET, CURVE_REUSD_USDC, 5_000_000e18, syRate * 99 / 100);
        order = P1nchOrders.makerOrder(lp, quoter.program(params));

        deal(SY, lp, 5_000_000e18);
        vm.prank(lp);
        IERC20(SY).approve(AQUA, type(uint256).max);
        address[] memory tokens = new address[](2);
        tokens[0] = SY;
        tokens[1] = PT;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 5_000_000e18;
        vm.prank(lp);
        IAqua(AQUA).ship(ROUTER, abi.encode(order), tokens, amounts);
    }

    function _spot() internal view returns (uint256) {
        (,, uint96 lastLn,,,) = IPMarketState(MARKET)._storage();
        return P1nchMath.ptPriceFromLnRate(lastLn, IPMarketState(MARKET).expiry() - block.timestamp);
    }

    /// Replays the 11 manipulator transactions from fixtures/attack-transactions.json.
    function _replayAttack() internal {
        string memory json = vm.readFile("../fixtures/attack-transactions.json");
        for (uint256 i = 0; i < 11; i++) {
            string memory k = string.concat(".manipulator[", vm.toString(i), "]");
            vm.warp(vm.parseJsonUint(json, string.concat(k, ".timeStamp")));
            vm.roll(vm.parseJsonUint(json, string.concat(k, ".blockNumber")));
            vm.prank(vm.parseJsonAddress(json, string.concat(k, ".from")));
            (bool ok,) = vm.parseJsonAddress(json, string.concat(k, ".to")).call(vm.parseJsonBytes(json, string.concat(k, ".input")));
            assertTrue(ok, string.concat("manipulator tx ", vm.toString(i + 1), " reverted"));
        }
    }

    function _legs(uint256 ptAmount) internal view returns (P1nchArb.Leg[] memory legs) {
        legs = new P1nchArb.Leg[](1);
        legs[0] = P1nchArb.Leg({ order: order, ptAmount: ptAmount });
    }

    /// Before the attack Pendle trades at fair value, above P1nch's bid: there is nothing to arb.
    function test_NoArbBeforeTheAttack() public {
        console2.log("spot at fork block:", _spot());
        vm.expectRevert(); // Pendle cannot deliver enough PT for the SY P1nch pays
        arbBot.arb(_legs(100_000e6), 0, searcher);
    }

    /// After the push, a zero-capital arb sells PT to P1nch, buys it back cheaper on Pendle,
    /// and that buying lifts Pendle's spot.
    function test_ArbAfterTheAttackLiftsSpot() public {
        _replayAttack();
        uint256 spotBefore = _spot();
        assertApproxEqRel(spotBefore, 0.9472e18, 0.001e18, "attack reproduced");

        (uint256 fair,,) = quoter.checkMarket(params);
        uint256 lpSyBefore = IERC20(SY).balanceOf(lp);

        vm.prank(searcher);
        uint256 profit = arbBot.arb(_legs(2_000_000e6), 1, searcher);

        uint256 spotAfter = _spot();
        uint256 syPaid = lpSyBefore - IERC20(SY).balanceOf(lp);
        uint256 bid = quoter.marginalBid(params, fair, 5_000_000e18 - syPaid);
        console2.log("P1nch fair / marginal bid after (USD per PT):", fair, bid);
        console2.log("Pendle spot before / after arb:", spotBefore, spotAfter);
        console2.log("LP paid SY for 2M PT:", syPaid);
        console2.log("searcher profit (PT):", profit);

        assertEq(IERC20(PT).balanceOf(lp), 2_000_000e6, "PT landed in the LP wallet");
        assertGt(profit, 0, "arb was profitable with zero capital");
        assertGt(spotAfter, spotBefore + 0.005e18, "buying on Pendle lifted spot");
        assertLt(spotAfter, bid, "arb stops below P1nch's bid");
        assertEq(IERC20(PT).balanceOf(address(arbBot)) + IERC20(SY).balanceOf(address(arbBot)), 0);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test, console2 } from "forge-std/Test.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { AquaSwapVMRouter } from "@1inch/swap-vm/src/routers/AquaSwapVMRouter.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";

import { WamiaQuoter } from "../../src/WamiaQuoter.sol";
import { WamiaOrders } from "../../src/WamiaOrders.sol";
import { WamiaMath } from "../../src/WamiaMath.sol";
import { IStandardizedYieldLike, ICurveStableSwapNGLike } from "../../src/interfaces/IPendle.sol";
import { WamiaTestParams } from "../utils/WamiaTestParams.sol";

interface IPMarketStorage {
    function _storage()
        external
        view
        returns (int128 totalPt, int128 totalSy, uint96 lastLnImpliedRate, uint16, uint16, uint16);
    function expiry() external view returns (uint256);
    function readTokens() external view returns (address sy, address pt, address yt);
}

/// Mainnet fork at block 25829822 (just before the Aug 25 PT-reUSD attack), against the deployed
/// Aqua and AquaSwapVMRouter and the real PT/SY. Skipped when ARCHIVE_RPC_URL is not set.
///   cd contracts && set -a && source ../.env && set +a && forge test --mc WamiaForkTest -vv
contract WamiaForkTest is Test {
    uint256 constant FORK_BLOCK = 25829822;

    address constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    address constant ROUTER = 0x111111338c5091E8440b67B168bAe16a668AC0De;
    address constant MARKET = 0x13285bCbc27F92b47B4EDB99D744C07B48C977c0;
    address constant PT = 0xeCfaFdC7741323a945A163ed068B5a3C43483957;
    address constant SY = 0x9487Bd5A3b16Ecb5F3184453E3ee75B800141648;
    address constant CURVE_REUSD_USDC = 0xf74c91b36C26543A0Aa820bEf407A577e5498BF0;

    AquaSwapVMRouter router = AquaSwapVMRouter(payable(ROUTER));
    IAqua aqua = IAqua(AQUA);
    WamiaQuoter quoter;
    uint256 syRate;

    address lp = makeAddr("lp");
    address taker = makeAddr("taker");

    function setUp() public {
        string memory rpc = vm.envOr("ARCHIVE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, FORK_BLOCK);
        quoter = new WamiaQuoter();
        syRate = IStandardizedYieldLike(SY).exchangeRate();
    }

    /// Spec defaults; the SY floor is 1% under the rate at the fork block.
    function _params(uint256 shippedSy) internal view returns (WamiaQuoter.Params memory) {
        return WamiaTestParams.defaults(PT, SY, MARKET, CURVE_REUSD_USDC, shippedSy, syRate * 99 / 100);
    }

    function _ship(uint256 syAmount) internal returns (ISwapVM.Order memory order, bytes32 hash) {
        deal(SY, lp, syAmount);
        vm.prank(lp);
        IERC20Metadata(SY).approve(AQUA, type(uint256).max);

        order = WamiaOrders.makerOrder(lp, quoter.program(_params(syAmount)));
        address[] memory tokens = new address[](2);
        tokens[0] = SY;
        tokens[1] = PT;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = syAmount;
        vm.prank(lp);
        hash = aqua.ship(ROUTER, abi.encode(order), tokens, amounts);
    }

    function _fundTaker(uint256 ptAmount) internal {
        deal(PT, taker, ptAmount);
        vm.prank(taker);
        IERC20Metadata(PT).approve(ROUTER, type(uint256).max);
    }

    /// The two official contracts exist at the fork block and are wired together.
    function test_PinnedContracts() public view {
        assertGt(AQUA.code.length, 0, "Aqua deployed");
        assertGt(ROUTER.code.length, 0, "router deployed (block 25618917)");
        assertEq(address(router.AQUA()), AQUA, "router settles through the official Aqua");
        (, string memory name, string memory version,,,,) = router.eip712Domain();
        console2.log("router EIP-712 domain:", name, version);
    }

    /// Decimals, SY rate convention and fair value agree with Pendle's own state.
    function test_UnitsMatchPendle() public view {
        assertEq(IERC20Metadata(PT).decimals(), 6, "PT decimals");
        assertEq(IERC20Metadata(SY).decimals(), 18, "SY decimals");
        console2.log("SY.exchangeRate():", syRate);
        assertApproxEqRel(syRate, 1.0968e6, 0.005e18, "asset = sy * rate / 1e18, asset has 6 decimals");

        (,, uint96 lastLn,,,) = IPMarketStorage(MARKET)._storage();
        uint256 expiry = IPMarketStorage(MARKET).expiry();
        uint256 spot = WamiaMath.ptPriceFromLnRate(lastLn, expiry - block.timestamp);
        (uint256 fair, uint256 quoterSpot,) = quoter.checkMarket(_params(1e18));
        assertEq(quoterSpot, spot, "quoter reads the same spot");
        console2.log("Pendle spot (USD/PT):", spot);
        console2.log("Wamia fair  (USD/PT):", fair);
        assertApproxEqRel(spot, 0.9710e18, 0.0005e18, "matches the 0.9710 spot measured by the harness");
        assertApproxEqRel(fair, spot, 0.0005e18, "10.583% reference = pre-attack market rate");

        // Harness measured ~1.13 PT per SY on Pendle, i.e. ~0.885 SY per PT.
        uint256 syPerPt = WamiaMath.ptToSyDown(1e6, fair, syRate);
        assertApproxEqRel(syPerPt, 0.885e18, 0.01e18, "1 PT is worth ~0.885 SY");
    }

    function test_ShipQuoteSwapOnMainnetContracts() public {
        (ISwapVM.Order memory order, bytes32 hash) = _ship(1_000_000e18);
        assertEq(hash, router.hash(order));
        _fundTaker(100_000e6);

        bytes memory td = WamiaOrders.takerData(taker, true, 0, true, false, "");
        (, uint256 quotedOut,) = router.quote(order, PT, SY, 100_000e6, td);

        uint256 lpSyBefore = IERC20Metadata(SY).balanceOf(lp);
        td = WamiaOrders.takerData(taker, true, quotedOut, true, false, "");
        vm.prank(taker);
        (uint256 amountIn, uint256 amountOut,) = router.swap(order, PT, SY, 100_000e6, td);

        console2.log("PT sold:", amountIn);
        console2.log("SY paid:", amountOut);
        assertEq(amountOut, quotedOut, "swap pays exactly the quote");
        assertEq(IERC20Metadata(SY).balanceOf(taker), amountOut);
        assertEq(IERC20Metadata(PT).balanceOf(lp), 100_000e6, "PT lands in the LP wallet");
        assertEq(lpSyBefore - IERC20Metadata(SY).balanceOf(lp), amountOut, "SY leaves the LP wallet");

        (uint248 syLeft,) = aqua.rawBalances(lp, ROUTER, hash, SY);
        (uint248 ptHeld,) = aqua.rawBalances(lp, ROUTER, hash, PT);
        assertEq(syLeft, 1_000_000e18 - amountOut);
        assertEq(ptHeld, 100_000e6);
    }

    /// reUSD's market price on Curve against its NAV, read by the depeg stop.
    function test_CurvePoolPricesReusdAgainstNav() public view {
        uint256 ratio = quoter.marketToNav(_params(1e18));
        console2.log("reUSD market / NAV (Curve EMA):", ratio);
        assertApproxEqRel(ratio, 0.99997e18, 0.00005e18, "at NAV on Aug 25");
        assertGe(ratio, 0.99e18, "passes the 1% depeg stop");
    }

    /// A run: reUSD trades 2% below NAV on Curve while SY.exchangeRate() does not move.
    function test_RefusesOnReusdMarketDepeg() public {
        (ISwapVM.Order memory order,) = _ship(1_000_000e18);
        _fundTaker(100_000e6);
        // Harness only: USDC now costs 1.02 NAV-reUSD, i.e. reUSD at ~0.98 of NAV.
        vm.mockCall(
            CURVE_REUSD_USDC, abi.encodeWithSelector(ICurveStableSwapNGLike.price_oracle.selector, 0), abi.encode(1.02e18)
        );

        bytes memory td = WamiaOrders.takerData(taker, true, 0, true, false, "");
        vm.prank(taker);
        vm.expectPartialRevert(WamiaQuoter.UnderlyingDepegged.selector);
        router.swap(order, PT, SY, 100_000e6, td);
    }

    function test_RefusesWhenSyRateDrops() public {
        (ISwapVM.Order memory order,) = _ship(1_000_000e18);
        _fundTaker(100_000e6);
        uint256 depegged = syRate * 95 / 100;
        // Harness only: simulate a collapse of the underlying.
        vm.mockCall(SY, abi.encodeWithSelector(IStandardizedYieldLike.exchangeRate.selector), abi.encode(depegged));

        bytes memory td = WamiaOrders.takerData(taker, true, 0, true, false, "");
        vm.prank(taker);
        vm.expectPartialRevert(WamiaQuoter.SyBelowFloor.selector);
        router.swap(order, PT, SY, 100_000e6, td);
    }
}

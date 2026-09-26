// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { SwapQuery, SwapRegisters } from "@1inch/swap-vm/src/libs/VM.sol";

import { LeveeQuoter } from "../src/LeveeQuoter.sol";
import { LeveeMath } from "../src/LeveeMath.sol";
import { MockToken, MockSY, MockPendleMarket } from "./mocks/Mocks.sol";

/// Unit tests: the quoter is called directly, the way SwapVM's Extruction calls it.
/// Numbers mirror the fork: ts 1787632115, expiry 2026-12-10, SY rate 1.0968e6.
contract LeveeQuoterTest is Test {
    uint256 constant FORK_TS = 1787632115;
    uint256 constant EXPIRY = 1796860800;

    LeveeQuoter quoter;
    MockToken pt;
    MockSY sy;
    MockPendleMarket market;
    LeveeQuoter.Params params;
    bytes args; // encoded once so expectRevert targets the quoter call itself

    function setUp() public {
        vm.warp(FORK_TS);
        quoter = new LeveeQuoter();
        pt = new MockToken("PT", 6);
        sy = new MockSY(1.0968e6);
        market = new MockPendleMarket(EXPIRY, address(sy), address(pt));
        params = LeveeQuoter.Params({
            pt: address(pt),
            sy: address(sy),
            market: address(market),
            refYieldWad: 0.10583e18,
            discountBps: 10,
            maxPtPerTrade: 5_000_000e6,
            minSyRate: 1.09e6
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

    function _call(SwapQuery memory q, SwapRegisters memory r) internal view returns (uint256, uint256, SwapRegisters memory) {
        return quoter.extruction(false, 124, q, r, args, "");
    }

    function test_ExactInPaysDiscountedFairValue() public view {
        (uint256 pc, uint256 chopped, SwapRegisters memory out) =
            _call(_query(address(pt), address(sy), true), _regs(100_000e6, 0, 10_000_000e18));

        (uint256 fair, uint256 bid, uint256 rate) = quoter.bidPrice(params);
        assertApproxEqRel(fair, 970990654522581086, 1e6);
        assertEq(bid, fair * 9990 / 10_000);
        assertEq(rate, 1.0968e6);

        assertEq(pc, 124, "program counter untouched");
        assertEq(chopped, 0, "no taker args consumed");
        assertEq(out.amountIn, 100_000e6);
        assertEq(out.amountOut, LeveeMath.ptToSyDown(100_000e6, bid, rate));
        // ~100,000 * 0.970991 * 0.999 / 1.0968 = ~88,441 SY
        assertApproxEqRel(out.amountOut, 88_441e18, 0.0001e18);
        assertEq(out.balanceOut, 10_000_000e18, "balances untouched");
    }

    function test_ExactOutRoundsUpAndMatchesExactIn() public view {
        (,, SwapRegisters memory exactIn) =
            _call(_query(address(pt), address(sy), true), _regs(100_000e6, 0, 10_000_000e18));
        (,, SwapRegisters memory exactOut) =
            _call(_query(address(pt), address(sy), false), _regs(0, exactIn.amountOut, 10_000_000e18));
        assertEq(exactOut.amountOut, exactIn.amountOut);
        assertLe(exactOut.amountIn, 100_000e6, "never asks for more PT than exact-in used");
        assertGe(exactOut.amountIn, 100_000e6 - 1, "and at most 1 unit less");
    }

    function test_RevertWhen_SyToPt() public {
        vm.expectRevert(abi.encodeWithSelector(LeveeQuoter.OnlyPtToSy.selector, address(sy), address(pt)));
        _call(_query(address(sy), address(pt), true), _regs(1e18, 0, 1e30));
    }

    function test_RevertWhen_UnknownToken() public {
        MockToken other = new MockToken("X", 6);
        vm.expectRevert(abi.encodeWithSelector(LeveeQuoter.OnlyPtToSy.selector, address(other), address(sy)));
        _call(_query(address(other), address(sy), true), _regs(1e6, 0, 1e30));
    }

    function test_RevertWhen_Expired() public {
        vm.warp(EXPIRY);
        vm.expectRevert(abi.encodeWithSelector(LeveeQuoter.MarketExpired.selector, EXPIRY));
        _call(_query(address(pt), address(sy), true), _regs(1e6, 0, 1e30));
    }

    function test_RevertWhen_SyDepegs() public {
        sy.setExchangeRate(1.05e6);
        vm.expectRevert(abi.encodeWithSelector(LeveeQuoter.SyBelowFloor.selector, 1.05e6, 1.09e6));
        _call(_query(address(pt), address(sy), true), _regs(1e6, 0, 1e30));
    }

    function test_RevertWhen_TradeTooLarge() public {
        uint256 tooMuch = uint256(params.maxPtPerTrade) + 1;
        vm.expectRevert(abi.encodeWithSelector(LeveeQuoter.TradeTooLarge.selector, tooMuch, params.maxPtPerTrade));
        _call(_query(address(pt), address(sy), true), _regs(tooMuch, 0, 1e30));
    }

    function test_RevertWhen_ExactOutTradeTooLarge() public {
        vm.expectRevert(); // amountIn computed from a huge SY request exceeds the cap
        _call(_query(address(pt), address(sy), false), _regs(0, 10_000_000e18, 1e30));
    }

    function test_RevertWhen_NotEnoughShippedSy() public {
        (,, SwapRegisters memory ok) = _call(_query(address(pt), address(sy), true), _regs(100_000e6, 0, 1e30));
        uint256 have = ok.amountOut - 1;
        vm.expectRevert(abi.encodeWithSelector(LeveeQuoter.InsufficientLiquidity.selector, ok.amountOut, have));
        _call(_query(address(pt), address(sy), true), _regs(100_000e6, 0, have));
    }

    function test_RevertWhen_ParamsHaveWrongLength() public {
        vm.expectRevert(abi.encodeWithSelector(LeveeQuoter.BadParamsLength.selector, 101));
        quoter.extruction(false, 0, _query(address(pt), address(sy), true), _regs(1e6, 0, 1e30), new bytes(101), "");
    }

    function test_TakerDataIsIgnored() public view {
        SwapQuery memory q = _query(address(pt), address(sy), true);
        SwapRegisters memory r = _regs(100_000e6, 0, 1e30);
        (,, SwapRegisters memory a) = quoter.extruction(false, 0, q, r, args, "");
        (,, SwapRegisters memory b) = quoter.extruction(true, 0, q, r, args, hex"deadbeef");
        assertEq(a.amountOut, b.amountOut);
    }

    function test_ParamsRoundTrip() public view {
        bytes memory encoded = quoter.encodeParams(params);
        assertEq(encoded.length, quoter.PARAMS_LENGTH());
        LeveeQuoter.Params memory p = quoter.decodeParams(encoded);
        assertEq(p.pt, params.pt);
        assertEq(p.sy, params.sy);
        assertEq(p.market, params.market);
        assertEq(p.refYieldWad, params.refYieldWad);
        assertEq(p.discountBps, params.discountBps);
        assertEq(p.maxPtPerTrade, params.maxPtPerTrade);
        assertEq(p.minSyRate, params.minSyRate);
    }

    function test_ProgramLayout() public view {
        bytes memory prog = quoter.program(params);
        assertEq(prog.length, 2 + 20 + 102);
        assertEq(uint8(prog[0]), 0x20, "Extruction opcode in swap-vm v1.0.2");
        assertEq(uint8(prog[1]), 122, "args length");
        address target;
        assembly {
            target := shr(96, mload(add(prog, 34)))
        }
        assertEq(target, address(quoter));
    }

    function testFuzz_BidNeverAboveFair(uint64 yieldWad, uint16 discountBps, uint32 secsLeft) public {
        params.refYieldWad = uint64(bound(yieldWad, 0, 2e18));
        params.discountBps = uint16(bound(discountBps, 0, 9_999));
        vm.warp(EXPIRY - bound(secsLeft, 1, 365 days));
        (uint256 fair, uint256 bid,) = quoter.bidPrice(params);
        assertLe(bid, fair);
        assertLe(fair, 1e18);
    }
}

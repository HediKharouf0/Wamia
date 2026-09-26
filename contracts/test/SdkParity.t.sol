// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { AquaSwapVMRouter } from "@1inch/swap-vm/src/routers/AquaSwapVMRouter.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { MakerTraits } from "@1inch/swap-vm/src/libs/MakerTraits.sol";

import { P1nchQuoter } from "../src/P1nchQuoter.sol";
import { P1nchOrders } from "../src/P1nchOrders.sol";
import { P1nchRateGuard } from "../src/P1nchRateGuard.sol";
import { P1nchSpendLimit } from "../src/P1nchSpendLimit.sol";

/// The TypeScript side builds orders with the 1inch swap-vm SDK (src/aqua/p1nch.ts); the contracts
/// build them with swap-vm's Solidity libraries (P1nchOrders.sol). Both must produce the same
/// bytes, or a strategy shipped from TypeScript would not be the one the tests validate.
/// Regenerate the fixture with `npx tsx src/aqua/exportSdkVectors.ts` from the repo root.
contract SdkParityTest is Test {
    string json;
    P1nchQuoter.Params params;
    address maker;
    address quoter;

    function setUp() public {
        json = vm.readFile("test/fixtures/sdk-vectors.json");
        maker = vm.parseJsonAddress(json, ".maker");
        quoter = vm.parseJsonAddress(json, ".quoter");
        params = P1nchQuoter.Params({
            pt: vm.parseJsonAddress(json, ".params.pt"),
            sy: vm.parseJsonAddress(json, ".params.sy"),
            market: vm.parseJsonAddress(json, ".params.market"),
            curvePool: vm.parseJsonAddress(json, ".params.curvePool"),
            refYieldWad: uint64(vm.parseJsonUint(json, ".params.refYieldWad")),
            discountMinBps: uint16(vm.parseJsonUint(json, ".params.discountMinBps")),
            discountMaxBps: uint16(vm.parseJsonUint(json, ".params.discountMaxBps")),
            shippedSy: uint128(vm.parseJsonUint(json, ".params.shippedSy")),
            minSyRate: uint128(vm.parseJsonUint(json, ".params.minSyRate")),
            maxDepegBps: uint16(vm.parseJsonUint(json, ".params.maxDepegBps")),
            maxDeviationBps: uint16(vm.parseJsonUint(json, ".params.maxDeviationBps")),
            flags: uint8(vm.parseJsonUint(json, ".params.flags"))
        });
        // The program embeds the quoter's address, so put the quoter where the SDK pointed.
        deployCodeTo("P1nchQuoter.sol:P1nchQuoter", quoter);
    }

    function test_ParamsMatchSdk() public view {
        assertEq(P1nchQuoter(quoter).encodeParams(params), vm.parseJsonBytes(json, ".encodedParams"));
    }

    function test_ProgramMatchesSdk() public view {
        assertEq(P1nchQuoter(quoter).program(params), vm.parseJsonBytes(json, ".program"));
    }

    function test_OrderAndStrategyHashMatchSdk() public {
        ISwapVM.Order memory order = P1nchOrders.makerOrder(maker, P1nchQuoter(quoter).program(params));
        assertEq(bytes32(MakerTraits.unwrap(order.traits)), vm.parseJsonBytes32(json, ".orderTraits"), "traits");
        assertEq(order.data, vm.parseJsonBytes(json, ".orderData"), "data");

        bytes32 sdkHash = vm.parseJsonBytes32(json, ".strategyHash");
        assertEq(keccak256(abi.encode(order)), sdkHash, "Aqua strategy hash");

        // And the router itself agrees.
        Aqua aqua = new Aqua();
        AquaSwapVMRouter router = new AquaSwapVMRouter(address(aqua), address(1), address(this), "AquaSwapVMRouter", "1.0.2");
        assertEq(router.hash(order), sdkHash, "router.hash");
    }

    /// The three-step program [RateGuard][Quoter][SpendLimit] and its strategy hash.
    function test_GuardedProgramAndHashMatchSdk() public {
        address rateGuard = vm.parseJsonAddress(json, ".guarded.rateGuard");
        address spendLimit = vm.parseJsonAddress(json, ".guarded.spendLimit");
        // The guards' program bytes depend on their address and params, not on the router they trust.
        deployCodeTo("P1nchRateGuard.sol:P1nchRateGuard", abi.encode(address(1)), rateGuard);
        deployCodeTo("P1nchSpendLimit.sol:P1nchSpendLimit", abi.encode(address(1)), spendLimit);

        P1nchRateGuard.Params memory rp = P1nchRateGuard.Params({
            sy: vm.parseJsonAddress(json, ".guarded.rateGuardParams.sy"),
            rateAtShip: uint128(vm.parseJsonUint(json, ".guarded.rateGuardParams.rateAtShip")),
            shipTimestamp: uint64(vm.parseJsonUint(json, ".guarded.rateGuardParams.shipTimestamp")),
            maxDropBps: uint16(vm.parseJsonUint(json, ".guarded.rateGuardParams.maxDropBps")),
            minElapsed: uint32(vm.parseJsonUint(json, ".guarded.rateGuardParams.minElapsed")),
            refYieldWad: uint64(vm.parseJsonUint(json, ".guarded.rateGuardParams.refYieldWad")),
            maxYieldGapBps: uint16(vm.parseJsonUint(json, ".guarded.rateGuardParams.maxYieldGapBps"))
        });
        P1nchSpendLimit.Params memory sp = P1nchSpendLimit.Params({
            shippedSy: uint128(vm.parseJsonUint(json, ".guarded.spendLimitParams.shippedSy")),
            windowSec: uint32(vm.parseJsonUint(json, ".guarded.spendLimitParams.windowSec")),
            minCapBps: uint16(vm.parseJsonUint(json, ".guarded.spendLimitParams.minCapBps")),
            horizonSec: uint32(vm.parseJsonUint(json, ".guarded.spendLimitParams.horizonSec")),
            expiry: uint64(vm.parseJsonUint(json, ".guarded.spendLimitParams.expiry"))
        });
        bytes memory prog = bytes.concat(
            P1nchRateGuard(rateGuard).program(rp), P1nchQuoter(quoter).program(params), P1nchSpendLimit(spendLimit).program(sp)
        );
        assertEq(prog, vm.parseJsonBytes(json, ".guarded.program"), "program");

        ISwapVM.Order memory order = P1nchOrders.makerOrder(maker, prog);
        assertEq(keccak256(abi.encode(order)), vm.parseJsonBytes32(json, ".guarded.strategyHash"), "strategy hash");
    }

    function test_TakerDataMatchesSdk() public view {
        for (uint256 i = 0; i < 3; i++) {
            string memory k = string.concat(".taker[", vm.toString(i), "]");
            bool exactIn = vm.parseJsonBool(json, string.concat(k, ".exactIn"));
            uint256 threshold = vm.parseJsonUint(json, string.concat(k, ".threshold"));
            bool pull = vm.parseJsonBool(json, string.concat(k, ".pullPtFromTaker"));
            bool hasCallback = vm.keyExistsJson(json, string.concat(k, ".callbackData"));
            bytes memory cb = hasCallback ? vm.parseJsonBytes(json, string.concat(k, ".callbackData")) : bytes("");

            bytes memory ours = P1nchOrders.takerData(address(0xB0B), exactIn, threshold, pull, hasCallback, cb);
            assertEq(ours, vm.parseJsonBytes(json, string.concat(k, ".takerData")), vm.parseJsonString(json, string.concat(k, ".name")));
        }
    }
}

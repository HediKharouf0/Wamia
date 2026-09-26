// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { AquaSwapVMRouter } from "@1inch/swap-vm/src/routers/AquaSwapVMRouter.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { MakerTraits } from "@1inch/swap-vm/src/libs/MakerTraits.sol";

import { LeveeQuoter } from "../src/LeveeQuoter.sol";
import { LeveeOrders } from "../src/LeveeOrders.sol";

/// The TypeScript side builds orders with the 1inch swap-vm SDK (src/aqua/levee.ts); the contracts
/// build them with swap-vm's Solidity libraries (LeveeOrders.sol). Both must produce the same
/// bytes, or a strategy shipped from TypeScript would not be the one the tests validate.
/// Regenerate the fixture with `npx tsx src/aqua/exportSdkVectors.ts` from the repo root.
contract SdkParityTest is Test {
    string json;
    LeveeQuoter.Params params;
    address maker;
    address quoter;

    function setUp() public {
        json = vm.readFile("test/fixtures/sdk-vectors.json");
        maker = vm.parseJsonAddress(json, ".maker");
        quoter = vm.parseJsonAddress(json, ".quoter");
        params = LeveeQuoter.Params({
            pt: vm.parseJsonAddress(json, ".params.pt"),
            sy: vm.parseJsonAddress(json, ".params.sy"),
            market: vm.parseJsonAddress(json, ".params.market"),
            refYieldWad: uint64(vm.parseJsonUint(json, ".params.refYieldWad")),
            discountBps: uint16(vm.parseJsonUint(json, ".params.discountBps")),
            maxPtPerTrade: uint128(vm.parseJsonUint(json, ".params.maxPtPerTrade")),
            minSyRate: uint128(vm.parseJsonUint(json, ".params.minSyRate"))
        });
        // The program embeds the quoter's address, so put the quoter where the SDK pointed.
        deployCodeTo("LeveeQuoter.sol:LeveeQuoter", quoter);
    }

    function test_ParamsMatchSdk() public view {
        assertEq(LeveeQuoter(quoter).encodeParams(params), vm.parseJsonBytes(json, ".encodedParams"));
    }

    function test_ProgramMatchesSdk() public view {
        assertEq(LeveeQuoter(quoter).program(params), vm.parseJsonBytes(json, ".program"));
    }

    function test_OrderAndStrategyHashMatchSdk() public {
        ISwapVM.Order memory order = LeveeOrders.makerOrder(maker, LeveeQuoter(quoter).program(params));
        assertEq(bytes32(MakerTraits.unwrap(order.traits)), vm.parseJsonBytes32(json, ".orderTraits"), "traits");
        assertEq(order.data, vm.parseJsonBytes(json, ".orderData"), "data");

        bytes32 sdkHash = vm.parseJsonBytes32(json, ".strategyHash");
        assertEq(keccak256(abi.encode(order)), sdkHash, "Aqua strategy hash");

        // And the router itself agrees.
        Aqua aqua = new Aqua();
        AquaSwapVMRouter router = new AquaSwapVMRouter(address(aqua), address(1), address(this), "AquaSwapVMRouter", "1.0.2");
        assertEq(router.hash(order), sdkHash, "router.hash");
    }

    function test_TakerDataMatchesSdk() public view {
        for (uint256 i = 0; i < 3; i++) {
            string memory k = string.concat(".taker[", vm.toString(i), "]");
            bool exactIn = vm.parseJsonBool(json, string.concat(k, ".exactIn"));
            uint256 threshold = vm.parseJsonUint(json, string.concat(k, ".threshold"));
            bool pull = vm.parseJsonBool(json, string.concat(k, ".pullPtFromTaker"));
            bool hasCallback = vm.keyExistsJson(json, string.concat(k, ".callbackData"));
            bytes memory cb = hasCallback ? vm.parseJsonBytes(json, string.concat(k, ".callbackData")) : bytes("");

            bytes memory ours = LeveeOrders.takerData(address(0xB0B), exactIn, threshold, pull, hasCallback, cb);
            assertEq(ours, vm.parseJsonBytes(json, string.concat(k, ".takerData")), vm.parseJsonString(json, string.concat(k, ".name")));
        }
    }
}

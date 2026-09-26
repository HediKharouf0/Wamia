// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { WamiaQuoter } from "../../src/WamiaQuoter.sol";

/// Default Wamia parameters used across tests (spec 7.3 values).
library WamiaTestParams {
    function defaults(address pt, address sy, address market, address curvePool, uint256 shippedSy, uint256 minSyRate)
        internal
        pure
        returns (WamiaQuoter.Params memory p)
    {
        p.pt = pt;
        p.sy = sy;
        p.market = market;
        p.curvePool = curvePool;
        p.refYieldWad = 0.10583e18; // pre-attack implied APY
        p.discountMinBps = 10;
        p.discountMaxBps = 60;
        p.shippedSy = uint128(shippedSy);
        p.minSyRate = uint128(minSyRate);
        p.maxDepegBps = 100; // reUSD at most 1% below NAV
        p.maxDeviationBps = 450; // Pendle spot at most 4.5% below fair (Aug 25: ~2.45%)
        p.flags = 0; // reUSD is coins[0] in the Curve pool
    }
}

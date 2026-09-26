// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice The parts of Pendle's market and SY interfaces that Levee reads.
interface IPMarketLike {
    function expiry() external view returns (uint256);
    function readTokens() external view returns (address sy, address pt, address yt);
    /// @dev lastLnImpliedRate = ln(1 + implied APY), 1e18-scaled
    function _storage()
        external
        view
        returns (
            int128 totalPt,
            int128 totalSy,
            uint96 lastLnImpliedRate,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext
        );
}

interface IStandardizedYieldLike {
    /// @dev assetAmount = syAmount * exchangeRate() / 1e18 (SYBase convention)
    function exchangeRate() external view returns (uint256);
}

/// @notice Curve StableSwap-NG price views. With a rate oracle on a coin (reUSD's NAV), prices are
///         NAV-adjusted: 1e18 means the coin trades exactly at its NAV.
interface ICurveStableSwapNGLike {
    /// @dev EMA price of coins[i + 1] in units of coins[0]
    function price_oracle(uint256 i) external view returns (uint256);
    /// @dev Price of coins[i + 1] in units of coins[0] after the last trade
    function last_price(uint256 i) external view returns (uint256);
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice The parts of Pendle's market and SY interfaces that Levee reads.
interface IPMarketLike {
    function expiry() external view returns (uint256);
    function readTokens() external view returns (address sy, address pt, address yt);
}

interface IStandardizedYieldLike {
    /// @dev assetAmount = syAmount * exchangeRate() / 1e18 (SYBase convention)
    function exchangeRate() external view returns (uint256);
}

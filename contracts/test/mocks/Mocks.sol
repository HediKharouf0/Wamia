// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IPendleRouterV4 } from "../../src/interfaces/IPendleRouterV4.sol";
import { P1nchMath } from "../../src/P1nchMath.sol";
import { FixedPointMathLib as FPM } from "solady/utils/FixedPointMathLib.sol";

contract MockToken is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, uint8 decimals_) ERC20(name_, name_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice SY with a settable exchange rate (asset = sy * rate / 1e18).
contract MockSY is MockToken {
    uint256 public exchangeRate;

    constructor(uint256 rate) MockToken("SY", 18) {
        exchangeRate = rate;
    }

    function setExchangeRate(uint256 rate) external {
        exchangeRate = rate;
    }
}

contract MockPendleMarket {
    uint256 public expiry;
    address public sy;
    address public pt;
    uint96 public lastLnImpliedRate;

    constructor(uint256 expiry_, address sy_, address pt_) {
        expiry = expiry_;
        sy = sy_;
        pt = pt_;
        lastLnImpliedRate = uint96(P1nchMath.lnImpliedRate(0.10583e18)); // spot = fair by default
    }

    function readTokens() external view returns (address, address, address) {
        return (sy, pt, address(0));
    }

    function setLnImpliedRate(uint96 lnRate) external {
        lastLnImpliedRate = lnRate;
    }

    /// @notice Set Pendle spot to `priceWad` (asset per PT) at the current timestamp.
    function setSpot(uint256 priceWad) external {
        uint256 secs = expiry - block.timestamp;
        lastLnImpliedRate = uint96(uint256(-FPM.lnWad(int256(priceWad))) * 365 days / secs);
    }

    function _storage() external view returns (int128, int128, uint96, uint16, uint16, uint16) {
        return (0, 0, lastLnImpliedRate, 0, 0, 0);
    }
}

/// @notice Curve StableSwap-NG price views with settable values (1e18 = at NAV).
contract MockCurvePool {
    uint256 public emaPrice = 1e18;
    uint256 public lastPrice = 1e18;

    function set(uint256 ema, uint256 last) external {
        emaPrice = ema;
        lastPrice = last;
    }

    function price_oracle(uint256) external view returns (uint256) {
        return emaPrice;
    }

    function last_price(uint256) external view returns (uint256) {
        return lastPrice;
    }
}

/// @notice Stand-in for PendleRouterV4.swapExactSyForPt at a fixed PT price (asset per PT, wad).
contract MockPendleRouter {
    MockToken public immutable pt;
    MockSY public immutable sy;
    uint256 public priceWad;

    error Slippage(uint256 ptOut, uint256 minPtOut);

    constructor(MockToken pt_, MockSY sy_, uint256 priceWad_) {
        pt = pt_;
        sy = sy_;
        priceWad = priceWad_;
    }

    function setPrice(uint256 priceWad_) external {
        priceWad = priceWad_;
    }

    function swapExactSyForPt(
        address receiver,
        address,
        uint256 exactSyIn,
        uint256 minPtOut,
        IPendleRouterV4.ApproxParams calldata,
        IPendleRouterV4.LimitOrderData calldata
    )
        external
        returns (uint256 netPtOut, uint256 netSyFee)
    {
        sy.transferFrom(msg.sender, address(this), exactSyIn);
        netPtOut = exactSyIn * sy.exchangeRate() / priceWad; // asset raw (= PT raw) / price
        if (netPtOut < minPtOut) revert Slippage(netPtOut, minPtOut);
        pt.mint(receiver, netPtOut);
        return (netPtOut, 0);
    }
}

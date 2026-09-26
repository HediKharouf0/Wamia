// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IPendleRouterV4 } from "../../src/interfaces/IPendleRouterV4.sol";

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

    constructor(uint256 expiry_, address sy_, address pt_) {
        expiry = expiry_;
        sy = sy_;
        pt = pt_;
    }

    function readTokens() external view returns (address, address, address) {
        return (sy, pt, address(0));
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

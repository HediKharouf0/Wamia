// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

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

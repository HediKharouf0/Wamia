// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { ITakerCallbacks } from "@1inch/swap-vm/src/interfaces/ITakerCallbacks.sol";

import { LeveeOrders } from "./LeveeOrders.sol";
import { IPendleRouterV4 } from "./interfaces/IPendleRouterV4.sol";

/// @title LeveeArb
/// @notice Zero-capital arbitrage between Pendle and Levee strategies. When a push sends Pendle's
///         PT price below a Levee bid, anyone can call `arb`: it sells PT to Levee, and pays for
///         that PT by buying it on Pendle with the SY Levee just sent, all in one transaction.
///         Buying on Pendle is what pulls the spot price back up.
/// @dev Flow per leg, inside AquaSwapVMRouter.swap (swap-vm v1.0.2, default transfer order):
///        1. The router runs the Levee program and pulls SY from the LP (via Aqua) to this contract.
///        2. It calls `preTransferInCallback`: we swap that SY for PT on Pendle.
///        3. It transferFroms the PT from this contract and pushes it to the LP (via Aqua).
///      If Pendle yields too little PT, or Levee refuses the trade, the whole transaction reverts:
///      the LP is untouched and the caller only loses gas. Profit stays in PT.
contract LeveeArb is ITakerCallbacks {
    using SafeERC20 for IERC20;

    struct Leg {
        ISwapVM.Order order;
        uint256 ptAmount; // PT sold to this Levee strategy (exact in)
    }

    ISwapVM public immutable ROUTER;
    IPendleRouterV4 public immutable PENDLE_ROUTER;
    address public immutable MARKET;
    IERC20 public immutable PT;
    IERC20 public immutable SY;

    /// @dev Set only while `arb` runs, so the callback cannot be triggered by anyone else's swap.
    bool private transient _inArb;

    error NotRouter(address caller);
    error NotInArb();
    error ProfitTooLow(uint256 profitPt, uint256 minProfitPt);
    error UnexpectedCallback();

    event Arbitraged(address indexed caller, uint256 legs, uint256 ptSoldToLevee, uint256 profitPt);

    // A zero market only makes every Pendle buy revert; this contract holds no funds between calls.
    // forge-lint: disable-next-line(missing-zero-check)
    constructor(ISwapVM router, IPendleRouterV4 pendleRouter, address market, IERC20 pt, IERC20 sy) {
        ROUTER = router;
        PENDLE_ROUTER = pendleRouter;
        MARKET = market;
        PT = pt;
        SY = sy;
        pt.forceApprove(address(router), type(uint256).max);
        sy.forceApprove(address(pendleRouter), type(uint256).max);
    }

    /// @notice Sell PT to one or more Levee strategies, funding each sale on Pendle.
    /// @param legs        Levee orders and the PT amount to sell to each
    /// @param minProfitPt Revert unless at least this much PT is left over
    /// @param profitTo    Receives the PT profit (and any SY dust)
    function arb(Leg[] calldata legs, uint256 minProfitPt, address profitTo) external returns (uint256 profitPt) {
        _inArb = true;
        bytes memory takerData = LeveeOrders.takerData(address(this), true, 0, true, true, "");
        uint256 sold = 0;
        for (uint256 i = 0; i < legs.length; i++) {
            // One swap per LP by design; any failing leg reverts the whole arb. The amounts are
            // settled by balance checks below, so the swap's return values are not needed.
            // forge-lint: disable-next-line(calls-loop, unused-return)
            ROUTER.swap(legs[i].order, address(PT), address(SY), legs[i].ptAmount, takerData);
            sold += legs[i].ptAmount;
        }
        _inArb = false;

        profitPt = PT.balanceOf(address(this));
        require(profitPt >= minProfitPt, ProfitTooLow(profitPt, minProfitPt));
        if (profitPt > 0) PT.safeTransfer(profitTo, profitPt);
        uint256 syDust = SY.balanceOf(address(this));
        if (syDust > 0) SY.safeTransfer(profitTo, syDust);

        // Emitted last on purpose: it reports the settled result. Reentry is blocked by the router
        // check and _inArb in the callback.
        // forge-lint: disable-next-line(reentrancy-events)
        emit Arbitraged(msg.sender, legs.length, sold, profitPt);
    }

    /// @inheritdoc ITakerCallbacks
    /// @dev Called after Levee's SY reached this contract and before the router collects PT.
    function preTransferInCallback(
        address, /* maker */
        address taker,
        address, /* tokenIn */
        address, /* tokenOut */
        uint256 amountIn,
        uint256, /* amountOut */
        bytes32, /* orderHash */
        bytes calldata /* takerData */
    ) external {
        require(msg.sender == address(ROUTER), NotRouter(msg.sender));
        require(_inArb && taker == address(this), NotInArb());

        uint256 ptHeld = PT.balanceOf(address(this));
        if (ptHeld >= amountIn) return; // leftover from an earlier leg already covers it

        // Spend all SY on PT. minPtOut makes Pendle revert if the arb cannot cover this leg; the PT
        // received is read from the balance afterwards, so the return values are not needed.
        // forge-lint: disable-next-item(unused-return)
        PENDLE_ROUTER.swapExactSyForPt(
            address(this),
            MARKET,
            SY.balanceOf(address(this)),
            amountIn - ptHeld,
            IPendleRouterV4.ApproxParams({
                guessMin: 0,
                guessMax: type(uint256).max,
                guessOffchain: 0,
                maxIteration: 256,
                eps: 1e14
            }),
            IPendleRouterV4.LimitOrderData({
                limitRouter: address(0),
                epsSkipMarket: 0,
                normalFills: new IPendleRouterV4.FillOrderParams[](0),
                flashFills: new IPendleRouterV4.FillOrderParams[](0),
                optData: ""
            })
        );
    }

    /// @inheritdoc ITakerCallbacks
    function preTransferOutCallback(address, address, address, address, uint256, uint256, bytes32, bytes calldata)
        external
        pure
    {
        revert UnexpectedCallback();
    }
}

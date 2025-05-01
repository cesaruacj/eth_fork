// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// Fees
uint24 constant FEE_LOW = 1000;      // 0.05% 
uint24 constant FEE_MEDIUM = 3000;   // 0.3%
uint24 constant FEE_HIGH = 10000;    // 1%

// Interfaces para Uniswap V2
interface IUniswapV2Router02 {
    function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts);
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);
}

// Interfaces para Uniswap V3
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IQuoterV2 {
    function quoteExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint160 sqrtPriceLimitX96
    ) external returns (uint256 amountOut, uint160, uint32, uint256);
}

// Interfaces para UniswapV4
interface IUniswapV4Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint256 deadline;
        bytes hookData;
    }
    
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IUniswapV4Quoter {
    function quoteExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        bytes memory hookData
    ) external returns (uint256 amountOut);
}

// Interfaces para PancakeSwap
interface IPancakeRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IPancakeQuoter {
    function quoteExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint160 sqrtPriceLimitX96
    ) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate);
}

// Interfaces para Balancer
interface IBalancerVault {
    enum SwapKind { GIVEN_IN, GIVEN_OUT }
    
    struct SingleSwap {
        bytes32 poolId;
        SwapKind kind;
        address assetIn;
        address assetOut;
        uint256 amount;
        bytes userData;
    }
    
    struct FundManagement {
        address sender;
        bool fromInternalBalance;
        address recipient;
        bool toInternalBalance;
    }
    
    function swap(
        SingleSwap memory singleSwap,
        FundManagement memory funds,
        uint256 limit,
        uint256 deadline
    ) external payable returns (uint256 amountCalculated);
    
    function getPoolTokens(bytes32 poolId) external view 
        returns (address[] memory tokens, uint256[] memory balances, uint256 lastChangeBlock);
}

// Interfaces para Curve
interface ICurveAddressProvider {
    function get_registry() external view returns (address);
    function get_address(uint256 id) external view returns (address);
}

interface ICurveRegistry {
    function get_pool_from_lp_token(address lp) external view returns (address);
    function get_coins(address pool) external view returns (address[8] memory);
    function get_underlying_coins(address pool) external view returns (address[8] memory);
    function get_exchange_rate(address pool) external view returns (uint256);
}

interface ICurveRouter {
    function get_best_rate(
        address from, 
        address to, 
        uint256 amount
    ) external view returns (address, uint256);
    
    function exchange(
        address _pool,
        address _from,
        address _to,
        uint256 _amount,
        uint256 _expected,
        address _receiver
    ) external payable returns (uint256);
}

// Interface for SolidlyRouter (base interface for many forks)
interface ISolidlyRouter {
    function getAmountOut(
        uint amountIn,
        address tokenIn,
        address tokenOut
    ) external view returns (uint);
    
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);
}

// Interface for KyberSwap Classic
interface IKyberClassicRouter {
    function getExpectedRateAfterFee(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 feeInPrecision
    ) external view returns (uint256 expectedRate);
    
    function swapTokenToToken(
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 minConversionRate
    ) external returns (uint256 destAmount);
}

// Interface for KyberSwap Elastic (similar to Uniswap V3)
interface IKyberElasticRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 minAmountOut;
        uint160 sqrtPriceLimitX96;
    }
    
    function swapExactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

// Interface for MaverickV2
interface IMaverickRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        address pool;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint256 sqrtPriceLimitD18;
    }
    
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IMaverickQuoter {
    function quoteExactInputSingle(
        address tokenIn,
        address tokenOut,
        address pool,
        uint256 amountIn,
        uint256 sqrtPriceLimitD18
    ) external returns (uint256 amountOut);
}

contract DexAggregator {
    using SafeERC20 for IERC20;

    // Extended DexType enum to include all DEXes
    enum DexType { 
        UniswapV2,    // 0
        UniswapV3,    // 1
        UniswapV4,    // 2
        SushiSwapV2,  // 3
        SushiSwapV3,  // 4
        PancakeSwapV2,// 5
        PancakeSwapV3,// 6
        Balancer,     // 7
        Curve,        // 8
        MaverickV2,   // 9
        // Additional DEXes
        Antfarm      // 10
        Apeswap,     // 11
        DefiSwap,    // 12
        Elkfinance,  // 13
        Ethervista,  // 14
        Fraxswap,   // 15
        Hopeswap,   // 16
        KyberClassic, // 17
        KyberElastic, // 18
        Radioshack,  // 19
        Saitaswap,   // 20
        Sakeswap,     // 21
        Shibaswap,    // 22
        Smardex,      // 23
        Solidly,      // 24
        Swapr,        // 25
        Verse,       // 26
        X7Finance,   // 27

    }

    struct DexInfo {
        DexType dexType;
        address router; 
        address quoter; // Optional quoter contract for V3-like DEXes
        bool active;
    }
    
    struct ArbitragePath {
        address[] tokens;      // La ruta completa de tokens [tokenA, tokenB, tokenC, ..., tokenA]
        uint256[] dexIndices;  // Qué DEX usar para cada paso
        uint24[] fees;         // Fees para Uniswap V3 (0 para V2)
    }

    address public owner;
    address public defaultQuoterV3;  // Default quoter for V3 DEXes
    
    DexInfo[] public dexes;

    // Caché de cotizaciones para gas-optimization
    mapping(bytes32 => uint256) public lastQuotes;
    mapping(bytes32 => uint256) public quoteTimestamps;

    // Helper mapping to categorize DEX types
    mapping(DexType => bool) public isV2Like;
    mapping(DexType => bool) public isV3Like;

    // Events
    event DexAdded(uint256 indexed index, DexType dexType, address router, address quoter);
    event DexStatusChanged(uint256 indexed index, bool active);
    event SwapExecuted(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, uint256 dexIndex);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(address _defaultQuoterV3) {
        owner = msg.sender;
        defaultQuoterV3 = _defaultQuoterV3;
        
        // Initialize categorization of DEX types
        setupDexCategories();
    }

    // Setup categorizations for DEX types
    function setupDexCategories() private {
        // V2-like interfaces
        isV2Like[DexType.UniswapV2] = true;
        isV2Like[DexType.SushiSwapV2] = true;
        isV2Like[DexType.PancakeSwapV2] = true;
        isV2Like[DexType.Sakeswap] = true;
        isV2Like[DexType.Ethervista] = true;
        isV2Like[DexType.X7Finance] = true;
        isV2Like[DexType.Hopeswap] = true;
        isV2Like[DexType.Defiswap] = true;
        isV2Like[DexType.Saitaswap] = true;
        isV2Like[DexType.Radioshack] = true;
        isV2Like[DexType.Verse] = true;
        isV2Like[DexType.Fraxswap] = true;
        isV2Like[DexType.Smardex] = true;
        isV2Like[DexType.Elkfinance] = true;
        isV2Like[DexType.Swapr] = true;
        isV2Like[DexType.Apeswap] = true;
        isV2Like[DexType.Antfarm] = true;
        isV2Like[DexType.Solidly] = true;

        // V3-like interfaces
        isV3Like[DexType.UniswapV3] = true;
        isV3Like[DexType.UniswapV4] = true;
        isV3Like[DexType.SushiSwapV3] = true;
        isV3Like[DexType.Shibaswap] = true;
        isV3Like[DexType.PancakeSwapV3] = true;
        isV3Like[DexType.KyberElastic] = true;
    }

    function addDex(DexType _dexType, address _router, address _quoter) external onlyOwner {
        if (_quoter == address(0) && isV3Like[_dexType]) {
            _quoter = defaultQuoterV3; // Use default quoter if none provided for V3-like DEXes
        }
        
        dexes.push(DexInfo({
            dexType: _dexType,
            router: _router,
            quoter: _quoter,
            active: true
        }));
        
        emit DexAdded(dexes.length - 1, _dexType, _router, _quoter);
    }

    function setDexActive(uint256 index, bool _active) external onlyOwner {
        require(index < dexes.length, "Index out of range");
        dexes[index].active = _active;
        emit DexStatusChanged(index, _active);
    }

    /**
     * @dev Gets the best quote for a swap between two tokens
     */
    function getBestDexQuote(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) external view returns (uint256 bestAmountOut, uint256 bestDexIndex) {
        bestAmountOut = 0;
        bestDexIndex = 0;
        
        for (uint256 i = 0; i < dexes.length; i++) {
            if (!dexes[i].active) continue;
            
            uint256 amountOut = getQuoteFromDex(i, tokenIn, tokenOut, amountIn);
            
            if (amountOut > bestAmountOut) {
                bestAmountOut = amountOut;
                bestDexIndex = i;
            }
        }
    }

    /**
     * @dev Gets a quote from a specific DEX
     */
    function getQuoteFromDex(
        uint256 dexIndex,
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) public view returns (uint256 amountOut) {
        require(dexIndex < dexes.length, "Invalid dex index");
        DexInfo memory dex = dexes[dexIndex];
        
        // V2-like DEXes (UniswapV2, SushiSwapV2, etc.)
        if (isV2Like[dex.dexType]) {
            IUniswapV2Router02 router = IUniswapV2Router02(dex.router);
            address[] memory path = new address[](2);
            path[0] = tokenIn;
            path[1] = tokenOut;
            
            try router.getAmountsOut(amountIn, path) returns (uint256[] memory amounts) {
                return amounts[1];
            } catch {
                return 0;
            }
        }
        // Solidly-based DEXes
        else if (dex.dexType == DexType.Solidly) {
            ISolidlyRouter router = ISolidlyRouter(dex.router);
            
            try router.getAmountOut(amountIn, tokenIn, tokenOut) returns (uint256 amount) {
                return amount;
            } catch {
                return 0;
            }
        }
        // KyberClassic
        else if (dex.dexType == DexType.KyberClassic) {
            IKyberClassicRouter router = IKyberClassicRouter(dex.router);
            
            try router.getExpectedRateAfterFee(tokenIn, tokenOut, amountIn, 0) returns (uint256 rate) {
                return (amountIn * rate) / 1e18;
            } catch {
                return 0;
            }
        }
        // V3-like DEXes require an off-chain quoter, return 0 here
        // as quotes can't be reliably obtained in view functions
        return 0;
    }

    /**
     * @dev Gets the price of one token in terms of another from a specific DEX
     */
    function getTokenPrice(
        address token1,
        address token2,
        uint8 dexType
    ) external view returns (uint256) {
        require(uint256(dexType) < dexes.length, "Invalid DEX type");
        require(dexes[dexType].active, "DEX not active");
        
        // Use existing getQuoteFromDex with 1 token as input amount (10^18 wei)
        return getQuoteFromDex(dexType, token1, token2, 10**18);
    }

    /**
     * @dev Executes a swap on a specific DEX
     */
    function swapOnDex(
        uint256 dexIndex,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 slippageTolerance // in basis points: 100 = 1%
    ) public returns (uint256 amountOut) {
        require(dexIndex < dexes.length, "Invalid dex index");
        DexInfo memory dex = dexes[dexIndex];
        require(dex.active, "DEX not active");
        
        // Get balance before swap
        uint256 balanceBefore = IERC20(tokenOut).balanceOf(address(this));
        
        // V2-like DEXes (UniswapV2, SushiSwapV2, etc.)
        if (isV2Like[dex.dexType]) {
            amountOut = _swapOnV2Dex(dex, tokenIn, tokenOut, amountIn, slippageTolerance);
        }
        // UniswapV3
        else if (dex.dexType == DexType.UniswapV3) {
            amountOut = _swapOnV3Dex(dex, tokenIn, tokenOut, amountIn, slippageTolerance, FEE_MEDIUM);
        }
        // PancakeSwapV3
        else if (dex.dexType == DexType.PancakeSwapV3) {
            amountOut = _swapOnPancakeV3Dex(dex, tokenIn, tokenOut, amountIn, slippageTolerance, FEE_MEDIUM);
        }
        // UniswapV4
        else if (dex.dexType == DexType.UniswapV4) {
            amountOut = _swapOnV4Dex(dex, tokenIn, tokenOut, amountIn, slippageTolerance);
        }
        // Balancer
        else if (dex.dexType == DexType.Balancer) {
            amountOut = _swapOnBalancerDex(dex, tokenIn, tokenOut, amountIn, slippageTolerance);
        }
        // Curve
        else if (dex.dexType == DexType.Curve) {
            amountOut = _swapOnCurveDex(dex, tokenIn, tokenOut, amountIn, slippageTolerance);
        }
        // KyberClassic
        else if (dex.dexType == DexType.KyberClassic) {
            amountOut = _swapOnKyberClassicDex(dex, tokenIn, tokenOut, amountIn, slippageTolerance);
        }
        // KyberElastic (similar to UniswapV3)
        else if (dex.dexType == DexType.KyberElastic) {
            amountOut = _swapOnKyberElasticDex(dex, tokenIn, tokenOut, amountIn, slippageTolerance, FEE_MEDIUM);
        }
        // MaverickV2
        else if (dex.dexType == DexType.MaverickV2) {
            amountOut = _swapOnMaverickV2Dex(dex, tokenIn, tokenOut, amountIn, slippageTolerance);
        }
        // Solidly
        else if (dex.dexType == DexType.Solidly) {
            amountOut = _swapOnSolidlyDex(dex, tokenIn, tokenOut, amountIn, slippageTolerance);
        }
        
        // Calculate received amount
        uint256 balanceAfter = IERC20(tokenOut).balanceOf(address(this));
        uint256 actualAmountOut = balanceAfter - balanceBefore;
        
        emit SwapExecuted(tokenIn, tokenOut, amountIn, actualAmountOut, dexIndex);
        
        return actualAmountOut;
    }

    // Helper functions for different DEX types
    function _swapOnV2Dex(
        DexInfo memory dex, 
        address tokenIn, 
        address tokenOut, 
        uint256 amountIn, 
        uint256 slippageTolerance
    ) internal returns (uint256) {
        IUniswapV2Router02 router = IUniswapV2Router02(dex.router);
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;
        
        // Calculate minimum acceptable amount with slippage
        uint256[] memory amounts = router.getAmountsOut(amountIn, path);
        uint256 amountOutMin = (amounts[1] * (10000 - slippageTolerance)) / 10000;
        
        // Approve router to spend tokens
        IERC20(tokenIn).safeApprove(address(router), 0); // Clear previous allowance
        IERC20(tokenIn).safeApprove(address(router), amountIn);
        
        // Execute swap
        router.swapExactTokensForTokens(
            amountIn,
            amountOutMin,
            path,
            address(this),
            block.timestamp + 300 // 5 minutes deadline
        );
        
        return amounts[1]; // Return the expected amount
    }

    function _swapOnV3Dex(
        DexInfo memory dex, 
        address tokenIn, 
        address tokenOut, 
        uint256 amountIn, 
        uint256 slippageTolerance,
        uint24 fee
    ) internal returns (uint256) {
        ISwapRouter router = ISwapRouter(dex.router);
        
        // Estimate expected output
        uint256 amountOutMin = estimateV3Output(tokenIn, tokenOut, fee, amountIn, dex.quoter);
        amountOutMin = (amountOutMin * (10000 - slippageTolerance)) / 10000;
        
        // Approve router to spend tokens
        IERC20(tokenIn).safeApprove(address(router), 0); // Clear previous allowance
        IERC20(tokenIn).safeApprove(address(router), amountIn);
        
        // Construct parameters for swap
        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee,
            recipient: address(this),
            deadline: block.timestamp + 300,
            amountIn: amountIn,
            amountOutMinimum: amountOutMin,
            sqrtPriceLimitX96: 0
        });
        
        // Execute swap
        return router.exactInputSingle(params);
    }

    function _swapOnPancakeV3Dex(
        DexInfo memory dex, 
        address tokenIn, 
        address tokenOut, 
        uint256 amountIn, 
        uint256 slippageTolerance,
        uint24 fee
    ) internal returns (uint256) {
        IPancakeRouter router = IPancakeRouter(dex.router);
        
        // Get expected amount
        uint256 amountOutMin = 0;
        if (dex.quoter != address(0)) {
            try IPancakeQuoter(dex.quoter).quoteExactInputSingle(
                tokenIn, tokenOut, fee, amountIn, 0
            ) returns (uint256 amountOut, uint160, uint32, uint256) {
                amountOutMin = (amountOut * (10000 - slippageTolerance)) / 10000;
            } catch {
                // Use 1 as a fallback if quote fails
                amountOutMin = 1;
            }
        } else {
            // No quoter available, use minimum safeguard
            amountOutMin = 1;
        }
        
        // Approve router to spend tokens
        IERC20(tokenIn).safeApprove(address(router), 0);
        IERC20(tokenIn).safeApprove(address(router), amountIn);
        
        // Construct parameters for swap
        IPancakeRouter.ExactInputSingleParams memory params = IPancakeRouter.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee,
            recipient: address(this),
            deadline: block.timestamp + 300,
            amountIn: amountIn,
            amountOutMinimum: amountOutMin,
            sqrtPriceLimitX96: 0
        });
        
        // Execute swap
        return router.exactInputSingle(params);
    }

    function _swapOnV4Dex(
        DexInfo memory dex, 
        address tokenIn, 
        address tokenOut, 
        uint256 amountIn, 
        uint256 slippageTolerance
    ) internal returns (uint256) {
        IUniswapV4Router router = IUniswapV4Router(dex.router);
        
        // Get expected amount
        uint256 expectedOut = 0;
        if (dex.quoter != address(0)) {
            try IUniswapV4Quoter(dex.quoter).quoteExactInputSingle(
                tokenIn, tokenOut, amountIn, ""
            ) returns (uint256 quoted) {
                expectedOut = quoted;
            } catch {
                expectedOut = 0;
            }
        }
        
        uint256 amountOutMin = expectedOut > 0 
            ? (expectedOut * (10000 - slippageTolerance)) / 10000 
            : 1;
        
        // Approve router to spend tokens
        IERC20(tokenIn).safeApprove(address(router), 0);
        IERC20(tokenIn).safeApprove(address(router), amountIn);
        
        // Construct parameters for swap
        IUniswapV4Router.ExactInputSingleParams memory params = IUniswapV4Router.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            recipient: address(this),
            amountIn: amountIn,
            amountOutMinimum: amountOutMin,
            deadline: block.timestamp + 300,
            hookData: ""
        });
        
        // Execute swap
        return router.exactInputSingle(params);
    }

    function _swapOnBalancerDex(
        DexInfo memory dex, 
        address tokenIn, 
        address tokenOut, 
        uint256 amountIn, 
        uint256 slippageTolerance
    ) internal returns (uint256) {
        IBalancerVault vault = IBalancerVault(dex.router);
        
        // For a real implementation, we would need to query for or store the correct poolId
        // For now, using a hardcoded value that would be replaced in production
        bytes32 poolId = 0x0000000000000000000000000000000000000000000000000000000000000000;
        
        bool hasTokenIn = false;
        bool hasTokenOut = false;
        
        // Check if pool contains both tokens
        try vault.getPoolTokens(poolId) returns (address[] memory tokens, uint256[] memory, uint256) {
            for (uint i = 0; i < tokens.length; i++) {
                if (tokens[i] == tokenIn) hasTokenIn = true;
                if (tokens[i] == tokenOut) hasTokenOut = true;
            }
            require(hasTokenIn && hasTokenOut, "Pool does not contain required tokens");
        } catch {
            revert("Unable to query pool tokens");
        }
        
        // Approve vault to spend tokens
        IERC20(tokenIn).safeApprove(address(vault), 0);
        IERC20(tokenIn).safeApprove(address(vault), amountIn);
        
        // Construct parameters for swap
        IBalancerVault.SingleSwap memory singleSwap = IBalancerVault.SingleSwap({
            poolId: poolId,
            kind: IBalancerVault.SwapKind.GIVEN_IN,
            assetIn: tokenIn,
            assetOut: tokenOut,
            amount: amountIn,
            userData: ""
        });
        
        IBalancerVault.FundManagement memory funds = IBalancerVault.FundManagement({
            sender: address(this),
            fromInternalBalance: false,
            recipient: payable(address(this)),
            toInternalBalance: false
        });
        
        // Set the limit as the minimum acceptable (with slippage)
        // In a real implementation, you'd calculate this based on expected output
        uint256 limit = 1;
        
        // Execute swap
        return vault.swap(singleSwap, funds, limit, block.timestamp + 300);
    }

    function _swapOnCurveDex(
        DexInfo memory dex, 
        address tokenIn, 
        address tokenOut, 
        uint256 amountIn, 
        uint256 slippageTolerance
    ) internal returns (uint256) {
        ICurveRouter router = ICurveRouter(dex.router);
        
        // Find the best pool and expected rate
        address bestPool;
        uint256 expectedOut;
        
        try router.get_best_rate(tokenIn, tokenOut, amountIn) returns (address pool, uint256 outAmount) {
            bestPool = pool;
            expectedOut = outAmount;
        } catch {
            revert("No Curve route available");
        }
        
        uint256 amountOutMin = (expectedOut * (10000 - slippageTolerance)) / 10000;
        
        // Approve router to spend tokens
        IERC20(tokenIn).safeApprove(address(router), 0);
        IERC20(tokenIn).safeApprove(address(router), amountIn);
        
        // Execute swap
        return router.exchange(
            bestPool,
            tokenIn,
            tokenOut,
            amountIn,
            amountOutMin,
            address(this)
        );
    }

    function _swapOnKyberClassicDex(
        DexInfo memory dex, 
        address tokenIn, 
        address tokenOut, 
        uint256 amountIn, 
        uint256 slippageTolerance
    ) internal returns (uint256) {
        IKyberClassicRouter router = IKyberClassicRouter(dex.router);
        
        // Get expected rate
        uint256 expectedRate;
        try router.getExpectedRateAfterFee(tokenIn, tokenOut, amountIn, 0) returns (uint256 rate) {
            expectedRate = rate;
        } catch {
            revert("Could not get Kyber rate");
        }
        
        // Calculate minimum acceptable rate with slippage
        uint256 minRate = (expectedRate * (10000 - slippageTolerance)) / 10000;
        
        // Approve router to spend tokens
        IERC20(tokenIn).safeApprove(address(router), 0);
        IERC20(tokenIn).safeApprove(address(router), amountIn);
        
        // Execute swap
        return router.swapTokenToToken(
            tokenIn,
            amountIn,
            tokenOut,
            minRate
        );
    }

    function _swapOnKyberElasticDex(
        DexInfo memory dex, 
        address tokenIn, 
        address tokenOut, 
        uint256 amountIn, 
        uint256 slippageTolerance,
        uint24 fee
    ) internal returns (uint256) {
        IKyberElasticRouter router = IKyberElasticRouter(dex.router);
        
        // For this example, we'll set a minimal amount out
        // In a real implementation, you'd use a proper quote
        uint256 amountOutMin = 1;
        
        // Approve router to spend tokens
        IERC20(tokenIn).safeApprove(address(router), 0);
        IERC20(tokenIn).safeApprove(address(router), amountIn);
        
        // Construct parameters for swap
        IKyberElasticRouter.ExactInputSingleParams memory params = IKyberElasticRouter.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee,
            recipient: address(this),
            deadline: block.timestamp + 300,
            amountIn: amountIn,
            minAmountOut: amountOutMin,
            sqrtPriceLimitX96: 0
        });
        
        // Execute swap
        return router.swapExactInputSingle(params);
    }

    function _swapOnMaverickV2Dex(
        DexInfo memory dex, 
        address tokenIn, 
        address tokenOut, 
        uint256 amountIn, 
        uint256 slippageTolerance
    ) internal returns (uint256) {
        IMaverickRouter router = IMaverickRouter(dex.router);
        
        // For MaverickV2, we need to know the specific pool address
        // In a real implementation, you would need to store or query this
        address poolAddress = address(0); // This needs to be set to the actual pool address
        
        // Get expected output if quoter is available
        uint256 expectedOut = 0;
        if (dex.quoter != address(0)) {
            try IMaverickQuoter(dex.quoter).quoteExactInputSingle(
                tokenIn, tokenOut, poolAddress, amountIn, 0
            ) returns (uint256 quoted) {
                expectedOut = quoted;
            } catch {
                // Continue with minimum amount if quote fails
            }
        }
        
        uint256 amountOutMin = expectedOut > 0 
            ? (expectedOut * (10000 - slippageTolerance)) / 10000 
            : 1;
        
        // Approve router to spend tokens
        IERC20(tokenIn).safeApprove(address(router), 0);
        IERC20(tokenIn).safeApprove(address(router), amountIn);
        
        // Construct parameters for swap
        IMaverickRouter.ExactInputSingleParams memory params = IMaverickRouter.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            pool: poolAddress,
            recipient: address(this),
            deadline: block.timestamp + 300,
            amountIn: amountIn,
            amountOutMinimum: amountOutMin,
            sqrtPriceLimitD18: 0
        });
        
        // Execute swap
        return router.exactInputSingle(params);
    }

    function _swapOnSolidlyDex(
        DexInfo memory dex, 
        address tokenIn, 
        address tokenOut, 
        uint256 amountIn, 
        uint256 slippageTolerance
    ) internal returns (uint256) {
        ISolidlyRouter router = ISolidlyRouter(dex.router);
        
        // Get expected output
        uint256 expectedOut;
        try router.getAmountOut(amountIn, tokenIn, tokenOut) returns (uint256 amount) {
            expectedOut = amount;
        } catch {
            revert("Could not get Solidly output amount");
        }
        
        uint256 amountOutMin = (expectedOut * (10000 - slippageTolerance)) / 10000;
        
        // Approve router to spend tokens
        IERC20(tokenIn).safeApprove(address(router), 0);
        IERC20(tokenIn).safeApprove(address(router), amountIn);
        
        // Create path for tokens
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;
        
        // Execute swap
        router.swapExactTokensForTokens(
            amountIn,
            amountOutMin,
            path,
            address(this),
            block.timestamp + 300
        );
        
        return expectedOut; // Return expected output
    }

    /**
     * @dev Estimates output for Uniswap V3 swap using the quoter
     */
    function estimateV3Output(
        address tokenIn,
        address tokenOut,
        uint24 fee, 
        uint256 amountIn,
        address quoter
    ) internal returns (uint256) {
        bytes32 quoteKey = keccak256(abi.encodePacked(tokenIn, tokenOut, fee, amountIn));
        
        // Check cache (valid for 3 blocks)
        if (quoteTimestamps[quoteKey] + 3 > block.number) {
            return lastQuotes[quoteKey];
        }

        if (quoter == address(0)) quoter = defaultQuoterV3;
        if (quoter == address(0)) return 1; // Return minimal amount if no quoter
        
        try IQuoterV2(quoter).quoteExactInputSingle(
            tokenIn,
            tokenOut,
            fee,
            amountIn,
            0 // No price limit
        ) returns (uint256 amountOut, uint160, uint32, uint256) {
            // Update cache
            lastQuotes[quoteKey] = amountOut;
            quoteTimestamps[quoteKey] = block.number;
            return amountOut;
        } catch {
            return 1; // Return minimal amount on failure
        }
    }
    
    /**
     * @dev Executes a complete arbitrage path
     * tokens[0] must equal tokens[tokens.length-1] to form a complete cycle
     */
    function executeArbitragePath(ArbitragePath calldata path, uint256 startAmount) external returns (uint256) {
        require(path.tokens.length >= 3, "Path too short");  
        require(path.tokens[0] == path.tokens[path.tokens.length-1], "Not a cycle");
        require(path.tokens.length - 1 == path.dexIndices.length, "Invalid path structure");
        require(path.dexIndices.length == path.fees.length, "Path lengths don't match");
        
        uint256 currentAmount = startAmount;
        
        // Transfer initial token to the contract
        IERC20(path.tokens[0]).safeTransferFrom(msg.sender, address(this), startAmount);
        
        // Execute the swap route
        for (uint i = 0; i < path.dexIndices.length; i++) {
            address tokenIn = path.tokens[i];
            address tokenOut = path.tokens[i+1];
            uint256 dexIndex = path.dexIndices[i];
            
            // Fee is ignored for non-V3 DEXes
            uint24 fee = path.fees[i];
            
            // Swap on the specific DEX
            if (dexes[dexIndex].dexType == DexType.UniswapV3) {
                currentAmount = _swapOnV3Dex(dexes[dexIndex], tokenIn, tokenOut, currentAmount, 100, fee);
            } else if (dexes[dexIndex].dexType == DexType.PancakeSwapV3) {
                currentAmount = _swapOnPancakeV3Dex(dexes[dexIndex], tokenIn, tokenOut, currentAmount, 100, fee);
            } else if (dexes[dexIndex].dexType == DexType.KyberElastic) {
                currentAmount = _swapOnKyberElasticDex(dexes[dexIndex], tokenIn, tokenOut, currentAmount, 100, fee);
            } else {
                // Standard swap for other DEX types
                currentAmount = swapOnDex(dexIndex, tokenIn, tokenOut, currentAmount, 100);
            }
        }
        
        // Transfer profits back to sender
        IERC20(path.tokens[0]).safeTransfer(msg.sender, currentAmount);
        
        return currentAmount;
    }
    
    // Recovery function for tokens trapped in case of error
    function rescueTokens(address token, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "Cannot send to zero address");
        IERC20(token).safeTransfer(to, amount);
    }
    
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "New owner is the zero address");
        owner = newOwner;
    }
    
    /**
     * @dev Returns the name of a DEX based on its type index
     * @param dexType The index of the DEX type
     * @return The name of the DEX
     */
    function getDexName(uint8 dexType) external view returns (string memory) {
        require(uint256(dexType) < 27, "Invalid DEX type");
        
        if (dexType == uint8(DexType.UniswapV2)) return "UniswapV2"; // 0
        if (dexType == uint8(DexType.UniswapV3)) return "UniswapV3"; // 1
        if (dexType == uint8(DexType.UniswapV4)) return "UniswapV4"; // 2
        if (dexType == uint8(DexType.SushiSwapV2)) return "SushiSwapV2"; // 3
        if (dexType == uint8(DexType.SushiSwapV3)) return "SushiSwapV3"; // 4
        if (dexType == uint8(DexType.PancakeSwapV2)) return "PancakeSwapV2"; // 5
        if (dexType == uint8(DexType.PancakeSwapV3)) return "PancakeSwapV3"; // 6
        if (dexType == uint8(DexType.Balancer)) return "Balancer"; // 7
        if (dexType == uint8(DexType.Curve)) return "Curve"; // 8
        if (dexType == uint8(DexType.MaverickV2)) return "MaverickV2"; // 9
        // Other dexes
        if (dexType == uint8(DexType.Antfarm)) return "Antfarm"; // 10
        if (dexType == uint8(DexType.Apeswap)) return "Apeswap"; // 11
        if (dexType == uint8(DexType.Defiswap)) return "Defiswap"; // 12
        if (dexType == uint8(DexType.Elkfinance)) return "Elkfinance"; // 13
        if (dexType == uint8(DexType.Ethervista)) return "Ethervista"; // 14
        if (dexType == uint8(DexType.Fraxswap)) return "Fraxswap"; // 15
        if (dexType == uint8(DexType.Hopeswap)) return "Hopeswap"; // 16
        if (dexType == uint8(DexType.KyberClassic)) return "KyberClassic"; // 17
        if (dexType == uint8(DexType.KyberElastic)) return "KyberElastic"; // 18
        if (dexType == uint8(DexType.Radioshack)) return "Radioshack"; // 19
        if (dexType == uint8(DexType.Saitaswap)) return "Saitaswap"; // 20
        if (dexType == uint8(DexType.Sakeswap)) return "Sakeswap"; // 21
        if (dexType == uint8(DexType.Shibaswap)) return "Shibaswap"; // 22
        if (dexType == uint8(DexType.Smardex)) return "Smardex"; // 23
        if (dexType == uint8(DexType.Solidly)) return "Solidly"; // 24
        if (dexType == uint8(DexType.Swapr)) return "Swapr"; // 25
        if (dexType == uint8(DexType.Verse)) return "Verse"; // 26
        if (dexType == uint8(DexType.X7Finance)) return "X7Finance"; // 27

        // Default case if no match found
        return "Unknown";
    }
    
    // For receiving ETH
    receive() external payable {}
}
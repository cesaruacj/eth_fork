// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// Fees
uint24 constant FEE_LOW = 1000;      // 0.05% 
uint24 constant FEE_MEDIUM = 3000; // Represents 0.3% fee tier for Uniswap V3
uint24 constant FEE_HIGH = 10000; // 1%

// Interfaces para Sushiswap
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

contract DexAggregator {
    using SafeERC20 for IERC20;

    // Update to include new DEX types
    enum DexType { UniswapV2, UniswapV3, SushiSwap, UniswapV4, PancakeSwap, Balancer, Curve }

    struct DexInfo {
        DexType dexType;
        address router; 
        bool active;
    }
    
    struct ArbitragePath {
        address[] tokens;      // La ruta completa de tokens [tokenA, tokenB, tokenC, ..., tokenA]
        uint256[] dexIndices;  // Qué DEX usar para cada paso
        uint24[] fees;         // Fees para Uniswap V3 (0 para V2)
    }

    address public owner;
    address public quoterV3;   // Para cotizaciones en Uniswap V3
    
    DexInfo[] public dexes;

    // Caché de cotizaciones para gas-optimization
    mapping(bytes32 => uint256) public lastQuotes;
    mapping(bytes32 => uint256) public quoteTimestamps;

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(address _quoterV3) {
        owner = msg.sender;
        quoterV3 = _quoterV3;
    }

    function addDex(DexType _dexType, address _router) external onlyOwner {
        dexes.push(DexInfo({
            dexType: _dexType,
            router: _router,
            active: true
        }));
    }

    function setDexActive(uint256 index, bool _active) external onlyOwner {
        require(index < dexes.length, "Index out of range");
        dexes[index].active = _active;
    }

    /**
     * @dev Obtiene la mejor cotización para un swap entre dos tokens.
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
            
            uint256 amountOut = 0;
            
            // UniswapV2, SushiSwap y otros compatibles con V2
            if (dexes[i].dexType == DexType.UniswapV2 || dexes[i].dexType == DexType.SushiSwap) {
                IUniswapV2Router02 router = IUniswapV2Router02(dexes[i].router);
                address[] memory path = new address[](2);
                path[0] = tokenIn;
                path[1] = tokenOut;
                
                try router.getAmountsOut(amountIn, path) returns (uint256[] memory amounts) {
                    amountOut = amounts[1];
                } catch {
                    continue;
                }
            }
            // UniswapV3 requiere un contrato de cotizador externo
            else if (dexes[i].dexType == DexType.UniswapV3) {
                // Para V3 normalmente usarías el quoter, pero aquí lo omitimos
                // porque es una llamada no-view y necesitaríamos un quoter simulado
                continue;
            }
            
            if (amountOut > bestAmountOut) {
                bestAmountOut = amountOut;
                bestDexIndex = i;
            }
        }
    }

    /**
     * @dev Ejecuta un swap en un DEX específico
     */
    function swapOnDex(
        uint256 dexIndex,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 slippageTolerance // en base points: 100 = 1%
    ) public returns (uint256 amountOut) {
        require(dexIndex < dexes.length, "Invalid dex index");
        DexInfo memory dex = dexes[dexIndex];
        require(dex.active, "DEX not active");
        
        // Obtener el saldo antes del swap
        uint256 balanceBefore = IERC20(tokenOut).balanceOf(address(this));
        
        // UniswapV2, SushiSwap
        if (dex.dexType == DexType.UniswapV2 || dex.dexType == DexType.SushiSwap) {
            IUniswapV2Router02 router = IUniswapV2Router02(dex.router);
            address[] memory path = new address[](2);
            path[0] = tokenIn;
            path[1] = tokenOut;
            
            // Calcular el mínimo aceptable con slippage
            uint256[] memory amounts = router.getAmountsOut(amountIn, path);
            uint256 amountOutMin = (amounts[1] * (10000 - slippageTolerance)) / 10000;
            
            // Aprobar al router para gastar tokens
            IERC20(tokenIn).safeApprove(address(router), amountIn);
            
            // Ejecutar el swap
            router.swapExactTokensForTokens(
                amountIn,
                amountOutMin,
                path,
                address(this),
                block.timestamp + 300 // 5 minutos de deadline
            );
        }
        // UniswapV3
        else if (dex.dexType == DexType.UniswapV3) {
            ISwapRouter router = ISwapRouter(dex.router);
            
            // Para V3 necesitaríamos determinar el fee óptimo
            uint24 fee = FEE_MEDIUM; // Default 0.3%
            
            // Estimación del mínimo que queremos recibir
            uint256 amountOutMin = estimateV3Output(tokenIn, tokenOut, fee, amountIn);
            amountOutMin = (amountOutMin * (10000 - slippageTolerance)) / 10000;
            
            // Aprobar al router para gastar tokens
            IERC20(tokenIn).safeApprove(address(router), amountIn);
            
            // Construir parámetros para el swap
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
            
            // Ejecutar swap
            router.exactInputSingle(params);
        }
        // UniswapV4
        else if (dex.dexType == DexType.UniswapV4) {
            IUniswapV4Router router = IUniswapV4Router(dex.router);
            IUniswapV4Quoter quoter = IUniswapV4Quoter(quoterV3); // You might need a separate quoterV4 variable
            
            // Get quote for expected amount
            uint256 expectedOut = 0;
            try quoter.quoteExactInputSingle(tokenIn, tokenOut, amountIn, "") returns (uint256 quoted) {
                expectedOut = quoted;
            } catch {
                expectedOut = 0;
            }
            
            uint256 amountOutMin = (expectedOut * (10000 - slippageTolerance)) / 10000;
            
            // Aprobar al router para gastar tokens
            IERC20(tokenIn).safeApprove(address(router), amountIn);
            
            // Construir parámetros para el swap
            IUniswapV4Router.ExactInputSingleParams memory params = IUniswapV4Router.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: amountOutMin,
                deadline: block.timestamp + 300,
                hookData: ""
            });
            
            // Ejecutar swap
            router.exactInputSingle(params);
        }
        // PancakeSwap
        else if (dex.dexType == DexType.PancakeSwap) {
            IPancakeRouter router = IPancakeRouter(dex.router);
            
            // Default fee
            uint24 fee = FEE_MEDIUM;
            
            // Get expected amount
            uint256 amountOutMin = 0;
            try IPancakeQuoter(quoterV3).quoteExactInputSingle(
                tokenIn, tokenOut, fee, amountIn, 0
            ) returns (uint256 amountOut, uint160, uint32, uint256) {
                amountOutMin = (amountOut * (10000 - slippageTolerance)) / 10000;
            } catch {
                // Use a fallback if quote fails
                amountOutMin = 1;
            }
            
            // Aprobar al router para gastar tokens
            IERC20(tokenIn).safeApprove(address(router), amountIn);
            
            // Construir parámetros para el swap
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
            
            // Ejecutar swap
            router.exactInputSingle(params);
        }
        // Balancer
        else if (dex.dexType == DexType.Balancer) {
            IBalancerVault vault = IBalancerVault(dex.router);
            
            // For simplicity, we'll use a hardcoded poolId in this example
            // In a real application, you would need to find the appropriate pool
            bytes32 poolId = 0x0000000000000000000000000000000000000000000000000000000000000000;
            
            // Try to find a suitable pool
            try vault.getPoolTokens(poolId) returns (address[] memory tokens, uint256[] memory, uint256) {
                bool hasTokenIn = false;
                bool hasTokenOut = false;
                for (uint i = 0; i < tokens.length; i++) {
                    if (tokens[i] == tokenIn) hasTokenIn = true;
                    if (tokens[i] == tokenOut) hasTokenOut = true;
                }
                require(hasTokenIn && hasTokenOut, "Pool does not contain required tokens");
            } catch {
                revert("Unable to query pool tokens");
            }
            
            // Aprobar al vault para gastar tokens
            IERC20(tokenIn).safeApprove(address(vault), amountIn);
            
            // Construir parámetros para el swap
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
            
            // El límite es el mínimo aceptable (con slippage)
            uint256 limit = 1; // En un caso real, deberías calcular esto
            
            // Ejecutar swap
            vault.swap(singleSwap, funds, limit, block.timestamp + 300);
        }
        // Curve
        else if (dex.dexType == DexType.Curve) {
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
            
            // Aprobar al router para gastar tokens
            IERC20(tokenIn).safeApprove(address(router), amountIn);
            
            // Ejecutar swap
            router.exchange(
                bestPool,
                tokenIn,
                tokenOut,
                amountIn,
                amountOutMin,
                address(this)
            );
        }
        
        // Calcular cantidad recibida
        uint256 balanceAfter = IERC20(tokenOut).balanceOf(address(this));
        amountOut = balanceAfter - balanceBefore;
        
        return amountOut;
    }
    
    /**
     * @dev Estima la salida para un swap en Uniswap V3 usando el quoter
     */
    function estimateV3Output(
        address tokenIn,
        address tokenOut,
        uint24 fee, 
        uint256 amountIn
    ) internal returns (uint256) {
        bytes32 quoteKey = keccak256(abi.encodePacked(tokenIn, tokenOut, fee, amountIn));
        
        // Check cache (valid for 3 blocks)
        if (quoteTimestamps[quoteKey] + 3 > block.number) {
            return lastQuotes[quoteKey];
        }

        if (quoterV3 == address(0)) return 0;
        
        try IQuoterV2(quoterV3).quoteExactInputSingle(
            tokenIn,
            tokenOut,
            fee,
            amountIn,
            0 // sin límite de precio
        ) returns (uint256 amountOut, uint160, uint32, uint256) {
            // Update cache
            lastQuotes[quoteKey] = amountOut;
            quoteTimestamps[quoteKey] = block.number;
            return amountOut;
        } catch {
            return 0;
        }
    }
    
    /**
     * @dev Ejecuta una ruta completa de arbitraje
     * tokens[0] debe ser igual a tokens[tokens.length-1] para formar un ciclo completo
     */
    function executeArbitragePath(ArbitragePath calldata path, uint256 startAmount) external returns (uint256) {
        require(path.tokens.length >= 3, "Path too short");  
        require(path.tokens[0] == path.tokens[path.tokens.length-1], "Not a cycle");
        require(path.tokens.length - 1 == path.dexIndices.length, "Invalid path structure");
        require(path.dexIndices.length == path.fees.length, "Path lengths don't match");
        
        uint256 currentAmount = startAmount;
        
        // Transferir el token inicial al contrato
        IERC20(path.tokens[0]).safeTransferFrom(msg.sender, address(this), startAmount);
        
        // Ejecutar la ruta de swaps
        for (uint i = 0; i < path.dexIndices.length; i++) {
            address tokenIn = path.tokens[i];
            address tokenOut = path.tokens[i+1];
            uint256 dexIndex = path.dexIndices[i];
            
            // Para V3 necesitaríamos usar el fee correspondiente
            // Para V2 es ignorado
            uint24 fee = path.fees[i];
            
            // Swap en el DEX específico
            if (dexes[dexIndex].dexType == DexType.UniswapV3) {
                // Aquí manejaríamos el caso especial de V3 con el fee
                // Por ahora lo simulamos con el método normal
                currentAmount = swapOnDexWithFee(dexIndex, tokenIn, tokenOut, currentAmount, 100, fee);
            } else {
                // Swap estándar para V2
                currentAmount = swapOnDex(dexIndex, tokenIn, tokenOut, currentAmount, 100);
            }
        }
        
        // Transferir las ganancias de vuelta al remitente
        IERC20(path.tokens[0]).safeTransfer(msg.sender, currentAmount);
        
        return currentAmount;
    }
    
    /**
     * @dev Versión especial de swapOnDex para Uniswap V3 con fee específico
     */
    function swapOnDexWithFee(
        uint256 dexIndex,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 slippageTolerance,
        uint24 fee
    ) internal returns (uint256) {
        require(dexes[dexIndex].dexType == DexType.UniswapV3, "Not a V3 DEX");
        
        ISwapRouter router = ISwapRouter(dexes[dexIndex].router);
        uint256 balanceBefore = IERC20(tokenOut).balanceOf(address(this));
        
        // Estimación del mínimo que queremos recibir
        uint256 amountOutMin = estimateV3Output(tokenIn, tokenOut, fee, amountIn);
        amountOutMin = (amountOutMin * (10000 - slippageTolerance)) / 10000;
        
        // Aprobar al router para gastar tokens
        IERC20(tokenIn).safeApprove(address(router), amountIn);
        
        // Construir parámetros para el swap
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
        
        // Ejecutar swap
        router.exactInputSingle(params);
        
        // Calcular cantidad recibida
        uint256 balanceAfter = IERC20(tokenOut).balanceOf(address(this));
        return balanceAfter - balanceBefore;
    }
    
    // Función de recuperación para tokens atrapados en caso de error
    function rescueTokens(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
    }
}
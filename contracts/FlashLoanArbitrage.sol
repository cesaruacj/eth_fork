// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IPoolAddressesProvider } from "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import { IPool } from "@aave/core-v3/contracts/interfaces/IPool.sol";
import { IFlashLoanSimpleReceiver } from "@aave/core-v3/contracts/flashloan/interfaces/IFlashLoanSimpleReceiver.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./DexAggregator.sol";

/**
 * @title FlashLoanArbitrage
 * @dev Optimizado para arbitraje con flashLoanSimple (un solo token, menor gas)
 */
contract FlashLoanArbitrage is Ownable, ReentrancyGuard, IFlashLoanSimpleReceiver {
    using SafeERC20 for IERC20;

    // Corregido: implementación correcta para IFlashLoanSimpleReceiver
    IPoolAddressesProvider public override ADDRESSES_PROVIDER;
    IPool public immutable POOL;

    /// @notice Agregador de DEXes para encontrar la mejor ruta
    DexAggregator public dexAggregator;

    /// @notice Mapea token → feed de precio Chainlink (opcional)
    mapping(address => address) public priceFeeds;

    /// @notice Modo de prueba: omite la verificación de rentabilidad
    bool public testMode = true;

    /// @notice Fee premium calculado desde el pool (cacheado para ahorrar gas)
    uint256 public flashLoanPremium;
    
    /// @notice Flag para prevenir ataques de reentrada específicos para flash loans
    bool private _flashLoanReentrancyGuard;

    /// @notice Evento que se emite tras cada arbitraje
    event ArbitrageExecuted(
        address indexed tokenIn,
        uint256 amountIn,
        uint256 receivedAmount,
        uint256 profit
    );

    /// @notice Lista de tokens intermediarios para arbitraje
    address[] public intermediaryTokens;

    /// @notice Evento de depuración para seguimiento de operaciones
    event DebugLog(string message, uint256 value);
    event DebugTokenPath(string operation, address baseToken, address quoteToken);
    event DebugTokenOperation(address token, uint256 amountBefore, uint256 amountAfter);
    event DebugExecuteOperation(string step, address asset, uint256 amount);
    event DebugSwapAttempt(uint256 dexIndex, address tokenIn, address tokenOut, uint256 amount);
    event DebugSwapResult(uint256 amountOut, bool success);
    event DebugArbitrageStep(string step, address token, uint256 amount);
    event DebugSwapCall(uint8 dexType, address tokenIn, address tokenOut, uint256 amountIn);
    event DebugMessage(string message); // Evento agregado para mensajes de depuración
    event DebugSwapFailure(string reason, uint256 dexIndex, address tokenIn, address tokenOut);
    event DebugBalanceCheck(string stage, address token, uint256 balance);
    event DebugApproval(address token, address spender, uint256 amount);

    /**
     * @dev Constructor initializes the contract with Aave provider and DexAggregator
     * @param provider Aave PoolAddressesProvider address
     * @param dexAggregatorAddress DexAggregator contract address
     */
    constructor(address provider, address payable dexAggregatorAddress) {
        ADDRESSES_PROVIDER = IPoolAddressesProvider(provider);
        POOL = IPool(ADDRESSES_PROVIDER.getPool());
        dexAggregator = DexAggregator(dexAggregatorAddress);
        
        // Cache the flash loan premium to save gas in future operations
        flashLoanPremium = POOL.FLASHLOAN_PREMIUM_TOTAL();
    }

    /**
     * @notice Get flash loan premium percentage (in basis points)
     * @return The current flash loan premium
     */
    function getFlashLoanPremium() external view returns (uint256) {
        return flashLoanPremium;
    }

    /**
     * @notice Updates the cached flash loan premium
     */
    function updateFlashLoanPremium() external {
        flashLoanPremium = POOL.FLASHLOAN_PREMIUM_TOTAL();
    }

    /**
     * @notice Inicia un flash loan simple (más eficiente en gas para un solo activo)
     * @param asset Token a pedir prestado
     * @param amount Cantidad
     */
    function executeFlashLoanSimple(address asset, uint256 amount) external {
        emit DebugArbitrageStep("Starting flash loan request", asset, amount);
        
        try POOL.flashLoanSimple(asset, amount, "", 0, address(this)) {
            emit DebugArbitrageStep("Flash loan initiated successfully", asset, amount);
        } catch Error(string memory reason) {
            emit DebugMessage(string(abi.encodePacked("Flash loan failed: ", reason)));
            revert(reason);
        }
    }

    /**
     * @dev Callback para flash loans simples - implementación de IFlashLoanSimpleReceiver
     * @param asset El token pedido en préstamo
     * @param amount La cantidad prestada
     * @param premium La comisión del flash loan
     * @param initiator La dirección que inició el flash loan
     * @param params Datos arbitrarios
     * @return true si la operación fue exitosa
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        emit DebugArbitrageStep("executeOperation called", asset, amount);
        
        emit DebugArbitrageStep("Operation started", asset, amount);
        
        require(msg.sender == address(POOL), "Caller must be Aave Pool");
        emit DebugLog("7. Caller es Pool", 0);
        
        require(initiator == address(this), "Initiator must be this contract");
        emit DebugLog("8. Initiator es this", 0);
        
        require(!_flashLoanReentrancyGuard, "Reentrant call");
        emit DebugLog("9. No es reentrada", 0);

        _flashLoanReentrancyGuard = true;

        uint256 amountOwing = amount + premium;
        emit DebugLog("10. AmountOwing", amountOwing);

        // Verificar premium
        uint256 currentBalance = IERC20(asset).balanceOf(address(this));
        emit DebugLog("11. Balance actual", currentBalance);
        
        require(
            IERC20(asset).balanceOf(address(this)) >= premium,
            "Insufficient premium"
        );
        emit DebugLog("12. Premium suficiente", premium);

        // Ejecutar arbitraje
        emit DebugLog("13. Antes de executeArbitrage", amount);
        (uint256 received, uint256 operationProfit) = _executeArbitrage(
            asset,
            amount,
            amountOwing
        );
        emit DebugLog("14. Despues de executeArbitrage", received);

        // Aprobar repago
        emit DebugLog("15. Antes de aprobar POOL", amountOwing);
        IERC20(asset).safeApprove(address(POOL), 0);
        IERC20(asset).safeApprove(address(POOL), amountOwing);
        emit DebugLog("16.Despues de aprobar POOL", 0);

        // Transferir ganancias
        uint256 remainingBalance = IERC20(asset).balanceOf(address(this));
        emit DebugLog("17. Balance restante", remainingBalance);
        
        if (remainingBalance > amountOwing) {
            uint256 transferProfit = remainingBalance - amountOwing;
            emit DebugLog("18. Profit a transferir", transferProfit);
            IERC20(asset).safeTransfer(msg.sender, transferProfit);
        }

        emit DebugLog("19. Final executeOperation", 0);
        _flashLoanReentrancyGuard = false;
        return true;
    }

    /**
     * @dev Lógica interna de arbitraje mejorada con más comprobaciones de seguridad
     * @param tokenIn Token a usar en el arbitraje
     * @param amountIn Cantidad a usar para el arbitraje
     * @param amountOwing Cantidad que debe devolverse incluyendo la comisión
     * @return receivedAmount Cantidad recibida después del swap
     * @return profit Beneficio neto de la operación
     */
    function _executeArbitrage(
        address tokenIn,
        uint256 amountIn,
        uint256 amountOwing
    ) internal returns (uint256 receivedAmount, uint256 profit) {
        emit DebugLog("20. Inicio _executeArbitrage", amountIn);
        
        require(intermediaryTokens.length > 0, "No intermediary tokens configured");
        emit DebugLog("21. Intermediary tokens OK", intermediaryTokens.length);
        
        uint256 initialBalance = IERC20(tokenIn).balanceOf(address(this));
        emit DebugLog("22. Initial balance", initialBalance);
        
        uint256 bestReceivedAmount = 0;
        address bestIntermediaryToken;
        uint256 bestFirstDexIndex;
        uint256 bestSecondDexIndex;
        uint256 bestMidAmountOut;
        
        // Find best path
        emit DebugLog("23. Searching paths", intermediaryTokens.length);
        for (uint256 i = 0; i < intermediaryTokens.length; i++) {
            address intermediaryToken = intermediaryTokens[i];
            
            // Skip if same
            if (intermediaryToken == tokenIn) continue;
            
            emit DebugTokenPath("24. Path check", tokenIn, intermediaryToken);
            
            // Get quotes
            (uint256 midAmountOut, uint256 firstDexIndex) = dexAggregator
                .getBestDexQuote(tokenIn, intermediaryToken, amountIn);
        
            emit DebugLog("25. First quote", midAmountOut);
            
            if (midAmountOut == 0) continue;
            
            (uint256 finalAmountOut, uint256 secondDexIndex) = dexAggregator
                .getBestDexQuote(intermediaryToken, tokenIn, midAmountOut);
        
            emit DebugLog("26. Second quote", finalAmountOut);
            
            if (finalAmountOut > bestReceivedAmount) {
                bestReceivedAmount = finalAmountOut;
                bestIntermediaryToken = intermediaryToken;
                bestFirstDexIndex = firstDexIndex;
                bestSecondDexIndex = secondDexIndex;
                bestMidAmountOut = midAmountOut;
                emit DebugLog("27. New best path", bestReceivedAmount);
            }
        }
        
        emit DebugLog("28. Best received amount", bestReceivedAmount);
        
        // Execute if profitable
        if (bestReceivedAmount > amountIn) {
            emit DebugLog("29. Path is profitable", bestReceivedAmount - amountIn);
            
            // First swap approval
            emit DebugLog("30. Before first approval", amountIn);
            IERC20(tokenIn).safeApprove(address(dexAggregator), 0);
            IERC20(tokenIn).safeApprove(address(dexAggregator), amountIn);
            
            // Execute first swap
            emit DebugLog("31. Before first swap", bestFirstDexIndex);
            uint256 balanceBeforeSwap1 = IERC20(bestIntermediaryToken).balanceOf(address(this));
            emit DebugLog("Before first swap with params", amountIn);
            emit DebugLog("Expected min output", (bestMidAmountOut * 995) / 1000);

            uint256 midAmount;
            try dexAggregator.swapOnDex(
                bestFirstDexIndex,
                tokenIn,
                bestIntermediaryToken,
                amountIn,
                (bestMidAmountOut * 995) / 1000
            ) returns (uint256 _midAmount) {
                midAmount = _midAmount;
                emit DebugLog("First swap successful", midAmount);
            } catch Error(string memory reason) {
                emit DebugSwapFailure(reason, bestFirstDexIndex, tokenIn, bestIntermediaryToken);
                emit DebugMessage(string(abi.encodePacked("First swap failed: ", reason)));
                revert(string(abi.encodePacked("First swap failed: ", reason)));
            } catch Panic(uint errorCode) {
                emit DebugSwapFailure("Panic", bestFirstDexIndex, tokenIn, bestIntermediaryToken);
                emit DebugLog("First swap panic", errorCode);
                revert(string(abi.encodePacked("First swap panic: ", errorCode)));
            } catch (bytes memory lowLevelData) {
                emit DebugSwapFailure("Low level failure", bestFirstDexIndex, tokenIn, bestIntermediaryToken);
                emit DebugMessage("First swap failed with low level error");
                revert("First swap failed with low level error");
            }
            uint256 balanceAfterSwap1 = IERC20(bestIntermediaryToken).balanceOf(address(this));
            emit DebugTokenOperation(bestIntermediaryToken, balanceBeforeSwap1, balanceAfterSwap1);
            emit DebugLog("32. After first swap", midAmount);
            
            // Second swap approval
            emit DebugLog("33. Before second approval", midAmount);
            IERC20(bestIntermediaryToken).safeApprove(address(dexAggregator), 0);
            IERC20(bestIntermediaryToken).safeApprove(address(dexAggregator), midAmount);
            
            // Ejecutar segundo swap
            emit DebugLog("34. Before second swap", bestSecondDexIndex);
            uint256 balanceBeforeSwap2 = IERC20(tokenIn).balanceOf(address(this));

            try dexAggregator.swapOnDex(
                bestSecondDexIndex,
                bestIntermediaryToken,
                tokenIn,
                midAmount,
                (bestReceivedAmount * 995) / 1000
            ) returns (uint256 _receivedAmount) {
                receivedAmount = _receivedAmount;
                emit DebugLog("Second swap successful", receivedAmount);
            } catch Error(string memory reason) {
                emit DebugLog("Second swap failed with reason", 0);
                emit DebugSwapFailure(reason, bestSecondDexIndex, bestIntermediaryToken, tokenIn);
                revert(reason);
            } catch {
                emit DebugLog("Second swap failed without reason", 0);
                emit DebugSwapFailure("Unknown error", bestSecondDexIndex, bestIntermediaryToken, tokenIn);
                revert("Second swap failed silently");
            }
            uint256 balanceAfterSwap2 = IERC20(tokenIn).balanceOf(address(this));
            emit DebugTokenOperation(tokenIn, balanceBeforeSwap2, balanceAfterSwap2);
            emit DebugLog("35. After second swap", receivedAmount);
        } else {
            emit DebugLog("29b. No profitable path found", bestReceivedAmount);
        }
        
        // Calculate final profit
        uint256 finalBalance = IERC20(tokenIn).balanceOf(address(this));
        emit DebugLog("36. Final balance", finalBalance);
        
        uint256 netGain = 0;
        if (finalBalance > initialBalance) {
            netGain = finalBalance - initialBalance;
            emit DebugLog("37. Net gain positive", netGain);
        }
        
        profit = netGain > amountOwing ? netGain - amountOwing : 0;
        emit DebugLog("38. Final profit", profit);
        
        return (receivedAmount, profit);
    }

    /**
     * @notice Setup all DEXes from addresses.ts
     * This populates the DexAggregator with all supported DEXes
     */
    function setupAllDexes() external onlyOwner {
        // Ensure we have a valid DexAggregator
        require(address(dexAggregator) != address(0), "DexAggregator not set");
        
        // Add all major DEXes with their appropriate types and addresses
        
        // UniswapV2
        dexAggregator.addDex(DexAggregator.DexType.UniswapV2, 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D, address(0));
        // UniswapV3
        dexAggregator.addDex(DexAggregator.DexType.UniswapV3, 0xE592427A0AEce92De3Edee1F18E0157C05861564, 0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6);
        // UniswapV4
        dexAggregator.addDex(DexAggregator.DexType.UniswapV4, 0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af, 0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203);
        // SushiSwapV2
        dexAggregator.addDex(DexAggregator.DexType.SushiSwapV2, 0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F, address(0));
        // SushiSwapV3
        dexAggregator.addDex(DexAggregator.DexType.SushiSwapV3, 0x2E6cd2d30aa43f40aa81619ff4b6E0a41479B13F, address(0));
        // PancakeSwapV2
        dexAggregator.addDex(DexAggregator.DexType.PancakeSwapV2, 0xEfF92A263d31888d860bD50809A8D171709b7b1c, address(0));
        // PancakeSwapV3
        dexAggregator.addDex(DexAggregator.DexType.PancakeSwapV3, 0x1b81D678ffb9C0263b24A97847620C99d213eB14, 0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997);
        // Balancer
        dexAggregator.addDex(DexAggregator.DexType.Balancer, 0xbA1333333333a1BA1108E8412f11850A5C319bA9, address(0));
        // Curve
        dexAggregator.addDex(DexAggregator.DexType.Curve, 0x16C6521Dff6baB339122a0FE25a9116693265353, address(0));
        // MaverickV2
        dexAggregator.addDex(DexAggregator.DexType.MaverickV2, 0x62e31802c6145A2D5E842EeD8efe01fC224422fA, 0xb40AfdB85a07f37aE217E7D6462e609900dD8D7A);
        // Additional DEXes using UniswapV2 interface
        dexAggregator.addDex(DexAggregator.DexType.Antfarm, 0x6D9f0eb21D77C6d24bE49a579508471E937D5418, address(0));
        dexAggregator.addDex(DexAggregator.DexType.Apeswap, 0x5f509a3C3F16dF2Fba7bF84dEE1eFbce6BB85587, address(0));
        dexAggregator.addDex(DexAggregator.DexType.Defiswap, 0xCeB90E4C17d626BE0fACd78b79c9c87d7ca181b3, address(0));
        dexAggregator.addDex(DexAggregator.DexType.Elkfinance, 0xb5e9F6C58f548CeE53257304e287b23757eFFCA1, address(0));
        dexAggregator.addDex(DexAggregator.DexType.Ethervista, 0xCEDd366065A146a039B92Db35756ecD7688FCC77, address(0));
        dexAggregator.addDex(DexAggregator.DexType.Fraxswap, 0xC14d550632db8592D1243Edc8B95b0Ad06703867, address(0));
        dexAggregator.addDex(DexAggregator.DexType.Hopeswap, 0x219Bd2d1449F3813c01204EE455D11B41D5051e9, address(0));
        dexAggregator.addDex(DexAggregator.DexType.KyberClassic, 0x51E8D106C646cA58Caf32A47812e95887C071a62, address(0));
        dexAggregator.addDex(DexAggregator.DexType.KyberElastic, 0xF9c2b5746c946EF883ab2660BbbB1f10A5bdeAb4, address(0));
        dexAggregator.addDex(DexAggregator.DexType.Radioshack, 0x3e445e3280C5747a188DB8d0aB7762838A50E4ff, address(0));
        dexAggregator.addDex(DexAggregator.DexType.Saitaswap, 0x549EFb3c8365F3f222aaA44D9af7894CdAfFF083, address(0));
        dexAggregator.addDex(DexAggregator.DexType.Sakeswap, 0x9C578b573EdE001b95d51a55A3FAfb45f5608b1f, address(0));
        dexAggregator.addDex(DexAggregator.DexType.Shibaswap, 0x03f7724180AA6b939894B5Ca4314783B0b36b329, address(0));
        dexAggregator.addDex(DexAggregator.DexType.Smardex, 0xC33984ABcAe20f47a754eF78f6526FeF266c0C6F, address(0));
        dexAggregator.addDex(DexAggregator.DexType.Swapr, 0xB9960d9bcA016e9748bE75dd52F02188B9d0829f, address(0));
        dexAggregator.addDex(DexAggregator.DexType.Solidly, 0x77784f96C936042A3ADB1dD29C91a55EB2A4219f, address(0));
        dexAggregator.addDex(DexAggregator.DexType.Verse, 0xB4B0ea46Fe0E9e8EAB4aFb765b527739F2718671, address(0));
    }

    /**
     * @notice Setup intermediary tokens for arbitrage
     */
    function setupIntermediaryTokens() external onlyOwner {
        // Clear existing tokens
        delete intermediaryTokens;
        
        // Add major AAVE tokens (most liquid ones first for gas efficiency)
        intermediaryTokens.push(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2); // WETH
        intermediaryTokens.push(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48); // USDC
        intermediaryTokens.push(0x6B175474E89094C44Da98b954EedeAC495271d0F); // DAI
        intermediaryTokens.push(0xdAC17F958D2ee523a2206206994597C13D831ec7); // USDT
        intermediaryTokens.push(0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599); // WBTC
        intermediaryTokens.push(0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9); // AAVE
        intermediaryTokens.push(0x514910771AF9Ca656af840dff83E8264EcF986CA); // LINK
        intermediaryTokens.push(0xBe9895146f7AF43049ca1c1AE358B0541Ea49704); // cbETH
        intermediaryTokens.push(0x5f98805A4E8be255a32880FDeC7F6728C6568bA0); // LUSD
        intermediaryTokens.push(0xD533a949740bb3306d119CC777fa900bA034cd52); // CRV
        intermediaryTokens.push(0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2); // MKR
        intermediaryTokens.push(0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F); // SNX
        intermediaryTokens.push(0xba100000625a3754423978a60c9317c58a424e3D); // BAL
        intermediaryTokens.push(0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984); // UNI
        intermediaryTokens.push(0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32); // LDO
        intermediaryTokens.push(0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72); // ENS
        intermediaryTokens.push(0x111111111117dC0aa78b770fA6A738034120C302); // 1INCH
        intermediaryTokens.push(0x853d955aCEf822Db058eb8505911ED77F175b99e); // FRAX
        intermediaryTokens.push(0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f); // GHO
        intermediaryTokens.push(0xD33526068D116cE69F19A9ee46F0bd304F21A51f); // RPL
        intermediaryTokens.push(0x83F20F44975D03b1b09e64809B757c47f942BEeA); // sDAI
        intermediaryTokens.push(0xAf5191B0De278C7286d6C7CC6ab6BB8A73bA2Cd6); // STG
        intermediaryTokens.push(0x29483d288845Aa883693cFF207cD02B828B6177C); // KNC
        intermediaryTokens.push(0x3432B6A60D23Ca0dFCa7761B7ab56459D9C964D0); // FXS
        intermediaryTokens.push(0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E); // crvUSD
        intermediaryTokens.push(0x6c3ea9036406852006290770BEdFcAbA0e23A0e8); // PYUSD
        intermediaryTokens.push(0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee); // weETH
        intermediaryTokens.push(0xf1C9acDc66974dFB6dEcB12aA385b9cD01190E38); // osETH
        intermediaryTokens.push(0x9D39A5DE30e57443BfF2A8307A4256c8797A3497); // sUSDe
        intermediaryTokens.push(0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf); // cbBTC
        intermediaryTokens.push(0xdC035D45d973E3EC169d2276DDab16f1e407384F); // USDS
        intermediaryTokens.push(0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7); // rsETH
        intermediaryTokens.push(0x8236a87084f8B84306f72007F36F2618A5634494); // LBTC

    }

    // Fix this function to handle payable address
    function setDexAggregator(address payable _dexAggregator) external onlyOwner {
        require(_dexAggregator != address(0), "Invalid DEX aggregator address");
        dexAggregator = DexAggregator(_dexAggregator);
    }

    // Funciones administrativas (mantener como estaban)
    function setPriceFeed(address token, address feed) external onlyOwner {
        require(token != address(0), "Invalid token address");
        priceFeeds[token] = feed;
    }

    function setTestMode(bool enabled) external onlyOwner {
        testMode = enabled;
    }
    
    function rescueTokens(address token, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "Cannot send to zero address");
        IERC20(token).safeTransfer(to, amount);
    }
    
    function rescueETH(address payable to, uint256 amount) external onlyOwner {
        require(to != address(0), "Cannot send to zero address");
        (bool success, ) = to.call{value: amount}("");
        require(success, "ETH transfer failed");
    }
    
    receive() external payable {}
}

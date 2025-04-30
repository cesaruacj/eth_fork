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
    function executeFlashLoanSimple(address asset, uint256 amount) external onlyOwner {
        require(amount > 0, "Amount must be greater than 0");
        require(asset != address(0), "Invalid asset address");
        
        POOL.flashLoanSimple(
            address(this),
            asset,
            amount,
            "",
            0
        );
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
        require(msg.sender == address(POOL), "Caller must be Aave Pool");
        require(initiator == address(this), "Initiator must be this contract");
        require(!_flashLoanReentrancyGuard, "Reentrant call");

        _flashLoanReentrancyGuard = true;

        uint256 amountOwing = amount + premium;

        // Verificar que tenemos al menos el premium pre-fondeado
        require(
            IERC20(asset).balanceOf(address(this)) >= premium,
            "Insufficient premium"
        );

        // Ejecutar la lógica de arbitraje interna
        (uint256 received, uint256 operationProfit) = _executeArbitrage(
            asset,
            amount,
            amountOwing
        );

        // Aprobar a Aave Pool para que retire amount + premium
        IERC20(asset).safeApprove(address(POOL), 0); // Limpiar aprobación previa
        IERC20(asset).safeApprove(address(POOL), amountOwing);

        // Transferir cualquier ganancia restante al propietario
        uint256 remainingBalance = IERC20(asset).balanceOf(address(this));
        if (remainingBalance > amountOwing) {
            uint256 transferProfit = remainingBalance - amountOwing;
            IERC20(asset).safeTransfer(msg.sender, transferProfit);
        }

        emit ArbitrageExecuted(asset, amount, received, operationProfit);
        
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
        // Registrar saldo inicial para cálculo preciso del beneficio
        uint256 initialBalance = IERC20(tokenIn).balanceOf(address(this));
        
        // 1. Obtener mejor cotización
        (uint256 bestAmountOut, uint256 bestDexIndex) = dexAggregator
            .getBestDexQuote(tokenIn, tokenIn, amountIn);

        // 2. Verificar rentabilidad (si no estamos en modo test)
        if (!testMode) {
            // Calcular salida mínima esperada con 0.5% de buffer para slippage
            uint256 minExpectedOutput = amountOwing + (amountOwing * 5 / 1000);
            
            require(
                bestAmountOut >= minExpectedOutput,
                "Opportunity not profitable"
            );
        }

        // 3. Ejecutar swap con 0.5% de tolerancia al slippage
        uint256 minAmountOut = (bestAmountOut * 995) / 1000;
        
        // Restablecer aprobación antes de swapear
        IERC20(tokenIn).safeApprove(address(dexAggregator), 0);
        IERC20(tokenIn).safeApprove(address(dexAggregator), amountIn);
        
        receivedAmount = dexAggregator.swapOnDex(
            bestDexIndex,
            tokenIn,
            tokenIn,
            amountIn,
            minAmountOut
        );

        // 4. Calcular ganancia neta (tras devolver amountOwing) de forma más precisa
        uint256 finalBalance = IERC20(tokenIn).balanceOf(address(this));
        uint256 netGain = 0;
        
        // Calcular ganancia neta, teniendo en cuenta el saldo inicial
        if (finalBalance > initialBalance) {
            netGain = finalBalance - initialBalance;
        }
        
        profit = netGain > amountOwing ? netGain - amountOwing : 0;
        
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
        
        // SushiSwapV2
        dexAggregator.addDex(DexAggregator.DexType.SushiSwapV2, 0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F, address(0));
        
        // UniswapV4
        dexAggregator.addDex(DexAggregator.DexType.UniswapV4, 0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af, 0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203);
        
        // PancakeSwapV2
        dexAggregator.addDex(DexAggregator.DexType.PancakeSwapV2, 0xEfF92A263d31888d860bD50809A8D171709b7b1c, address(0));
        
        // PancakeSwapV3
        dexAggregator.addDex(DexAggregator.DexType.PancakeSwapV3, 0x1b81D678ffb9C0263b24A97847620C99d213eB14, 0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997);
        
        // Balancer
        dexAggregator.addDex(DexAggregator.DexType.Balancer, 0xbA1333333333a1BA1108E8412f11850A5C319bA9, address(0));
        
        // Curve
        dexAggregator.addDex(DexAggregator.DexType.Curve, 0x16C6521Dff6baB339122a0FE25a9116693265353, address(0));
        
        // KyberClassic - Fixed checksum
        dexAggregator.addDex(DexAggregator.DexType.KyberClassic, 0x51E8D106C646cA58Caf32A47812e95887C071a62, address(0));
        
        // KyberElastic - Fixed checksum
        dexAggregator.addDex(DexAggregator.DexType.KyberElastic, 0xF9c2b5746c946EF883ab2660BbbB1f10A5bdeAb4, address(0));
        
        // Additional DEXes using UniswapV2 interface
        dexAggregator.addDex(DexAggregator.DexType.Shibaswap, 0x03f7724180AA6b939894B5Ca4314783B0b36b329, address(0));
        dexAggregator.addDex(DexAggregator.DexType.Sakeswap, 0x9C578b573EdE001b95d51a55A3FAfb45f5608b1f, address(0));
        dexAggregator.addDex(DexAggregator.DexType.Ethervista, 0xCEDd366065A146a039B92Db35756ecD7688FCC77, address(0));
        dexAggregator.addDex(DexAggregator.DexType.X7Finance, 0x6b5422D584943BC8Cd0E10e239d624c6fE90fbB8, address(0));
        dexAggregator.addDex(DexAggregator.DexType.Hopeswap, 0x219Bd2d1449F3813c01204EE455D11B41D5051e9, address(0));
        dexAggregator.addDex(DexAggregator.DexType.Defiswap, 0xCeB90E4C17d626BE0fACd78b79c9c87d7ca181b3, address(0));
        dexAggregator.addDex(DexAggregator.DexType.Saitaswap, 0x549EFb3c8365F3f222aaA44D9af7894CdAfFF083, address(0));
        dexAggregator.addDex(DexAggregator.DexType.Radioshack, 0x3e445e3280C5747a188DB8d0aB7762838A50E4ff, address(0));
        dexAggregator.addDex(DexAggregator.DexType.Verse, 0xB4B0ea46Fe0E9e8EAB4aFb765b527739F2718671, address(0));
        dexAggregator.addDex(DexAggregator.DexType.Fraxswap, 0xC14d550632db8592D1243Edc8B95b0Ad06703867, address(0));
        dexAggregator.addDex(DexAggregator.DexType.Smardex, 0xC33984ABcAe20f47a754eF78f6526FeF266c0C6F, address(0));
        dexAggregator.addDex(DexAggregator.DexType.Elkfinance, 0xb5e9F6C58f548CeE53257304e287b23757eFFCA1, address(0));
        dexAggregator.addDex(DexAggregator.DexType.Swapr, 0xB9960d9bcA016e9748bE75dd52F02188B9d0829f, address(0));
        dexAggregator.addDex(DexAggregator.DexType.Apeswap, 0x5f509a3C3F16dF2Fba7bF84dEE1eFbce6BB85587, address(0));
        dexAggregator.addDex(DexAggregator.DexType.Antfarm, 0x6D9f0eb21D77C6d24bE49a579508471E937D5418, address(0));
        dexAggregator.addDex(DexAggregator.DexType.Solidly, 0x77784f96C936042A3ADB1dD29C91a55EB2A4219f, address(0));
        
        // MaverickV2
        dexAggregator.addDex(DexAggregator.DexType.MaverickV2, 0x62e31802c6145A2D5E842EeD8efe01fC224422fA, 0xb40AfdB85a07f37aE217E7D6462e609900dD8D7A);
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

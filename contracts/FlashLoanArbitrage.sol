// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

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
    constructor(address provider, address dexAggregatorAddress) {
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
        (uint256 received, uint256 profit) = _executeArbitrage(
            asset,
            amount,
            amountOwing
        );

        // Aprobar a Aave Pool para que retire amount + premium
        IERC20(asset).safeApprove(address(POOL), 0); // Limpiar aprobación previa
        IERC20(asset).safeApprove(address(POOL), amountOwing);

        emit ArbitrageExecuted(asset, amount, received, profit);
        
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
     * @notice Arbitraje directo sin flash loan, optimizado para seguridad y eficiencia
     * @param tokenIn Token que deposita el usuario
     * @param amountIn Cantidad depositada
     * @return profit Ganancia neta enviada al usuario
     */
    function executeDirectArbitrage(address tokenIn, uint256 amountIn)
        external
        nonReentrant
        returns (uint256)
    {
        // [Mantén esta función como estaba, es correcta]
        require(tokenIn != address(0), "Invalid token");
        require(amountIn > 0, "Amount must be greater than 0");
        
        // Resto del código igual...
        uint256 balanceBefore = IERC20(tokenIn).balanceOf(address(this));
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 initialBalance = IERC20(tokenIn).balanceOf(address(this));
        
        uint256 actualAmountIn = initialBalance - balanceBefore;
        require(actualAmountIn > 0, "No tokens received");

        (uint256 bestAmountOut, uint256 bestDexIndex) = dexAggregator
            .getBestDexQuote(tokenIn, tokenIn, actualAmountIn);

        IERC20(tokenIn).safeApprove(address(dexAggregator), 0);
        IERC20(tokenIn).safeApprove(address(dexAggregator), actualAmountIn);
        
        uint256 received = dexAggregator.swapOnDex(
            bestDexIndex,
            tokenIn,
            tokenIn,
            actualAmountIn,
            (bestAmountOut * 995) / 1000
        );

        uint256 finalBalance = IERC20(tokenIn).balanceOf(address(this));
        uint256 profit = finalBalance > initialBalance
            ? finalBalance - initialBalance
            : 0;

        IERC20(tokenIn).safeTransfer(msg.sender, finalBalance - balanceBefore);
        
        emit ArbitrageExecuted(tokenIn, actualAmountIn, received, profit);
        return profit;
    }

    // Funciones administrativas (mantener como estaban)
    function setDexAggregator(address _dexAggregator) external onlyOwner {
        require(_dexAggregator != address(0), "Invalid DEX aggregator address");
        dexAggregator = DexAggregator(_dexAggregator);
    }

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

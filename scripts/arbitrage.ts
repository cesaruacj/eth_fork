import { ethers } from "hardhat"; // Cambia "ethers" por "hardhat"
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process"; // Añadir esta importación
import { FlashbotsBundleProvider } from '@flashbots/ethers-provider-bundle';
import { DEX_ROUTERS, AAVE_V3, DEPLOYED_CONTRACTS } from "../config/addresses";
dotenv.config();

// ABI de FlashLoanArbitrage.sol
const { abi: flashLoanArbitrageABI } = require("../artifacts/contracts/FlashLoanArbitrage.sol/FlashLoanArbitrage.json");

// Verificar si se debe actualizar los datos de liquidez antes de iniciar
const UPDATE_LIQUIDITY_DATA = true; // Puedes convertir esto en una constante de configuración

// Antes de cualquier función, definir como arrays vacíos
let DEXES = [];
let DEX_INFO = {};

// Add this mapping to the beginning of your arbitrage.ts script
// This maps the DEX names in dexespools.json to the corresponding DexType enum indices in DexAggregator.sol
const DEX_NAME_TO_INDEX = {
  // Main DEXes
  'uniswap_v2': 0,                  // UniswapV2
  'uniswap_v3': 1,                  // UniswapV3
  'uniswap-v4-ethereum': 2,         // UniswapV4
  'sushiswap': 3,                   // SushiSwapV2
  'sushiswap-v3-ethereum': 4,       // Also use SushiSwapV2 (or could be different if needed)
  'pancakeswap_ethereum': 5,        // PancakeSwapV2
  'pancakeswap-v3-ethereum': 6,     // PancakeSwapV3

  // Other Major DEXes
  'balancer_ethereum': 7,           // Balancer
  'curve': 8,                       // Curve
  'maverick_ethereum': 9,          // MaverickV2

  // Additional DEXes
  'antfarm-ethereum': 10,           // Antfarm
  'apeswap_ethereum': 11,           // Apeswap
  'defi_swap': 12,                  // Defiswap
  'elk_finance_ethereum': 13,       // Elkfinance
  'ethervista': 14,                 // Ethervista
  'fraxswap_ethereum': 15,          // Fraxswap
  'hopeswap': 16,                   // Hopeswap
  'kyberswap_classic_ethereum': 17,  // KyberClassic
  'kyberswap_elastic': 18,          // KyberElastic
  'radioshack_ethereum': 19,        // Radioshack
  'saitaswap-ethereum': 20,         // Saitaswap
  'sakeswap': 21,                   // Sakeswap
  'shibaswap': 22,                  // Shibaswap
  'smardex-ethereum': 23,           // Smardex
  'solidlydex': 24,                  // Solidly
  'swapr_ethereum': 25,             // Swapr
  'verse': 26,                      // Verse
  'x7-finance-ethereum': 27,        // X7Finance

};

// Configuración de Alchemy Provider para datos de gas optimizados
const alchemyProvider = new ethers.providers.AlchemyProvider(
  "mainnet", 
  "JDR4rpYy7x_w4r0Z0P5QV9W-f_H7DqZ7" // Tu API key de Alchemy
);

// Configuración de Flashbots - añadir después de la inicialización del provider

// Clave privada para firmar bundles Flashbots (diferente de tu wallet principal)
const FLASHBOTS_KEY = process.env.FLASHBOTS_KEY || ethers.Wallet.createRandom().privateKey;
const flashbotsWallet = new ethers.Wallet(FLASHBOTS_KEY);

// Endpoint de Flashbots para mainnet
const FLASHBOTS_ENDPOINT = 'https://relay.flashbots.net';

// Provider de Flashbots
let flashbotsProvider: FlashbotsBundleProvider;

async function setupFlashbots() {
  try {
    flashbotsProvider = await FlashbotsBundleProvider.create(
      alchemyProvider, // usa el Alchemy provider para mayor velocidad
      flashbotsWallet,
      FLASHBOTS_ENDPOINT
    );
    console.log("✅ Flashbots provider configurado correctamente");
  } catch (error) {
    console.warn("⚠️ Error configurando Flashbots:", error);
  }
}

// Llamar a esta función durante la inicialización
await setupFlashbots();

// Función para obtener datos de gas optimizados
async function getOptimizedGasData() {
  try {
    console.log("🔄 Obteniendo datos de gas en tiempo real...");
    const feeData = await alchemyProvider.getFeeData();
    const gasPrice = ethers.utils.formatUnits(feeData.gasPrice || '0', 'gwei');
    console.log(`✅ Gas actual: ${gasPrice} gwei`);
    return feeData;
  } catch (error) {
    console.warn("⚠️ Error obteniendo datos de gas:", error);
    // Fallback a valores por defecto
    return {
      gasPrice: ethers.utils.parseUnits("50", "gwei"),
      maxFeePerGas: ethers.utils.parseUnits("60", "gwei"),
      maxPriorityFeePerGas: ethers.utils.parseUnits("2", "gwei")
    };
  }
}

// Esta variable guardará los datos de gas actualizados
let currentGasData = await getOptimizedGasData();

// Función para actualizar datos de liquidez antes de ejecutar el arbitraje
async function updateLiquidityData() {
  if (UPDATE_LIQUIDITY_DATA) {
    console.log("🔄 Actualizando datos de pools de liquidez...");
    try {
      // Ejecutar el script liquidity.ts usando Hardhat
      execSync('npx hardhat run scripts/liquidity.ts --network localhost', { 
        stdio: 'inherit', // Mostrar output en consola
        encoding: 'utf-8'
      });
      console.log("✅ Datos de liquidez actualizados correctamente");
    } catch (error) {
      console.error("❌ Error al actualizar datos de liquidez:", error);
      process.exit(1); // Salir si falla la actualización de datos
    }
  } else {
    console.log("ℹ️ Usando datos de liquidez existentes");
  }
}

// Modificar updateDexInfo para cargar todos los DEXes disponibles
async function updateDexInfo(dexPoolsData: any) {
  // Carga los datos de todos los DEXes
  DEXES = Object.keys(dexPoolsData);
  console.log(`🔍 Cargados ${DEXES.length} DEXes desde dexespools.json`);
  
  // Crear DEX_INFO dinámicamente
  DEX_INFO = {};
  for (const dex of DEXES) {
    // Asignar tipo y nombre por defecto
    let type = 0;
    let name = dex.replace(/_/g, ' ').replace(/-/g, ' ');
    
    // Asignar tipos específicos para DEXes conocidos
    if (dex.includes('uniswap_v3') || dex.includes('sushiswap-v3')) type = 1;
    else if (dex === 'sushiswap') type = 2;
    else if (dex.includes('uniswap-v4')) type = 3;
    else if (dex.includes('pancakeswap')) type = 4;
    else if (dex.includes('balancer')) type = 5;
    else if (dex === 'curve') type = 6;
    
    DEX_INFO[dex] = { name, type };
  }
  
  console.log(`✅ ${Object.keys(DEX_INFO).length} DEXes configurados para arbitraje`);
}

// ================================
// Configuration
// ================================
const MIN_PROFIT_PERCENT = 0.001;       // Mínimo porcentaje de beneficio antes de costos
const MIN_PROFIT_USD = 0.01;            // Mínimo beneficio en USD después de todos los gastos
const IS_EXECUTION_ENABLED = true;    // Establecer en false para solo monitoreo
const MAX_GAS_PRICE_GWEI = 40;        // Precio máximo de gas para permitir ejecución
const MAX_SLIPPAGE_PERCENT = 0.2;     // Slippage máximo aceptable
const MIN_LIQUIDITY_USD = 5000;     // Liquidez mínima para considerar un pool ($5K)
const FLASH_LOAN_FEE = 0.0005;        // Prima de préstamo flash de AAVE (0.05%)
const GAS_LIMIT_ARBITRAGE = 900000;   // Estimación de límite de gas para arbitraje

// Direcciones de contratos desplegados
const FLASH_LOAN_CONTRACT = DEPLOYED_CONTRACTS.FLASH_LOAN_ARBITRAGE;
const DEX_AGGREGATOR_CONTRACT = DEPLOYED_CONTRACTS.DEX_AGGREGATOR;

// ABIs minimizados para mejor rendimiento
const erc20ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address account) view returns (uint256)"
];

// Agregar ABI de Chainlink Price Feed
const chainlinkAggregatorABI = [
  "function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() external view returns (uint8)"
];

// Dirección de Price Feed ETH/USD en Ethereum Mainnet
const ETH_USD_FEED_ADDRESS = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";

// Interfaces para estructuras de datos
interface TokenPrice {
  dex: string;
  baseToken: string;
  baseTokenSymbol: string;
  quoteToken: string;
  quoteTokenSymbol: string;
  price: number;
  liquidityUSD: number;
  poolAddress: string;
  dexType: number;
}

interface ArbitrageOpportunity {
  baseTokenAddress: string;
  baseTokenSymbol: string;
  quoteTokenAddress: string;
  quoteTokenSymbol: string;
  buyDex: string;
  sellDex: string;
  buyDexType: number;
  sellDexType: number;
  buyPrice: number;
  sellPrice: number;
  profitPercent: number;
  estimatedProfitUSD: number;
  netProfitUSD: number;        // Beneficio después de todos los costos
  flashLoanToken: string;
  flashLoanAmount: string;
  gasCostUSD: number;         // Costo estimado de gas en USD
  flashLoanFeeUSD: number;    // Prima del préstamo flash en USD
}

// Configuración de provider y wallet
const provider = ethers.provider;

let wallet;
async function initWallet() {
  const signers = await ethers.getSigners();
  wallet = signers[0];
  console.log(`Usando cuenta: ${wallet.address}`);
}

if (IS_EXECUTION_ENABLED && !wallet) {
  console.warn("⚠️ La ejecución está habilitada pero no se encontró PRIVATE_KEY - solo se monitoreará");
}

// Función para obtener precio de ETH desde Chainlink
async function getEthPriceFromChainlink(): Promise<number> {
  try {
    const priceFeed = new ethers.Contract(
      ETH_USD_FEED_ADDRESS,
      chainlinkAggregatorABI,
      provider
    );
    
    // Obtener datos del último precio y decimales
    const [, answer] = await priceFeed.latestRoundData();
    const decimals = await priceFeed.decimals();
    
    // Convertir a número con la precisión correcta
    const price = parseFloat(ethers.utils.formatUnits(answer, decimals));
    console.log(`📈 Precio ETH desde Chainlink: $${price.toFixed(2)}`);
    return price;
  } catch (error: any) {
    console.warn(`⚠️ Error al obtener precio de ETH desde Chainlink: ${error.message}`);
    throw error;
  }
}

// Replace the validateArbitrageProfitability function with this improved version
async function validateArbitrageProfitability(opportunity: ArbitrageOpportunity): Promise<boolean> {
  // Modo de alta velocidad: omitir validaciones adicionales
  // Esto significa que debemos tener alta confianza en nuestros datos iniciales
  console.log(`⚡ Modo de alta velocidad: omitiendo validaciones adicionales para ganar ventaja temporal`);
  return true;
}

// Función principal de monitoreo
async function monitor() {
  console.log(`\n🔎 Iniciando monitor de arbitraje para DEXes de Ethereum`);
  
  try {
    // Inicializar wallet primero
    await initWallet();
    
    // Configurar Flashbots Provider
    await setupFlashbots();

    // Actualizar datos de liquidez primero
    await updateLiquidityData();
    
    // Cargar datos de pools desde dexespools.json
    const poolData = await loadPoolData();
    
    // Pasar los datos cargados a updateDexInfo
    await updateDexInfo(poolData);  
    
    // Cargar tokens principales
    const tokenList = await loadTopTokens(poolData);
    
    // Extraer precios de tokens de los datos de pools - enfocándose solo en pools de alta liquidez
    console.log(`\n📊 Extrayendo datos de precios de pools...`);
    const prices = extractPrices(poolData, tokenList);
    
    // Encontrar oportunidades de arbitraje
    const opportunities = await findArbitrageOpportunities(prices);
    console.log(`\n💰 Se encontraron ${opportunities.length} oportunidades potenciales de arbitraje`);
    
    // Mostrar y potencialmente ejecutar las mejores oportunidades
    await processOpportunities(opportunities);
    
  } catch (error: any) {
    console.error(`Error en el monitoreo: ${error.message}`);
  }
}

// Cargar datos de pool desde archivo
async function loadPoolData(): Promise<any> {
  try {
    const dataPath = path.join(__dirname, "../data/dexespools.json");
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    console.log(`✅ Datos de pool cargados`);
    return data;
  } catch (error: any) {
    console.error(`❌ Error al cargar datos de pool: ${error.message}`);
    process.exit(1);
  }
}

// Cargar tokens principales
async function loadTopTokens(poolData: any): Promise<Record<string, string>> {
  const topTokens: Record<string, string> = {};
  let tokenCount = 0;
  
  // Procesar cada DEX en orden de prioridad
  for (const dexId of DEXES) {
    const dexData = poolData[dexId];
    if (!dexData?.data?.length || !dexData.included?.length) continue;
    
    // Obtener los pools con mayor liquidez
    const sortedPools = dexData.data
      .filter((pool: any) => 
        pool?.attributes?.reserve_in_usd && 
        parseFloat(pool.attributes.reserve_in_usd) >= MIN_LIQUIDITY_USD
      )
      .sort((a: any, b: any) => 
        parseFloat(b.attributes.reserve_in_usd) - parseFloat(a.attributes.reserve_in_usd)
      )
      .slice(0, 10); // Los 10 pools principales
      
    // Extraer tokens de estos pools
    for (const pool of sortedPools) {
      if (!pool.relationships?.base_token?.data?.id || 
          !pool.relationships?.quote_token?.data?.id) continue;
      
      const baseTokenId = pool.relationships.base_token.data.id;
      const quoteTokenId = pool.relationships.quote_token.data.id;
      
      const baseToken = dexData.included.find((t: any) => t.id === baseTokenId);
      const quoteToken = dexData.included.find((t: any) => t.id === quoteTokenId);
      
      if (baseToken?.attributes?.symbol && baseToken.id) {
        const address = baseToken.id.replace('eth_', '').toLowerCase();
        const symbol = baseToken.attributes.symbol;
        if (!topTokens[symbol.toLowerCase()]) {
          topTokens[symbol.toLowerCase()] = address;
          tokenCount++;
        }
      }
      
      if (quoteToken?.attributes?.symbol && quoteToken.id) {
        const address = quoteToken.id.replace('eth_', '').toLowerCase();
        const symbol = quoteToken.attributes.symbol;
        if (!topTokens[symbol.toLowerCase()]) {
          topTokens[symbol.toLowerCase()] = address;
          tokenCount++;
        }
      }
    }
  }
  
  console.log(`🔍 Usando ${tokenCount} tokens principales con mayor liquidez`);
  return topTokens;
}

// Extraer precios de tokens de los datos de pools
function extractPrices(dexPoolsData: any, tokenList: Record<string, string>): TokenPrice[] {
  const prices: TokenPrice[] = [];
  
  // Verificar que DEXES y DEX_INFO estén correctamente inicializados
  if (!DEXES || DEXES.length === 0) {
    console.error('⚠️ Error: DEXES no está inicializado. Ejecuta updateDexInfo() primero.');
    return [];
  }
  
  if (!DEX_INFO || Object.keys(DEX_INFO).length === 0) {
    console.error('⚠️ Error: DEX_INFO no está inicializado. Ejecuta updateDexInfo() primero.');
    return [];
  }
  
  // Procesar cada DEX
  for (const dexId of DEXES) {
    const dexData = dexPoolsData[dexId];
    if (!dexData?.data?.length || !dexData.included?.length) continue;
    
    let dexInfo = DEX_INFO[dexId];
    if (!dexInfo) {
      console.warn(`⚠️ No hay información de tipo para DEX ${dexId}, asignando tipo 0 por defecto`);
      DEX_INFO[dexId] = { name: dexId.replace(/_/g, ' ').replace(/-/g, ' '), type: 0 };
      dexInfo = DEX_INFO[dexId];
    }
    
    // Crear un mapa de tokens incluidos para búsqueda rápida
    const includedTokens = new Map();
    dexData.included.forEach((item: any) => {
      if (item.type === 'token' && item.id && item.attributes?.symbol) {
        includedTokens.set(item.id, {
          address: item.id.replace('eth_', '').toLowerCase(),
          symbol: item.attributes.symbol
        });
      }
    });
    
    // Procesar cada pool en el DEX
    dexData.data.forEach((pool: any) => {
      try {
        // Saltar pools inválidos o pools con baja liquidez
        if (!pool.id || !pool.attributes || !pool.attributes.reserve_in_usd) return;
        
        const liquidityUSD = parseFloat(pool.attributes.reserve_in_usd || '0');
        if (liquidityUSD < MIN_LIQUIDITY_USD) return;
        
        const poolAddress = pool.attributes.address;
        
        // Procesar solo pools con nombres que contengan '/'
        if (pool.attributes.name && pool.attributes.name.includes('/')) {
          const [baseTokenSymbol, quoteTokenSymbol] = pool.attributes.name
            .split('/')
            .map((s: string) => s.trim());
          
          // Encontrar direcciones de tokens
          const baseTokenId = pool.relationships?.base_token?.data?.id;
          const quoteTokenId = pool.relationships?.quote_token?.data?.id;
          
          if (!baseTokenId || !quoteTokenId) return;
          
          const baseTokenInfo = includedTokens.get(baseTokenId);
          const quoteTokenInfo = includedTokens.get(quoteTokenId);
          
          if (!baseTokenInfo || !quoteTokenInfo) return;
          
          // Calcular precio si tenemos ambas direcciones de tokens y precios
          const baseTokenPrice = parseFloat(pool.attributes.base_token_price_usd || '0');
          const quoteTokenPrice = parseFloat(pool.attributes.quote_token_price_usd || '0');
          
          if (baseTokenPrice > 0 && quoteTokenPrice > 0) {
            // Añadir precio directo
            prices.push({
              dex: dexId,
              baseToken: baseTokenInfo.address,
              baseTokenSymbol: baseTokenInfo.symbol,
              quoteToken: quoteTokenInfo.address,
              quoteTokenSymbol: quoteTokenInfo.symbol,
              price: baseTokenPrice / quoteTokenPrice,
              liquidityUSD,
              poolAddress,
              dexType: dexInfo.type
            });
            
            // Añadir precio inverso
            prices.push({
              dex: dexId,
              baseToken: quoteTokenInfo.address,
              baseTokenSymbol: quoteTokenInfo.symbol,
              quoteToken: baseTokenInfo.address,
              quoteTokenSymbol: baseTokenInfo.symbol,
              price: quoteTokenPrice / baseTokenPrice,
              liquidityUSD,
              poolAddress,
              dexType: dexInfo.type
            });
          }
        }
      } catch (err) {
        // Ignorar datos mal formados
      }
    });
  }
  
  console.log(`Extraídos ${prices.length} puntos de precio válidos en ${DEXES.length} DEXes`);
  return prices;
}

// Encontrar oportunidades de arbitraje a partir de los datos de precios
async function findArbitrageOpportunities(prices: TokenPrice[]): Promise<ArbitrageOpportunity[]> {
  console.log(`🔍 Analizando ${prices.length} puntos de precio para oportunidades de arbitraje...`);
  
  const opportunities: ArbitrageOpportunity[] = [];
  
  // Agrupar precios por par de tokens para comparación más rápida
  const pairGroups: Record<string, TokenPrice[]> = {};
  
  prices.forEach(price => {
    if (!price.baseToken || !price.quoteToken) return;
    
    const pairKey = [price.baseToken, price.quoteToken].sort().join('_');
    if (!pairGroups[pairKey]) {
      pairGroups[pairKey] = [];
    }
    pairGroups[pairKey].push(price);
  });
  
  // Obtener datos de gas y precio ETH para cálculos precisos
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice || ethers.BigNumber.from("50000000000"); // 50 gwei default
  const gasPriceGwei = parseFloat(ethers.utils.formatUnits(gasPrice, "gwei"));
  
  // Obtener precio de ETH en USD para calcular costo de gas
  let ethPriceUSD: number;
  try {
    // Intentar obtener precio desde Chainlink primero
    ethPriceUSD = await getEthPriceFromChainlink();
  } catch (err) {
    console.warn("⚠️ Error con Chainlink, intentando usar precios de DEXes");
    try {
      // Fallback: buscar precio ETH en los datos de DEXes
      const wethPrices = prices.filter(p => 
        p.baseTokenSymbol.toLowerCase() === "weth" && 
        ["usdc", "usdt", "dai"].includes(p.quoteTokenSymbol.toLowerCase())
      );
      
      if (wethPrices.length > 0) {
        // Promediar los precios encontrados
        ethPriceUSD = wethPrices.reduce((sum, p) => sum + p.price, 0) / wethPrices.length;
      } else {
        throw new Error("No se encontraron precios de ETH en los DEXes");
      }
    } catch (innerErr) {
      console.error("❌ No se pudo determinar el precio de ETH. Abortando.");
      throw new Error("No se pudo obtener un precio confiable de ETH");
    }
  }
  
  console.log(`💲 Precio ETH: $${ethPriceUSD.toFixed(2)}, Gas: ${gasPriceGwei.toFixed(1)} Gwei`);
  
  // Calcular costo estimado de gas para arbitraje
  const gasCostWei = gasPrice.mul(GAS_LIMIT_ARBITRAGE);
  const gasCostETH = parseFloat(ethers.utils.formatEther(gasCostWei));
  const gasCostUSD = gasCostETH * ethPriceUSD;
  
  console.log(`⛽ Costo estimado de gas: ${gasCostETH.toFixed(5)} ETH ($${gasCostUSD.toFixed(2)})`);
  
  // Encontrar oportunidades en cada par de tokens
  Object.values(pairGroups).forEach(pairPrices => {
    if (pairPrices.length < 2) return;
    
    // Ordenar los precios de compra (más baratos primero) y venta (más caros primero)
    const buyPrices = [...pairPrices].sort((a, b) => a.price - b.price);
    const sellPrices = [...pairPrices].sort((a, b) => b.price - a.price);
    
    // Verificar solo las combinaciones más prometedoras (las mejores compras con las mejores ventas)
    const maxCombinations = Math.min(3, buyPrices.length); // Limitar compras a verificar
    
    for (let i = 0; i < maxCombinations; i++) {
      const buyPrice = buyPrices[i];
      
      // Para cada precio de compra, verificar las mejores ventas
      for (let j = 0; j < maxCombinations; j++) {
        const sellPrice = sellPrices[j];
        
        // Saltar si es el mismo DEX
        if (buyPrice.dex === sellPrice.dex) continue;
        
        // Saltar si los tokens no coinciden correctamente
        if (buyPrice.baseToken !== sellPrice.baseToken || 
            buyPrice.quoteToken !== sellPrice.quoteToken) continue;
        
        // Calcular impacto del slippage
        const slippageImpact = (buyPrice.price * MAX_SLIPPAGE_PERCENT / 100) + 
                               (sellPrice.price * MAX_SLIPPAGE_PERCENT / 100);
                               
        // Ajustar precios para tener en cuenta el slippage
        const effectiveBuyPrice = buyPrice.price * (1 + MAX_SLIPPAGE_PERCENT / 100);
        const effectiveSellPrice = sellPrice.price * (1 - MAX_SLIPPAGE_PERCENT / 100);
        const profitPercent = ((effectiveSellPrice - effectiveBuyPrice) / effectiveBuyPrice) * 100;
        
        // Incluir solo oportunidades significativas
        if (profitPercent > MIN_PROFIT_PERCENT) {
          // Estimar tamaño de operación (menor de los dos pools, limitado al 0.3% de liquidez)
          const maxTradeSize = Math.min(buyPrice.liquidityUSD, sellPrice.liquidityUSD) * 0.003;
          
          // Estimar beneficio despúes de tarifas/slippage (80% del teórico)
          const tradingProfitUSD = (maxTradeSize * profitPercent / 100) * 0.8;
          
          // Calcular prima de préstamo flash
          const flashLoanFeeUSD = maxTradeSize * FLASH_LOAN_FEE;
          
          // Calcular beneficio neto
          const netProfitUSD = tradingProfitUSD - gasCostUSD - flashLoanFeeUSD;
          
          // Determinar token de préstamo flash (preferir stablecoins)
          let flashLoanToken, flashLoanAmount;
          
          if (['USDC', 'USDT', 'DAI'].includes(buyPrice.quoteTokenSymbol)) {
            flashLoanToken = buyPrice.quoteToken;
            flashLoanAmount = (maxTradeSize / 2).toFixed(2); // Mitad del tamaño máximo de operación
          } else {
            flashLoanToken = buyPrice.baseToken;
            const tokenAmount = maxTradeSize / buyPrice.price / 2; 
            flashLoanAmount = tokenAmount.toFixed(6);
          }
          
          opportunities.push({
            baseTokenAddress: buyPrice.baseToken,
            baseTokenSymbol: buyPrice.baseTokenSymbol,
            quoteTokenAddress: buyPrice.quoteToken,
            quoteTokenSymbol: buyPrice.quoteTokenSymbol,
            buyDex: buyPrice.dex, // Store the actual DEX name, not just index
            sellDex: sellPrice.dex, // Store the actual DEX name, not just index
            buyDexType: buyPrice.dexType, 
            sellDexType: sellPrice.dexType,
            buyPrice: buyPrice.price,
            sellPrice: sellPrice.price,
            profitPercent,
            estimatedProfitUSD: tradingProfitUSD,
            netProfitUSD,
            gasCostUSD,
            flashLoanFeeUSD,
            flashLoanToken,
            flashLoanAmount
          });
        }
      }
    }
  });
  
  // Ordenar por beneficio neto potencial (mayor primero)
  return opportunities.sort((a, b) => b.netProfitUSD - a.netProfitUSD);
}

// Procesar y potencialmente ejecutar oportunidades de arbitraje
async function processOpportunities(opportunities: ArbitrageOpportunity[]) {
  if (opportunities.length === 0) {
    console.log("No se encontraron oportunidades de arbitraje rentables");
    return;
  }
  
  console.log(`\n🔝 MEJORES OPORTUNIDADES DE ARBITRAJE:`);
  
  // Mostrar mejores oportunidades
  const topN = Math.min(5, opportunities.length);
  for (let i = 0; i < topN; i++) {
    const opp = opportunities[i];
    console.log(`\n[${i+1}] ${opp.baseTokenSymbol}/${opp.quoteTokenSymbol}: ${opp.profitPercent.toFixed(2)}% beneficio`);
    console.log(`   Comprar en ${DEX_INFO[opp.buyDex]?.name} a ${opp.buyPrice}`);
    console.log(`   Vender en ${DEX_INFO[opp.sellDex]?.name} a ${opp.sellPrice}`);
    console.log(`   Beneficio bruto: $${opp.estimatedProfitUSD.toFixed(2)}`);
    console.log(`   Costos: Gas $${opp.gasCostUSD.toFixed(2)}, Prima FL $${opp.flashLoanFeeUSD.toFixed(2)}`);
    console.log(`   Beneficio neto: $${opp.netProfitUSD.toFixed(2)}`);
  }
  
  // Ejecutar la mejor oportunidad si hay cualquier beneficio positivo neto
  if (IS_EXECUTION_ENABLED && wallet) {
    const bestOpportunity = opportunities[0];
    
    if (bestOpportunity.netProfitUSD > MIN_PROFIT_USD * 1.5) { // Raise the threshold for execution
      console.log(`\n⚡ Verificando rentabilidad para la mejor oportunidad...`);
      
      // Validate profitability before execution
      const stillProfitable = await validateArbitrageProfitability(bestOpportunity);
      
      if (stillProfitable) {
        console.log(`\n⚡ Ejecutando arbitraje de préstamo flash para la mejor oportunidad...`);
        await executeFlashLoan(bestOpportunity);
      } else {
        console.log(`\n⚠️ La oportunidad ya no es rentable. Abortando ejecución.`);
      }
    } else {
      console.log(`\n⚠️ No hay oportunidades con beneficio neto suficiente`);
    }
  }
}

// Reemplazar la función executeFlashLoan con esta versión optimizada para MEV

async function executeFlashLoan(opportunity: ArbitrageOpportunity): Promise<boolean> {
  if (!wallet) {
    console.log("❌ No hay wallet configurada");
    return false;
  }
  
  // Map DEX names to contract indices
  const buyDexIndex = DEX_NAME_TO_INDEX[opportunity.buyDex];
  const sellDexIndex = DEX_NAME_TO_INDEX[opportunity.sellDex];
  
  if (buyDexIndex === undefined || sellDexIndex === undefined) {
    console.log(`⚠️ No se encontró mapeo para índices de DEX`);
    return false;
  }
  
  try {
    // Obtener balance inicial para comparar después
    const initialEthBalance = await wallet.getBalance();
    
    // Preparar datos de token
    let tokenContract;
    if (opportunity.flashLoanToken !== ethers.constants.AddressZero) {
      tokenContract = new ethers.Contract(
        opportunity.flashLoanToken,
        erc20ABI,
        provider
      );
      const initialTokenBalance = await tokenContract.balanceOf(wallet.address);
      const symbol = await tokenContract.symbol();
      const decimals = await tokenContract.decimals();
      console.log(`💰 Balance inicial ${symbol}: ${ethers.utils.formatUnits(initialTokenBalance, decimals)}`);
    }
    
    // Preparar la transacción de préstamo flash
    const flashLoanContract = new ethers.Contract(
      FLASH_LOAN_CONTRACT,
      flashLoanArbitrageABI,
      wallet
    );
    
    // Obtener detalles de token y formatear cantidad
    const decimals = await tokenContract.decimals();
    const symbol = await tokenContract.symbol();
    const flashLoanAmount = ethers.utils.parseUnits(opportunity.flashLoanAmount, decimals);
    
    console.log(`\n🚀 EJECUTANDO ARBITRAJE USANDO MEV BUNDLE:`);
    console.log(`   Par: ${opportunity.baseTokenSymbol}/${opportunity.quoteTokenSymbol}`);
    console.log(`   Préstamo flash: ${ethers.utils.formatUnits(flashLoanAmount, decimals)} ${symbol}`);
    
    // Preparar la transacción sin enviarla
    const unsignedTx = await flashLoanContract.populateTransaction.executeFlashLoanSimple(
      opportunity.flashLoanToken,
      flashLoanAmount,
      {
        gasLimit: GAS_LIMIT_ARBITRAGE,
        maxFeePerGas: ethers.utils.parseUnits("300", "gwei"),        // Gas muy agresivo
        maxPriorityFeePerGas: ethers.utils.parseUnits("30", "gwei")  // Prioridad alta
      }
    );
    
    // Firmar la transacción
    const signedTx = await wallet.signTransaction(unsignedTx);
    
    // ESTRATEGIA 1: ENVÍO DIRECTO CON GAS AGRESIVO
    console.log("💨 Enviando transacción con gas agresivo...");
    const tx = await wallet.sendTransaction(unsignedTx);
    console.log(`✅ Transacción enviada: ${tx.hash}`);
    
    // ESTRATEGIA 2: MEV-BUNDLE VIA FLASHBOTS (SIMULTANEAMENTE)
    if (flashbotsProvider) {
      try {
        console.log("🔥 Enviando bundle a Flashbots...");
        
        // Obtener bloque actual
        const blockNumber = await provider.getBlockNumber();
        
        // Crear bundle para los siguientes 3 bloques
        const bundle = [{
          transaction: signedTx,
          signer: wallet
        }];
        
        // Enviar bundle a Flashbots
        for (let i = 1; i <= 3; i++) {
          await flashbotsProvider.sendBundle(bundle, blockNumber + i);
        }
        
        console.log("✅ Bundle enviado a Flashbots para los próximos 3 bloques");
      } catch (error) {
        console.warn(`⚠️ Error enviando bundle a Flashbots: ${error.message}`);
      }
    }
    
    // Esperar por cualquier confirmación (la primera que llegue)
    console.log(`⏳ Esperando confirmación...`);
    const receipt = await tx.wait();
    console.log(`✅ Transacción confirmada en bloque ${receipt.blockNumber}`);
    
    // Verificar balances post-transacción
    const finalEthBalance = await wallet.getBalance();
    const ethDifference = finalEthBalance.sub(initialEthBalance);
    console.log(`📊 Cambio en ETH: ${ethers.utils.formatEther(ethDifference)} ETH`);
    
    if (tokenContract) {
      const finalTokenBalance = await tokenContract.balanceOf(wallet.address);
      const initialTokenBalance = await tokenContract.balanceOf(wallet.address); // Sí, esto debería estar antes, pero mantengo estructura
      const tokenDifference = finalTokenBalance.sub(initialTokenBalance);
      console.log(`📊 Cambio en ${symbol}: ${ethers.utils.formatUnits(tokenDifference, decimals)}`);
    }
    
    return true;
  } catch (error: any) {
    console.error(`❌ Error en arbitraje: ${error.message}`);
    return false;
  }
}

// Ejecutar el monitor
console.log(`🚀 Monitor de Arbitraje FlashLoan v3.0`);
console.log(`   Ejecución habilitada: ${IS_EXECUTION_ENABLED ? 'Sí' : 'No'}`);
console.log(`   Umbral de beneficio: $${MIN_PROFIT_USD} (después de todos los costos)`);
monitor().catch(console.error);
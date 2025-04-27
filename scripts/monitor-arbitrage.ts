import { ethers } from "ethers";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { DEX_ROUTERS, AAVE_V3, DEPLOYED_CONTRACTS } from "../config/addresses";
dotenv.config();

// ================================
// Configuration
// ================================
const MIN_PROFIT_PERCENT = 0.5;       // Mínimo porcentaje de beneficio antes de costos
const MIN_PROFIT_USD = 50;            // Mínimo beneficio en USD después de todos los gastos
const IS_EXECUTION_ENABLED = true;    // Establecer en false para solo monitoreo
const MAX_GAS_PRICE_GWEI = 30;        // Precio máximo de gas para permitir ejecución
const MAX_SLIPPAGE_PERCENT = 0.5;     // Slippage máximo aceptable
const MIN_LIQUIDITY_USD = 100000;     // Liquidez mínima para considerar un pool ($100K)
const FLASH_LOAN_FEE = 0.0005;        // Prima de préstamo flash de AAVE (0.05%)
const GAS_LIMIT_ARBITRAGE = 800000;   // Estimación de límite de gas para arbitraje

// Direcciones de contratos desplegados
const FLASH_LOAN_CONTRACT = DEPLOYED_CONTRACTS.FLASH_LOAN_ARBITRAGE;
const DEX_AGGREGATOR_CONTRACT = DEPLOYED_CONTRACTS.DEX_AGGREGATOR;

// DEXes a monitorear - ordenados por prioridad
const DEXES = [
  'uniswap_v3',          // Mayor liquidez y más eficiente
  'uniswap_v2',          // Pool establecido
  'sushiswap-v3-ethereum',
  'sushiswap',
  'pancakeswap-v3-ethereum',
  'pancakeswap_ethereum',
  'uniswap-v4-ethereum'  // Más nuevo, potencialmente menor liquidez
];

// Mapeo de tipo DEX para el contrato DexAggregator
const DEX_INFO = {
  'uniswap_v2': { name: 'Uniswap V2', type: 0 },
  'uniswap_v3': { name: 'Uniswap V3', type: 1 },
  'uniswap-v4-ethereum': { name: 'Uniswap V4', type: 3 },
  'sushiswap': { name: 'SushiSwap', type: 2 },
  'sushiswap-v3-ethereum': { name: 'SushiSwap V3', type: 1 },
  'pancakeswap_ethereum': { name: 'PancakeSwap', type: 4 },
  'pancakeswap-v3-ethereum': { name: 'PancakeSwap V3', type: 4 }
};

// ABIs minimizados para mejor rendimiento
const flashLoanArbitrageABI = [
  "function executeFlashLoan(address asset, uint256 amount) external",
  "function owner() view returns (address)"
];

const erc20ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address account) view returns (uint256)"
];

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
if (!process.env.RPC_URL) {
  throw new Error("RPC_URL no establecida en el archivo .env");
}

const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
const wallet = process.env.PRIVATE_KEY 
  ? new ethers.Wallet(process.env.PRIVATE_KEY, provider) 
  : null;

if (IS_EXECUTION_ENABLED && !wallet) {
  console.warn("⚠️ La ejecución está habilitada pero no se encontró PRIVATE_KEY - solo se monitoreará");
}

// Función principal de monitoreo
async function monitor() {
  console.log(`\n🔎 Iniciando monitor de arbitraje para DEXes de Ethereum`);
  
  try {
    // Cargar datos de pools desde dexespools.json
    const poolData = await loadPoolData();
    
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
  
  // Procesar cada DEX
  for (const dexId of DEXES) {
    const dexData = dexPoolsData[dexId];
    if (!dexData?.data?.length || !dexData.included?.length) continue;
    
    const dexInfo = DEX_INFO[dexId];
    if (!dexInfo) continue;
    
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
  let ethPriceUSD = 3000; // Valor por defecto en caso de fallo
  try {
    // Buscar precio ETH en los datos
    const wethPrices = prices.filter(p => 
      p.baseTokenSymbol.toLowerCase() === "weth" && 
      ["usdc", "usdt", "dai"].includes(p.quoteTokenSymbol.toLowerCase())
    );
    
    if (wethPrices.length > 0) {
      // Promediar los precios encontrados
      ethPriceUSD = wethPrices.reduce((sum, p) => sum + p.price, 0) / wethPrices.length;
    }
  } catch (err) {
    console.warn("⚠️ No se pudo determinar el precio de ETH, usando valor por defecto");
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
        
        // Calcular porcentaje de beneficio
        const profitPercent = ((sellPrice.price - buyPrice.price) / buyPrice.price) * 100;
        
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
            buyDex: buyPrice.dex,
            sellDex: sellPrice.dex,
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
  
  // Ejecutar la mejor oportunidad si es suficientemente rentable
  if (IS_EXECUTION_ENABLED && wallet) {
    const bestOpportunity = opportunities[0];
    
    // Verificar si es realmente rentable después de todos los costos
    if (bestOpportunity.netProfitUSD > MIN_PROFIT_USD) {
      console.log(`\n⚡ Ejecutando arbitraje de préstamo flash para la mejor oportunidad...`);
      await executeFlashLoan(bestOpportunity);
    } else {
      console.log(`\n⚠️ El mejor beneficio neto ($${bestOpportunity.netProfitUSD.toFixed(2)}) es menor que el umbral ($${MIN_PROFIT_USD})`);
    }
  }
}

// Ejecutar préstamo flash para arbitraje
async function executeFlashLoan(opportunity: ArbitrageOpportunity): Promise<boolean> {
  if (!wallet) {
    console.log("❌ No hay wallet configurada");
    return false;
  }
  
  try {
    console.log(`\n🚀 EJECUTANDO ARBITRAJE DE PRÉSTAMO FLASH:`);
    console.log(`   Par de tokens: ${opportunity.baseTokenSymbol}/${opportunity.quoteTokenSymbol}`);
    console.log(`   Comprar en ${DEX_INFO[opportunity.buyDex]?.name} a ${opportunity.buyPrice}`);
    console.log(`   Vender en ${DEX_INFO[opportunity.sellDex]?.name} a ${opportunity.sellPrice}`);
    console.log(`   Beneficio neto esperado: $${opportunity.netProfitUSD.toFixed(2)}`);
    
    // Verificar precio de gas
    const feeData = await provider.getFeeData();
    const gasPrice = ethers.utils.formatUnits(feeData.gasPrice || '0', 'gwei');
    
    if (parseFloat(gasPrice) > MAX_GAS_PRICE_GWEI) {
      console.log(`⛔ Precio de gas demasiado alto (${gasPrice} gwei > ${MAX_GAS_PRICE_GWEI} gwei). Abortando.`);
      return false;
    }
    
    // Obtener detalles de token y formatear cantidad
    const tokenContract = new ethers.Contract(
      opportunity.flashLoanToken,
      erc20ABI,
      provider
    );
    
    const decimals = await tokenContract.decimals();
    const symbol = await tokenContract.symbol();
    const flashLoanAmount = ethers.utils.parseUnits(opportunity.flashLoanAmount, decimals);
    
    console.log(`💰 Detalles de préstamo flash: ${ethers.utils.formatUnits(flashLoanAmount, decimals)} ${symbol}`);
    
    // Conectar al contrato de préstamo flash
    const flashLoanContract = new ethers.Contract(
      FLASH_LOAN_CONTRACT,
      flashLoanArbitrageABI,
      wallet
    );
    
    // Ejecutar préstamo flash
    const tx = await flashLoanContract.executeFlashLoan(
      opportunity.flashLoanToken,
      flashLoanAmount,
      {
        gasLimit: GAS_LIMIT_ARBITRAGE,
        maxFeePerGas: feeData.maxFeePerGas || feeData.gasPrice,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas
      }
    );
    
    console.log(`✅ Transacción enviada: ${tx.hash}`);
    console.log(`📊 Ver en Etherscan: https://etherscan.io/tx/${tx.hash}`);
    
    // Esperar confirmación
    console.log(`⏳ Esperando confirmación...`);
    const receipt = await tx.wait();
    console.log(`✅ Transacción confirmada en el bloque ${receipt.blockNumber}`);
    
    return true;
    
  } catch (error: any) {
    console.error(`❌ Error ejecutando arbitraje: ${error.message}`);
    if (error.reason) console.error(`Razón: ${error.reason}`);
    return false;
  }
}

// Ejecutar el monitor
console.log(`🚀 Monitor de Arbitraje FlashLoan v2.0`);
console.log(`   Ejecución habilitada: ${IS_EXECUTION_ENABLED ? 'Sí' : 'No'}`);
console.log(`   Umbral de beneficio: $${MIN_PROFIT_USD} (después de todos los costos)`);
monitor().catch(console.error);
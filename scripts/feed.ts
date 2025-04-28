import { ethers } from "hardhat";
import axios from "axios";
import * as dotenv from "dotenv";
dotenv.config();

const PRIVATE_KEY = process.env.PRIVATE_KEY;

// Alchemy token metadata batch API
const ALCHEMY_TOKEN_API = process.env.RPC_URL?.replace('https://', 'https://eth-mainnet.g.alchemy.com/nft/v2/');

// ABI mínimo optimizado para consultas en paralelo
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

// Función optimizada para ejecutar múltiples promesas en paralelo con límite
async function throttledPromiseAll(promises, maxConcurrent = 5) {
  const results = [];
  const running = new Set();
  
  for (const promise of promises) {
    if (running.size >= maxConcurrent) {
      await Promise.race(running);
    }
    
    const promiseWithCleanup = (async () => {
      try {
        return await promise();
      } finally {
        running.delete(promiseWithCleanup);
      }
    })();
    
    running.add(promiseWithCleanup);
    results.push(promiseWithCleanup);
  }
  
  return Promise.all(results);
}

// Caché en memoria para precios
const priceCache = new Map();

async function getTokenBalances() {
  const [wallet] = await ethers.getSigners();
  const walletAddress = wallet.address;
  
  console.log(`🔍 Escaneando tokens para: ${walletAddress}`);
  
  try {
    // Obtener precio de ETH y balance en paralelo
    const [ethPriceResponse, ethBalance] = await Promise.all([
      axios.get('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', 
        { timeout: 5000 }),
      wallet.provider.getBalance(walletAddress)
    ]);
    
    const ethPrice = ethPriceResponse.data.ethereum.usd;
    const ethBalanceInEther = ethers.utils.formatEther(ethBalance);
    const ethValueUsd = parseFloat(ethBalanceInEther) * ethPrice;
    
    // Obtener todos los tokens en una sola llamada
    const response = await axios.post(
      process.env.RPC_URL, 
      {
        jsonrpc: "2.0",
        id: 1,
        method: "alchemy_getTokenBalances",
        params: [walletAddress]
      },
      { timeout: 10000 }
    );
    
    // Filtrar tokens con balance > 0
    const tokenBalances = response.data.result.tokenBalances.filter(
      token => token.tokenBalance !== "0x0000000000000000000000000000000000000000000000000000000000000000"
    );
    
    console.log(`\n💰 ETH: ${ethBalanceInEther} ($${ethValueUsd.toFixed(2)})`);
    console.log(`📊 Tokens encontrados: ${tokenBalances.length}`);
    
    if (tokenBalances.length === 0) {
      console.log("\n💵 Valor total del portafolio: $" + ethValueUsd.toFixed(2) + " USD");
      return;
    }
    
    // Metadatos de tokens en lote si está disponible el API de Alchemy
    let tokenMetadata = {};
    if (ALCHEMY_TOKEN_API) {
      try {
        const tokenAddresses = tokenBalances.map(t => t.contractAddress);
        const metadataResponse = await axios.post(
          `${ALCHEMY_TOKEN_API}/getContractMetadata`, 
          { contractAddresses: tokenAddresses },
          { timeout: 10000 }
        );
        tokenMetadata = metadataResponse.data.contracts || {};
      } catch (err) {
        // Silenciosamente falla y usará el método individual
      }
    }
    
    // Procesar tokens en paralelo
    const tokenPromises = tokenBalances.map((tokenData, index) => {
      return async () => {
        try {
          const tokenAddress = tokenData.contractAddress;
          const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet.provider);
          
          // Usar metadatos en caché si están disponibles
          let symbol, decimals;
          if (tokenMetadata[tokenAddress]) {
            symbol = tokenMetadata[tokenAddress].symbol;
            decimals = tokenMetadata[tokenAddress].decimals;
          } else {
            // Consultar on-chain solo si es necesario
            [symbol, decimals] = await Promise.all([
              tokenContract.symbol(),
              tokenContract.decimals()
            ]);
          }
          
          // Calcular balance formateado
          const rawBalance = tokenData.tokenBalance;
          const formattedBalance = ethers.utils.formatUnits(rawBalance, decimals);
          const balanceNumber = parseFloat(formattedBalance);
          
          if (balanceNumber <= 0) return null;
          
          // Obtener precio
          let tokenValueUsd = 0;
          let priceText = "desconocido";
          
          // Usar caché si está disponible
          if (priceCache.has(tokenAddress)) {
            const tokenPrice = priceCache.get(tokenAddress);
            tokenValueUsd = balanceNumber * tokenPrice;
            priceText = `$${tokenValueUsd.toFixed(2)}`;
          } else {
            try {
              // Stablecoins conocidos
              if (
                tokenAddress.toLowerCase() === "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" || // USDC
                tokenAddress.toLowerCase() === "0xdac17f958d2ee523a2206206994597c13d831ec7" || // USDT
                tokenAddress.toLowerCase() === "0x6b175474e89094c44da98b954eedeac495271d0f"    // DAI
              ) {
                tokenValueUsd = balanceNumber;
                priceText = `$${tokenValueUsd.toFixed(2)}`;
                priceCache.set(tokenAddress, 1);
              } else {
                const priceResponse = await axios.get(
                  `https://api.coingecko.com/api/v3/simple/token_price/ethereum?contract_addresses=${tokenAddress}&vs_currencies=usd`,
                  { timeout: 5000 }
                );
                
                if (priceResponse.data[tokenAddress.toLowerCase()]) {
                  const tokenPrice = priceResponse.data[tokenAddress.toLowerCase()].usd;
                  priceCache.set(tokenAddress, tokenPrice);
                  tokenValueUsd = balanceNumber * tokenPrice;
                  priceText = `$${tokenValueUsd.toFixed(2)}`;
                }
              }
            } catch (err) {
              // En caso de error, dejamos el valor por defecto
            }
          }
          
          return {
            symbol,
            tokenAddress,
            balance: formattedBalance,
            valueUsd: tokenValueUsd,
            valueText: priceText
          };
        } catch (err) {
          return null;
        }
      };
    });
    
    const processedTokens = (await throttledPromiseAll(tokenPromises))
      .filter(token => token !== null)
      .sort((a, b) => b.valueUsd - a.valueUsd);
    
    // Calcular valor total
    let totalUsdValue = ethValueUsd;
    for (const token of processedTokens) {
      totalUsdValue += token.valueUsd;
    }
    
    // Mostrar resultados
    console.log("\n🔝 TOKENS ORDENADOS POR VALOR:");
    console.log("======================================");
    
    for (const token of processedTokens) {
      console.log(`${token.symbol}: ${token.balance} (${token.valueText} USD)`);
    }
    
    console.log("\n💵 VALOR TOTAL DEL PORTAFOLIO: $" + totalUsdValue.toFixed(2) + " USD");
    
  } catch (error) {
    console.error("❌ Error escaneando tokens:", (error as Error).message);
  } finally {
    console.timeEnd("⏱️ Tiempo total");
  }
}

// Ejecutar la función
getTokenBalances().catch(console.error);
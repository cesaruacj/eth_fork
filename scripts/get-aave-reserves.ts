import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { AAVE_V3, AAVE_TOKENS_6, AAVE_TOKENS_8, AAVE_TOKENS_18, CHAINLINK_FEEDS } from "../config/addresses";

// Define ABIs directly instead of using factory imports
const dataProviderABI = [
  "function getAllReservesTokens() view returns (tuple(string symbol, address tokenAddress)[])",
  "function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)",
  "function getReserveData(address asset) view returns (uint256 unbacked, uint256 accruedToTreasuryScaled, uint256 totalAToken, uint256 totalStableDebt, uint256 totalVariableDebt, uint256 liquidityRate, uint256 variableBorrowRate, uint256 stableBorrowRate, uint256 averageStableBorrowRate, uint256 liquidityIndex, uint256 variableBorrowIndex, uint40 lastUpdateTimestamp)",
  "function getFlashLoanEnabled(address asset) view returns (bool)",
  "function getReserveTokensAddresses(address asset) view returns (address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress)",
  "function getATokenTotalSupply(address asset) view returns (uint256)"
];

const priceOracleABI = [
  "function getAssetPrice(address asset) view returns (uint256)"
];

// ABI for ERC20 token
const erc20ABI = [
  "function decimals() external view returns (uint8)",
  "function name() external view returns (string)",
  "function symbol() external view returns (string)",
  "function balanceOf(address) view returns (uint256)"
];

// Multicall ABI for batching requests
const multicallABI = [
  "function aggregate(tuple(address target, bytes callData)[] calls) view returns (uint256 blockNumber, bytes[] returnData)"
];

// Create a map of known token decimals to avoid redundant calls
const getKnownDecimals = () => {
  const decimalsMap: Record<string, number> = {};
  
  // Add tokens with 6 decimals
  Object.values(AAVE_TOKENS_6).forEach(addr => {
    decimalsMap[addr.toLowerCase()] = 6;
  });
  
  // Add tokens with 8 decimals
  Object.values(AAVE_TOKENS_8).forEach(addr => {
    decimalsMap[addr.toLowerCase()] = 8;
  });
  
  // Add tokens with 18 decimals
  Object.values(AAVE_TOKENS_18).forEach(addr => {
    decimalsMap[addr.toLowerCase()] = 18;
  });
  
  return decimalsMap;
};

// Create a map of token addresses to symbols for easier reference
const getTokenSymbolMap = () => {
  const symbolMap: Record<string, string> = {};
  
  // Add all token symbols
  for (const [symbol, address] of Object.entries(AAVE_TOKENS_6)) {
    symbolMap[address.toLowerCase()] = symbol;
  }
  for (const [symbol, address] of Object.entries(AAVE_TOKENS_8)) {
    symbolMap[address.toLowerCase()] = symbol;
  }
  for (const [symbol, address] of Object.entries(AAVE_TOKENS_18)) {
    symbolMap[address.toLowerCase()] = symbol;
  }
  
  return symbolMap;
};

async function main() {
  console.log("🔍 Fetching Aave V3 reserves data...");
  console.time("Fetch complete");

  // Connect to provider
  const provider = ethers.provider;
  
  // Get addresses provider and connect to it
  const addressesProvider = new ethers.Contract(
    AAVE_V3.POOL_ADDRESSES_PROVIDER,
    [
      "function getPoolDataProvider() view returns (address)",
      "function getPriceOracle() view returns (address)"
    ],
    provider
  );
  
  // Get data provider address and price oracle address concurrently
  const [dataProviderAddress, priceOracleAddress] = await Promise.all([
    addressesProvider.getPoolDataProvider(),
    addressesProvider.getPriceOracle()
  ]);
  
  console.log(`Data Provider address: ${dataProviderAddress}`);
  console.log(`Price Oracle address: ${priceOracleAddress}`);
  
  // Connect to data provider and price oracle
  const dataProvider = new ethers.Contract(dataProviderAddress, dataProviderABI, provider);
  const priceOracle = new ethers.Contract(priceOracleAddress, priceOracleABI, provider);
  
  // Get all reserves tokens
  console.log("Fetching all reserve tokens...");
  const allReserves = await dataProvider.getAllReservesTokens();
  console.log(`Found ${allReserves.length} reserves in Aave V3`);
  
  // Prepare the result object
  const reservesData = {
    timestamp: new Date().toISOString(),
    networkName: "Ethereum Mainnet",
    totalValueLocked: 0,
    reserves: [] as any[]
  };

  // Get ETH price in USD for reference
  const ethUsdPrice = ethers.utils.formatUnits(
    await priceOracle.getAssetPrice("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"), // WETH address
    8 // Price oracle uses 8 decimals
  );
  console.log(`ETH price: $${ethUsdPrice}`);
  reservesData.ethPrice = parseFloat(ethUsdPrice);
  
  // Load known decimals and symbols
  const knownDecimals = getKnownDecimals();
  const tokenSymbols = getTokenSymbolMap();
  
  // Batch fetch all token prices at once
  const tokenAddresses = allReserves.map(r => r.tokenAddress);
  console.log("Batch fetching token prices...");
  
  // Create price fetch promises for all tokens
  const priceFetchPromises = tokenAddresses.map(async (tokenAddress) => {
    try {
      const priceInEthWei = await priceOracle.getAssetPrice(tokenAddress);
      return { 
        address: tokenAddress,
        priceInEthWei
      };
    } catch (e) {
      console.error(`Error fetching price for ${tokenAddress}: ${e.message}`);
      return {
        address: tokenAddress,
        priceInEthWei: ethers.BigNumber.from(0)
      };
    }
  });
  
  // Execute all price fetch promises in chunks of 10 to avoid rate limiting
  const batchSize = 10;
  const tokenPrices: Record<string, ethers.BigNumber> = {};
  
  for (let i = 0; i < priceFetchPromises.length; i += batchSize) {
    const chunk = priceFetchPromises.slice(i, i + batchSize);
    const results = await Promise.all(chunk);
    
    results.forEach(result => {
      tokenPrices[result.address.toLowerCase()] = result.priceInEthWei;
    });
    
    console.log(`Fetched prices for tokens ${i+1} to ${Math.min(i+batchSize, priceFetchPromises.length)}`);
  }
  
  console.log("Processing reserves data...");
  
  // Process tokens in batches to avoid overloading the RPC
  for (let i = 0; i < allReserves.length; i += batchSize) {
    const batch = allReserves.slice(i, i + batchSize);
    const batchPromises = batch.map(async (reserve) => {
      try {
        const { tokenAddress, symbol } = reserve;
        const tokenAddressLower = tokenAddress.toLowerCase();
        
        // Get token decimals - use known values first
        let decimals = knownDecimals[tokenAddressLower];
        let name = symbol;
        
        if (!decimals) {
          try {
            const token = new ethers.Contract(tokenAddress, erc20ABI, provider);
            [decimals, name] = await Promise.all([
              token.decimals(),
              token.name()
            ]);
          } catch (e) {
            console.log(`Error getting token details for ${symbol}: ${e.message}`);
            decimals = 18; // Default
          }
        }
        
        // Fetch multiple data points in parallel
        const [
          configData,
          reserveData,
          flashLoanEnabled,
          tokenAddresses,
          totalATokenSupply
        ] = await Promise.all([
          dataProvider.getReserveConfigurationData(tokenAddress),
          dataProvider.getReserveData(tokenAddress),
          dataProvider.getFlashLoanEnabled(tokenAddress),
          dataProvider.getReserveTokensAddresses(tokenAddress),
          dataProvider.getATokenTotalSupply(tokenAddress)
        ]);
        
        // Get price from pre-fetched data
        const priceInEthWei = tokenPrices[tokenAddressLower] || ethers.BigNumber.from(0);
        const priceInEth = ethers.utils.formatUnits(priceInEthWei, 8); // 8 decimals
        
        // Calculate USD price
        const priceInUsd = parseFloat(priceInEth) * parseFloat(ethUsdPrice);
        
        // Format total supply
        const totalSupply = ethers.utils.formatUnits(totalATokenSupply, decimals);
        
        // Calculate USD value of total supply
        const usdValue = parseFloat(totalSupply) * priceInUsd;
        
        return {
          symbol,
          name,
          address: tokenAddress,
          decimals: typeof decimals === 'number' ? decimals : parseInt(decimals.toString()),
          priceInEth: parseFloat(priceInEth),
          priceInUsd: priceInUsd.toFixed(2),
          totalSupply,
          totalValueUsd: usdValue.toFixed(2),
          isActive: configData.isActive,
          isFrozen: configData.isFrozen,
          borrowingEnabled: configData.borrowingEnabled,
          flashLoanEnabled,
          ltv: configData.ltv.toString(),
          liquidationThreshold: configData.liquidationThreshold.toString(),
          aTokenAddress: tokenAddresses.aTokenAddress,
          stableDebtTokenAddress: tokenAddresses.stableDebtTokenAddress,
          variableDebtTokenAddress: tokenAddresses.variableDebtTokenAddress,
          totalAToken: ethers.utils.formatUnits(reserveData.totalAToken, decimals),
          totalStableDebt: ethers.utils.formatUnits(reserveData.totalStableDebt, decimals),
          totalVariableDebt: ethers.utils.formatUnits(reserveData.totalVariableDebt, decimals),
          liquidityRate: reserveData.liquidityRate.toString(),
          variableBorrowRate: reserveData.variableBorrowRate.toString(),
          usdValue
        };
      } catch (error: any) {
        console.error(`Error processing reserve ${reserve.symbol}: ${error.message}`);
        return null;
      }
    });
    
    const batchResults = await Promise.all(batchPromises);
    
    // Add valid results to reserves data
    batchResults.forEach(result => {
      if (result) {
        reservesData.reserves.push(result);
        
        // Add to total TVL if token is active
        if (result.isActive && !result.isFrozen) {
          reservesData.totalValueLocked += result.usdValue;
        }
        
        console.log(`✅ ${result.symbol}: $${result.usdValue.toFixed(2)}`);
      }
    });
    
    console.log(`Processed tokens ${i+1} to ${Math.min(i+batchSize, allReserves.length)}`);
  }
  
  // Sort reserves by USD value (highest first)
  reservesData.reserves.sort((a, b) => parseFloat(b.totalValueUsd) - parseFloat(a.totalValueUsd));
  
  // Format total TVL
  reservesData.totalValueLocked = parseFloat(reservesData.totalValueLocked.toFixed(2));
  
  // Write to file - make sure the data directory exists
  const dataDir = path.join(__dirname, "..", "data");
  if (!fs.existsSync(dataDir)) {
    console.log(`Creating data directory at ${dataDir}`);
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const outputPath = path.join(dataDir, "aave-reserves.json");
  try {
    fs.writeFileSync(outputPath, JSON.stringify(reservesData, null, 2));
    console.log(`\n✅ Aave reserves data written to ${outputPath}`);
    console.log(`Total Value Locked: $${reservesData.totalValueLocked.toLocaleString()}`);
  } catch (error: any) {
    console.error(`❌ Error writing file: ${error.message}`);
  }
  
  console.timeEnd("Fetch complete");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
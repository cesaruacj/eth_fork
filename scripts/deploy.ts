import { ethers } from "hardhat";
import { DEX_ROUTERS, FACTORIES, AAVE_V3 } from "../config/addresses";
import fs from "fs";
import path from "path";

const ADDRESSES_PATH = path.resolve(__dirname, "../config/addresses.ts");
const GAS_FEE_PATH = path.resolve(__dirname, "../data/gasFee.json");

async function main() {
    // Declara deployOptions UNA SOLA VEZ al inicio de la función
    let deployOptions = {
        // Valores predeterminados
        gasLimit: 3000000,
    };

    const network = await ethers.provider.getNetwork();
    if (network.name === "localhost") {
        // Modifica la variable existente en lugar de redeclararla
        deployOptions.gasPrice = ethers.utils.parseUnits("10", "gwei");
        console.log("🔧 Usando gas fijo para fork local:", deployOptions);
    } else {
        // Leer información actual de gas fee y aplicar optimizaciones
        let gasFeeData;
        try {
            const gasFeeFile = fs.readFileSync(GAS_FEE_PATH, 'utf8');
            gasFeeData = JSON.parse(gasFeeFile).current;
            console.log("📊 Usando gas fee actual:", {
                baseFee: `${gasFeeData.baseFeePerGasGwei} Gwei`,
                maxFee: `${gasFeeData.maxFeePerGasGwei} Gwei`,
                priorityFee: `${gasFeeData.maxPriorityFeePerGasGwei} Gwei`
            });
            
            // Usar un valor ligeramente superior al baseFee para transacciones rápidas
            const optimalMaxFee = Math.ceil(gasFeeData.baseFeePerGasGwei * 1.1 * 1e9);
            const optimalPriorityFee = Math.ceil(gasFeeData.maxPriorityFeePerGasGwei * 0.8 * 1e9);
            
            deployOptions.maxFeePerGas = ethers.utils.parseUnits(optimalMaxFee.toString(), "wei");
            deployOptions.maxPriorityFeePerGas = ethers.utils.parseUnits(optimalPriorityFee.toString(), "wei");
        } catch (error) {
            console.warn("⚠️ No se pudo leer gasFee.json, usando valores por defecto");
        }
    }

    console.log("🚀 Iniciando despliegue con opciones:", deployOptions);

    // Despliegue de DexAggregator
    const DexAggregator = await ethers.getContractFactory("DexAggregator");
    const dexAggregator = await DexAggregator.deploy(
        DEX_ROUTERS.UNISWAP_V3_QUOTER
    );
    await dexAggregator.deployed();
    console.log("✅ DexAggregator desplegado en:", dexAggregator.address);

    // Despliegue de FlashLoanArbitrage con el proveedor correcto de AAVE
    const FlashLoanArbitrage = await ethers.getContractFactory("FlashLoanArbitrage");
    const flashLoanArbitrage = await FlashLoanArbitrage.deploy(
        AAVE_V3.POOL_ADDRESSES_PROVIDER, // Usar el provider de Aave en lugar de factory
        dexAggregator.address
    );
    await flashLoanArbitrage.deployed();
    console.log("✅ FlashLoanArbitrage desplegado en:", flashLoanArbitrage.address);

    // Actualiza DEPLOYED_CONTRACTS en addresses.ts
    const addressesFile = fs.readFileSync(ADDRESSES_PATH, "utf8");
    const newContracts = 
`export const DEPLOYED_CONTRACTS = {
  // Automatically updated by deploy script on ${new Date().toLocaleString()}
  DEX_AGGREGATOR: "${dexAggregator.address}",
  FLASH_LOAN_ARBITRAGE: "${flashLoanArbitrage.address}"
}`;
    const updatedFile = addressesFile.replace(
        /export const DEPLOYED_CONTRACTS = {[^}]+}/m,
        newContracts
    );
    fs.writeFileSync(ADDRESSES_PATH, updatedFile, "utf8");
    console.log("📝 DEPLOYED_CONTRACTS actualizado en addresses.ts");
}

main().catch((error) => {
    console.error("❌ Error al desplegar los contratos:", error);
    process.exitCode = 1;
});
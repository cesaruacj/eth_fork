import { ethers } from "hardhat";
import { DEX_ROUTERS, FACTORIES, AAVE_V3 } from "../config/addresses";
import fs from "fs";
import path from "path";
import { execSync } from 'child_process';

const ADDRESSES_PATH = path.resolve(__dirname, "../config/addresses.ts");
const GAS_FEE_PATH = path.resolve(__dirname, "../data/gasFee.json");

async function main() {
    // 1. Actualizar información de gas
    try {
        execSync('npx hardhat run scripts/gasFee.ts --network mainnet', { stdio: 'inherit' });
    } catch {
        console.warn("⚠️ No se pudo actualizar información de gas.");
    }

    // 2. Obtener deployer
    const [deployer] = await ethers.getSigners();
    console.log("🔑 Deployer:", deployer.address);

    // 3. Opciones de gas
    let deployOptions: any = { gasLimit: 5_000_000 };
    const network = await ethers.provider.getNetwork();
    if (network.chainId === 31337 || network.name === "localhost" || network.name === "hardhat") {
        deployOptions.gasPrice = ethers.utils.parseUnits("15", "gwei");
    } else {
        try {
            const gasFeeData = JSON.parse(fs.readFileSync(GAS_FEE_PATH, 'utf8')).current;
            deployOptions.maxFeePerGas = ethers.BigNumber.from(Math.ceil(gasFeeData.maxFeePerGasGwei * 1e9).toString());
            deployOptions.maxPriorityFeePerGas = ethers.BigNumber.from(Math.ceil(gasFeeData.maxPriorityFeePerGasGwei * 1e9).toString());
        } catch {
            console.warn("⚠️ No se pudo leer gasFee.json, usando valores por defecto");
        }
    }

    // 4. Desplegar contratos
    const DexAggregator = await ethers.getContractFactory("DexAggregator", deployer);
    const dexAggregator = await DexAggregator.deploy(DEX_ROUTERS.UNISWAP_V3_QUOTER, deployOptions);
    await dexAggregator.deployed();
    console.log("✅ DexAggregator:", dexAggregator.address);

    const FlashLoanArbitrage = await ethers.getContractFactory("FlashLoanArbitrage", deployer);
    const flashLoanArbitrage = await FlashLoanArbitrage.deploy(AAVE_V3.POOL_ADDRESSES_PROVIDER, dexAggregator.address, deployOptions);
    await flashLoanArbitrage.deployed();
    console.log("✅ FlashLoanArbitrage:", flashLoanArbitrage.address);

    // Transfiere ownership y espera confirmación
    const tx = await dexAggregator.transferOwnership(flashLoanArbitrage.address);
    await tx.wait(1); // Espera a que la transacción sea minada
    console.log("✅ DexAggregator ownership transferido a FlashLoanArbitrage");

    // Ahora sí, inicializa los DEXes
    const owner = await flashLoanArbitrage.owner();
    console.log("👑 Owner del contrato:", owner);
    console.log("🔑 Deployer:", deployer.address);

    if (owner.toLowerCase() === deployer.address.toLowerCase()) {
        // El deployer es owner de FlashLoanArbitrage, pero ahora el owner de DexAggregator es FlashLoanArbitrage
        const flashLoanArbitrageWithSigner = flashLoanArbitrage.connect(deployer);
        const tx2 = await flashLoanArbitrageWithSigner.setupAllDexes({ gasLimit: 9_000_000, gasPrice: deployOptions.gasPrice });
        await tx2.wait(1);
        console.log("✅ DEXes inicializados correctamente");
    } else {
        console.warn("⚠️ El deployer no es el owner. Ejecuta manualmente: npx hardhat run scripts/setup-dexes.ts --network localhost");
    }

    // 5. Actualizar addresses.ts
    const addressesFile = fs.readFileSync(ADDRESSES_PATH, "utf8");
    const newContracts = 
`export const DEPLOYED_CONTRACTS = {
  DEX_AGGREGATOR: "${dexAggregator.address}",
  FLASH_LOAN_ARBITRAGE: "${flashLoanArbitrage.address}"
}`;
    fs.writeFileSync(ADDRESSES_PATH, addressesFile.replace(/export const DEPLOYED_CONTRACTS = {[^}]+}/m, newContracts), "utf8");

    console.log("✨ Despliegue completado");
    
    console.log("🔄 Inicializando DEXes en FlashLoanArbitrage...");
    try {
        execSync('npx hardhat run scripts/setup-dexes.ts --network localhost', { 
            stdio: 'inherit', 
            encoding: 'utf-8'
        });
        console.log("✅ DEXes inicializados correctamente");
    } catch (error) {
        console.warn("⚠️ No se pudieron inicializar dexes:", error);
    }
}

main().catch((error) => {
    console.error("❌ Error en el despliegue:", error);
    process.exitCode = 1;
});
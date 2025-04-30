import { ethers } from "hardhat";
import { DEX_ROUTERS, FACTORIES, AAVE_V3 } from "../config/addresses";
import fs from "fs";
import path from "path";
import { execSync } from 'child_process'; // Añadir esta importación

const ADDRESSES_PATH = path.resolve(__dirname, "../config/addresses.ts");
const GAS_FEE_PATH = path.resolve(__dirname, "../data/gasFee.json");

async function main() {
    // Ejecutar gasFee.ts para actualizar los datos de gas antes del despliegue
    console.log("🔄 Actualizando información de gas...");
    try {
        // Ejecuta gasFee.ts y muestra su salida en la consola
        execSync('npx hardhat run scripts/gasFee.ts --network localhost', { stdio: 'inherit' });
        console.log("✅ Información de gas actualizada correctamente");
    } catch (error) {
        console.warn("⚠️ Error al actualizar información de gas, se usarán valores predeterminados");
    }
    
    // Obtener cuentas y configurar deployer
    const [deployer] = await ethers.getSigners();
    console.log("🔑 Desplegando contratos con la cuenta:", deployer.address);

    // Configurar opciones de deploy
    let deployOptions = {
        // Valores predeterminados
        gasLimit: 5000000, // Incremento del gas limit para permitir operaciones complejas
    };

    const network = await ethers.provider.getNetwork();
    if (network.chainId === 31337 || network.name === "localhost" || network.name === "hardhat") {
        // Usar gasPrice simple para redes locales
        deployOptions.gasPrice = ethers.utils.parseUnits("15", "gwei");
        console.log("🔧 Usando gas fijo para fork local:", deployOptions);
    } else {
        // Leer información actual de gas fee y aplicar optimizaciones
        try {
            const gasFeeFile = fs.readFileSync(GAS_FEE_PATH, 'utf8');
            const gasFeeData = JSON.parse(gasFeeFile).current;
            console.log("📊 Usando gas fee actual:", {
                baseFee: `${gasFeeData.baseFeePerGasGwei} Gwei`,
                maxFee: `${gasFeeData.maxFeePerGasGwei} Gwei`,
                priorityFee: `${gasFeeData.maxPriorityFeePerGasGwei} Gwei`
            });
            
            // Convertir valores de Gwei a wei
            const baseFee = Math.ceil(gasFeeData.baseFeePerGasGwei * 1e9);
            const maxFeePerGas = Math.ceil(gasFeeData.maxFeePerGasGwei * 1e9);
            const priorityFee = Math.ceil(gasFeeData.maxPriorityFeePerGasGwei * 1e9);
            
            // Asegurar que maxFeePerGas >= priorityFee
            const adjustedMaxFee = Math.max(maxFeePerGas, priorityFee * 2);
            
            deployOptions.maxFeePerGas = ethers.BigNumber.from(adjustedMaxFee.toString());
            deployOptions.maxPriorityFeePerGas = ethers.BigNumber.from(priorityFee.toString());
            
            console.log("📊 Gas optimizado:", {
                maxFee: `${adjustedMaxFee/1e9} Gwei`,
                priorityFee: `${priorityFee/1e9} Gwei`
            });
        } catch (error) {
            console.warn("⚠️ No se pudo leer gasFee.json, usando valores por defecto");
        }
    }

    console.log("🚀 Iniciando proceso de despliegue e inicialización...");

    // 1. Desplegar DexAggregator
    console.log("📄 Desplegando DexAggregator...");
    const DexAggregator = await ethers.getContractFactory("DexAggregator", deployer);
    const dexAggregator = await DexAggregator.deploy(
        DEX_ROUTERS.UNISWAP_V3_QUOTER, 
        { ...deployOptions }
    );
    await dexAggregator.deployed();
    console.log("✅ DexAggregator desplegado en:", dexAggregator.address);

    // 2. Desplegar FlashLoanArbitrage
    console.log("📄 Desplegando FlashLoanArbitrage...");
    const FlashLoanArbitrage = await ethers.getContractFactory("FlashLoanArbitrage", deployer);
    const flashLoanArbitrage = await FlashLoanArbitrage.deploy(
        AAVE_V3.POOL_ADDRESSES_PROVIDER,
        dexAggregator.address,
        { ...deployOptions }
    );
    await flashLoanArbitrage.deployed();
    console.log("✅ FlashLoanArbitrage desplegado en:", flashLoanArbitrage.address);

    // 3. Actualizar archivo de direcciones
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
    
    // 4. Inicializar DEXes - CORREGIDO
    console.log("🔄 Configurando DEXes...");
    try {
        // Verificar propiedad
        const owner = await flashLoanArbitrage.owner();
        console.log("🔐 Owner del contrato:", owner);
        console.log("🔐 Dirección actual:", deployer.address);
        
        if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
            throw new Error("Las direcciones de owner y deployer no coinciden");
        }
        
        console.log("🔐 Iniciando configuración de DEXes...");

        // SOLUCIÓN: Especificar explícitamente las opciones de gas para esta transacción
        const setupOptions = {
            gasLimit: 9000000,  // Aumento significativo para esta operación compleja
            gasPrice: deployOptions.gasPrice 
        };
        
        // Asegurarse que la transacción se envía correctamente
        const tx = await flashLoanArbitrage.connect(deployer).setupAllDexes(setupOptions);
        console.log("⏳ Transacción enviada:", tx.hash);
        console.log("⏳ Esperando confirmación...");
        
        // Esperar confirmación con un timeout más largo
        await tx.wait(1);
        console.log("✅ DEXes inicializados correctamente");
    } catch (error) {
        console.error("❌ Error al configurar DEXes:", error.message);
        
        // Añadir información de depuración
        if (error.error && error.error.message) {
            console.error("Detalles adicionales:", error.error.message);
        }
        
        console.log("⚠️ El despliegue se completó pero los DEXes no fueron inicializados");
        console.log("⚠️ Para inicializar manualmente, ejecuta: npx hardhat run scripts/setup-dexes.ts --network localhost");
    }
    
    console.log("✨ Proceso de despliegue completado con éxito");
    console.log("🚀 Ahora puedes ejecutar: npx hardhat run scripts/arbitrage.ts --network localhost");
}

main().catch((error) => {
    console.error("❌ Error en el proceso de despliegue:", error);
    if (error.code && error.reason) {
        console.error("Código:", error.code);
        console.error("Razón:", error.reason);
    }
    process.exitCode = 1;
});
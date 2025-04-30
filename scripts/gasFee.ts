import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
dotenv.config();

// Configuración
const DATA_FILE_PATH = path.join(__dirname, "../data/gasFee.json");
const MAX_HISTORY_ENTRIES = 100; // Número máximo de entradas históricas
const UPDATE_INTERVAL_MS = 0 * 60 * 1000; // milisegundos (0 para una sola ejecución)

// Inicializar proveedor
if (!process.env.RPC_URL) {
  throw new Error("RPC_URL no está definida en el archivo .env");
}
const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);

// Interfaz para datos de gas
interface GasFeeData {
  timestamp: number;
  date: string;
  baseFeePerGas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  gasPrice: string;
  baseFeePerGasGwei: number;
  maxFeePerGasGwei: number;
  maxPriorityFeePerGasGwei: number;
  gasPriceGwei: number;
}

// Interfaz para el archivo JSON
interface GasFeeHistory {
  lastUpdate: number;
  lastUpdateDate: string;
  current: GasFeeData;
  history: GasFeeData[];
}

// Función para obtener datos de gas actuales
async function getGasFeeData(): Promise<GasFeeData> {
  try {
    // Obtener datos de fee
    const feeData = await provider.getFeeData();
    const block = await provider.getBlock("latest");
    
    // Calcular el timestamp actual
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date().toISOString();
    
    // Convertir a Gwei para mejor legibilidad
    const baseFeePerGasGwei = parseFloat(ethers.utils.formatUnits(block.baseFeePerGas || 0, "gwei"));
    const maxFeePerGasGwei = parseFloat(ethers.utils.formatUnits(feeData.maxFeePerGas || 0, "gwei"));
    const maxPriorityFeePerGasGwei = parseFloat(ethers.utils.formatUnits(feeData.maxPriorityFeePerGas || 0, "gwei"));
    const gasPriceGwei = parseFloat(ethers.utils.formatUnits(feeData.gasPrice || 0, "gwei"));
    
    console.log(`✅ Gas fee actual: ${baseFeePerGasGwei.toFixed(2)} Gwei (base), ${maxFeePerGasGwei.toFixed(2)} Gwei (max)`);
    
    return {
      timestamp,
      date,
      baseFeePerGas: (block.baseFeePerGas || ethers.BigNumber.from(0)).toString(),
      maxFeePerGas: (feeData.maxFeePerGas || ethers.BigNumber.from(0)).toString(),
      maxPriorityFeePerGas: (feeData.maxPriorityFeePerGas || ethers.BigNumber.from(0)).toString(),
      gasPrice: (feeData.gasPrice || ethers.BigNumber.from(0)).toString(),
      baseFeePerGasGwei,
      maxFeePerGasGwei,
      maxPriorityFeePerGasGwei,
      gasPriceGwei
    };
  } catch (error) {
    console.error(`❌ Error obteniendo datos de gas: ${error.message}`);
    throw error;
  }
}

// Función para actualizar y guardar datos de gas
async function updateGasFee() {
  try {
    // Obtener datos actuales de gas
    const currentData = await getGasFeeData();
    
    // Cargar datos existentes o crear nueva estructura
    let fileData: GasFeeHistory;
    
    if (fs.existsSync(DATA_FILE_PATH)) {
      try {
        const rawData = fs.readFileSync(DATA_FILE_PATH, 'utf8');
        fileData = JSON.parse(rawData);
      } catch (error) {
        console.warn(`⚠️ Error al leer archivo existente, creando nuevo: ${error.message}`);
        fileData = { 
          lastUpdate: 0, 
          lastUpdateDate: "", 
          current: currentData, 
          history: [] 
        };
      }
    } else {
      fileData = { 
        lastUpdate: 0, 
        lastUpdateDate: "", 
        current: currentData, 
        history: [] 
      };
    }
    
    // Actualizar datos actuales
    fileData.lastUpdate = currentData.timestamp;
    fileData.lastUpdateDate = currentData.date;
    fileData.current = currentData;
    
    // Agregar al historial
    fileData.history.unshift(currentData);
    
    // Limitar el tamaño del historial
    if (fileData.history.length > MAX_HISTORY_ENTRIES) {
      fileData.history = fileData.history.slice(0, MAX_HISTORY_ENTRIES);
    }
    
    // Asegurar que exista la carpeta data
    const dataDir = path.dirname(DATA_FILE_PATH);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
      console.log(`📁 Carpeta creada: ${dataDir}`);
    }
    
    // Guardar a archivo
    fs.writeFileSync(DATA_FILE_PATH, JSON.stringify(fileData, null, 2));
    console.log(`📝 Datos guardados en ${DATA_FILE_PATH}`);
    
    // Calcular diferencia con la última entrada del historial (si existe más de una)
    if (fileData.history.length > 1) {
      const previous = fileData.history[1];
      const diffBase = ((currentData.baseFeePerGasGwei - previous.baseFeePerGasGwei) / previous.baseFeePerGasGwei * 100).toFixed(2);
      console.log(`📊 Cambio desde última actualización: ${diffBase}% en base fee`);
    }
    
    return currentData;
  } catch (error) {
    console.error(`❌ Error general: ${error.message}`);
    return null;
  }
}

// Función principal
async function main() {
  console.log("🔄 Iniciando monitoreo de gas fee en la red Mainnet...");
  
  // Primera ejecución
  await updateGasFee();
  
  // Si se ha configurado un intervalo de actualización, programar actualizaciones periódicas
  if (UPDATE_INTERVAL_MS > 0) {
    console.log(`⏱️ Configurado para actualizar cada ${UPDATE_INTERVAL_MS / 60000} minutos`);
    
    // Programar actualizaciones periódicas
    setInterval(async () => {
      try {
        await updateGasFee();
      } catch (error) {
        console.error(`❌ Error en actualización programada: ${error.message}`);
      }
    }, UPDATE_INTERVAL_MS);
  } else {
    console.log("✅ Ejecución única completada");
  }
}

// Ejecutar el script
main().catch(error => {
  console.error("Error fatal:", error);
  process.exit(1);
});
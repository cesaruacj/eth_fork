require('dotenv').config();

const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Verificar que las variables de entorno se cargaron correctamente
console.log(`API_KEY: ${process.env.API_KEY}`);
console.log(`ETHSCAN_NETWORK: ${process.env.ETHSCAN_NETWORK}`);

// Asegúrate de tener una API Key de Ethscan
const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  console.error('❌ Error: API_KEY no está definida. Verifica tu archivo .env.');
  process.exit(1);
}

// Force mainnet for these mainnet contract addresses
const network = "mainnet"; 
const ETHERSCAN_API = 'https://api.etherscan.io/api';

// Detalles de los DEXes y sus contratos
const DEX_CONTRACTS = {
  SushiSwapV2: {
    Router: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
    Factory: '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac'
  },
  UniswapV2: {
    Router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
    Factory: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f'
  },
  UniswapV3: {
    Router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    Factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    Quoter: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6'
  },
  UniswapV4: {
    Router: '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af',
    Factory: '0x000000000004444c5dc75cB358380D2e3dE08A90',
    Quoter: '0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203'
  },
  PancakeSwap: {
    Router: '0x309abcAeFa19CA6d34f0D8ff4a4103317c138657',
    Factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    Quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997'
  },
  Balancer: {
    Vault: '	0xbA1333333333a1BA1108E8412f11850A5C319bA9',
    AggregatorRouter:'0x309abcAeFa19CA6d34f0D8ff4a4103317c138657',
  },
  Curve: {
    Factory: '0x6A8cbed756804B16E05E741eDaBd5cB544AE21bf',
    Router: '0x16C6521Dff6baB339122a0FE25a9116693265353'
  }
};

// Crear directorio para ABIs
const ABI_DIR = path.join(__dirname, 'external', 'abis', network);
if (!fs.existsSync(ABI_DIR)) {
  fs.mkdirSync(ABI_DIR, { recursive: true });
}

// Función para descargar ABI
async function downloadABI(contractAddress, dexName, contractType) {
  try {
    console.log(`Descargando ABI para ${dexName} ${contractType}...`);
    
    const url = `${ETHERSCAN_API}?module=contract&action=getabi&address=${contractAddress}&apikey=${API_KEY}`;
    console.log(`URL: ${url}`);
    
    const response = await axios.get(url);
    console.log(`Response: ${JSON.stringify(response.data)}`);
    
    if (response.data.status === '1') {
      // Crear directorio para el DEX si no existe
      const dexDir = path.join(ABI_DIR, dexName);
      if (!fs.existsSync(dexDir)) {
        fs.mkdirSync(dexDir, { recursive: true });
      }
      
      // Guardar ABI como JSON
      const abiPath = path.join(dexDir, `${contractType.toLowerCase()}.json`);
      fs.writeFileSync(abiPath, response.data.result);
      
      console.log(`✅ ABI guardada en ${abiPath}`);
      return true;
    } else {
      console.error(`❌ Error descargando ABI: ${response.data.message}`);
      return false;
    }
  } catch (error) {
    console.error(`❌ Error en la petición: ${error.message}`);
    return false;
  }
}

// Función para agregar un retraso
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Descargar todas las ABIs con un retraso entre cada solicitud
async function downloadAllABIs() {
  console.log('Iniciando descarga de ABIs...');
  
  for (const [dexName, contracts] of Object.entries(DEX_CONTRACTS)) {
    for (const [contractType, address] of Object.entries(contracts)) {
      await downloadABI(address, dexName, contractType);
      await delay(500); // Aumenté el retraso a 500ms para evitar rate limits
    }
  }
  
  console.log('Proceso completado.');
}

// Ejecutar la descarga
downloadAllABIs();
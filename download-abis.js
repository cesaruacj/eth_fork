require('dotenv').config();

const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Verificar API Key
const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  console.error('❌ Error: API_KEY no está definida. Verifica tu archivo .env.');
  process.exit(1);
}

// Network settings
const network = "mainnet"; 
const ETHERSCAN_API = 'https://api.etherscan.io/api';

// DEX contracts - mantener igual
const DEX_CONTRACTS = {

  UniswapV2: {
    Factory: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
    Router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'
  },
  UniswapV3: {
    Factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    Router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    Quoter: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6'
  },
  UniswapV4: {
    Factory: '0x000000000004444c5dc75cB358380D2e3dE08A90',
    Router: '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af',
    Quoter: '0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203'
  },
  SushiSwapV2: {
    Factory: '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac',
    Router: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F'
  },
  SushiSwapV3: {
    Factory: '0xbACEB8eC6b9355Dfc0269C18bac9d6E2Bdc29C4F',
    Router: '0x2E6cd2d30aa43f40aa81619ff4b6E0a41479B13F'
  },
  PancakeSwapV2: {
    Factory: '0x1097053Fd2ea711dad45caCcc45EfF7548fCB362',
    Router: '0xEfF92A263d31888d860bD50809A8D171709b7b1c'
  },
  PancakeSwapV3: {
    Factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    Router: '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
    Quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997'
  },
  Balancer: {
    Vault: '	0xbA1333333333a1BA1108E8412f11850A5C319bA9',
    AggregatorRouter:'0x309abcAeFa19CA6d34f0D8ff4a4103317c138657'
  },
  MaverickV2: {
    Factory: '0x37232785ACD3EADdfd784dB3f9eCc1f8bcBd7eC7',
    Router: '0x62e31802c6145A2D5E842EeD8efe01fC224422fA',
    Quoter: '0xb40AfdB85a07f37aE217E7D6462e609900dD8D7A'
  },
  Curve: {
    Factory: '0x6A8cbed756804B16E05E741eDaBd5cB544AE21bf',
    Router: '0x16C6521Dff6baB339122a0FE25a9116693265353'
  },
  Antfarm: {
    Factory: '0xE48AEE124F9933661d4DD3Eb265fA9e153e32CBe',
    Router: '0x6D9f0eb21D77C6d24bE49a579508471E937D5418'
  },
  Ethervista: {
    Factory: '0x9a27cb5ae0B2cEe0bb71f9A85C0D60f3920757B4',
    Router: '0xCEDd366065A146a039B92Db35756ecD7688FCC77'
  },
  Shibaswap: {
    Factory: '0x115934131916C8b277DD010Ee02de363c09d037c',
    Router: '0x03f7724180AA6b939894B5Ca4314783B0b36b329'
  },
  X7FinanceEth: {
    Factory: '0x8B76C05676D205563ffC1cbd11c0A6e3d83929c5',
    Router: '0x6b5422d584943bc8cd0e10e239d624c6fe90fbb8'
  },
  Hopeswap: {
    Factory: '0x26F53fbADeEb777fb2A122dC703433d79241b64e',
    Router: '0x219bd2d1449f3813c01204ee455d11b41d5051e9'
  },
  Defiswap: {
    Factory: '0x9DEB29c9a4c7A88a3C0257393b7f3335338D9A9D',
    Router: '0xceb90e4c17d626be0facd78b79c9c87d7ca181b3'
  },
  Saitaswap: {
    Factory: '0x25393bb68C89a894B5e20FA3fC3B3b34F843C672',
    Router: '0x549efb3c8365f3f222aaa44d9af7894cdafff083'
  },
  Sakeswap: {
    Factory: '0x75e48C954594d64ef9613AeEF97Ad85370F13807',
    Router: '0x9C578b573EdE001b95d51a55A3FAfb45f5608b1f'
  },
  RadioShack: {
    Factory: '0x91fAe1bc94A9793708fbc66aDcb59087C46dEe10',
    Router: '0x3e445e3280c5747a188db8d0ab7762838a50e4ff'
  },
  Verse: {
    Factory: '0xee3E9E46E34a27dC755a63e2849C9913Ee1A06E2',
    Router: '0xb4b0ea46fe0e9e8eab4afb765b527739f2718671'
  },
  Fraxswap: {
    Factory: '0x43eC799eAdd63848443E2347C49f5f52e8Fe0F6f',
    Router: '0xc14d550632db8592d1243edc8b95b0ad06703867'
  },
  Smardex: {
    Factory: '0xB878DC600550367e14220d4916Ff678fB284214F',
    Router: '0xC33984ABcAe20f47a754eF78f6526FeF266c0C6F'
  },
  Solidly: {
    Factory: '0x777de5Fe8117cAAA7B44f396E93a401Cf5c9D4d6',
    Router: '0x77784f96C936042A3ADB1dD29C91a55EB2A4219f'
  },
  Elkfinance: {
    Factory: '0xE8234393E0Ffe32785BD78366be2FfFcE51795b9',
    Router: '0xb5e9F6C58f548CeE53257304e287b23757eFFCA1'
  },
  Apeswap: {
    Factory: '0xBAe5dc9B19004883d0377419FeF3c2C8832d7d7B',
    Router: '0x5f509a3C3F16dF2Fba7bF84dEE1eFbce6BB85587'
  },
  Swapr: {
    Factory: '0xd34971BaB6E5E356fd250715F5dE0492BB070452',
    Router: '0xB9960d9bcA016e9748bE75dd52F02188B9d0829f'
  },
  KyberSwapElastic: {
    Factory: '0xC7a590291e07B9fe9E64b86c58fD8fC764308C4A',
    Router: '0xf9c2b5746c946ef883ab2660bbbb1f10a5bdeab4'
  },
  KyberSwapClassic: {
  Factory: '0x1c758aF0688502e49140230F6b0EBd376d429be5',
  Router: '0x51e8d106c646ca58caf32a47812e95887c071a62'
  },
}

// Crear directorio para ABIs
const ABI_DIR = path.join(__dirname, 'external', 'abis', network);
if (!fs.existsSync(ABI_DIR)) {
  fs.mkdirSync(ABI_DIR, { recursive: true });
}

// Función para descargar ABI
async function downloadABI(contractAddress, dexName, contractType) {
  try {
    process.stdout.write(`Descargando ABI para ${dexName} ${contractType} (${contractAddress})... `);
    
    const url = `${ETHERSCAN_API}?module=contract&action=getabi&address=${contractAddress}&apikey=${API_KEY}`;
    const response = await axios.get(url);
    
    if (response.data.status === '1') {
      // Crear directorio para el DEX si no existe
      const dexDir = path.join(ABI_DIR, dexName);
      if (!fs.existsSync(dexDir)) {
        fs.mkdirSync(dexDir, { recursive: true });
      }
      
      // Guardar ABI
      const abiPath = path.join(dexDir, `${contractType.toLowerCase()}.json`);
      fs.writeFileSync(abiPath, response.data.result);
      
      console.log(`✅ ABI guardada en ${abiPath}`);
      return true;
    } else {
      console.log(`❌ Error descargando ABI: ${response.data.message}`);
      return false;
    }
  } catch (error) {
    console.log(`❌ Error en la petición: ${error.message}`);
    return false;
  }
}

// Retraso para evitar rate limits
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Descargar todas las ABIs
async function downloadAllABIs() {
  const results = [];
  
  for (const [dexName, contracts] of Object.entries(DEX_CONTRACTS)) {
    for (const [contractType, address] of Object.entries(contracts)) {
      const success = await downloadABI(address, dexName, contractType);
      results.push({ dexName, contractType, address, success });
      await delay(100);
    }
  }
  
  // Mostrar resumen conciso
  console.log("\n--- RESUMEN DE DESCARGA DE ABIs ---");
  for (const { dexName, contractType, address, success } of results) {
    const status = success ? "✅" : "❌";
    console.log(`${status} ${dexName} ${contractType}: ${address.substring(0, 10)}...`);
  }
  
  const successful = results.filter(r => r.success).length;
  console.log(`\nTotal: ${results.length} | Exitosos: ${successful} | Fallidos: ${results.length - successful}`);
  console.log('Proceso completado.');
}

// Ejecutar la descarga
downloadAllABIs();
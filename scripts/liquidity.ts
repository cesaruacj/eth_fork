import axios from 'axios';
import { writeFile } from 'fs/promises';
import path from 'path';

// Tu API Key de CoinGecko Pro (opcional si no usas Pro)
const API_KEY = process.env.CG_PRO_API_KEY ?? 'CG-1nbWvDMZZjMDTBiHzzUFeXTN';

// Base URL y versión de la API (beta v2)
const BASE_URL = 'https://api.geckoterminal.com/api/v2';
const API_VERSION = '20230302';

// ID de red Ethereum Mainnet
const NETWORK = 'eth';

// Lista de DEXes a consultar
const DEXES = [
  'uniswap_v2',
  'uniswap_v3',
  'uniswap-v4-ethereum',
  'sushiswap',
  'sushiswap-v3-ethereum',
  'pancakeswap_ethereum',
  'pancakeswap-v3-ethereum',
  'balancer_ethereum',
  'curve',
];

// Interface de la respuesta
interface PoolAttributes {
  name: string;
  address: string;
  reserve_in_usd: string;
  volume_usd: { '24h': string };
  base_token_price_usd: string;
  quote_token_price_usd: string;
  pool_created_at: string;
  // ... incluye aquí cualquier otro atributo que quieras extraer
}

interface PoolItem {
  id: string;
  type: string;
  attributes: PoolAttributes;
  relationships: Record<string, any>;
}

interface DexPoolsResponse {
  data: PoolItem[];
  included?: any[];
  meta?: any;
}

// Add this function to check available DEXes
async function getAvailableDexes(network: string = NETWORK): Promise<string[]> {
  const url = `${BASE_URL}/networks/${network}/dexes`;
  const headers = {
    accept: `application/json;version=${API_VERSION}`,
    'x-cg-pro-api-key': API_KEY,
  };

  try {
    const resp = await axios.get(url, { headers });
    return resp.data.data.map((dex: any) => dex.id);
  } catch (err: any) {
    console.error(`Error fetching available DEXes:`, err.message);
    return [];
  }
}

async function fetchTopPools(dex: string): Promise<{ dex: string; result: DexPoolsResponse }> {
  const url = `${BASE_URL}/networks/${NETWORK}/dexes/${dex}/pools`;
  const params = {
    per_page: 100, // Aumentar para obtener más pools por página
    sort: 'h24_volume_usd_desc',
    include: 'base_token,quote_token,dex,base_token.top_pools,quote_token.top_pools'
  };

  const headers = {
    accept: `application/json;version=${API_VERSION}`,
    'x-cg-pro-api-key': API_KEY,
  };

  try {
    const resp = await axios.get<DexPoolsResponse>(url, { params, headers });
    console.log(`✅ ${dex}: se encontraron ${resp.data.data.length} pools de liquidez`);
    return { dex, result: resp.data };
  } catch (err: any) {
    console.error(`❌ Error en ${dex}:`, err.message);
    return { dex, result: { data: [] } };
  }
}

// Modificar la función main() para seleccionar los 30 DEXes con mayor liquidez

async function main() {
  console.log(`🔍 Buscando DEXes disponibles en la red ${NETWORK}...`);
  
  // 1. Primero obtener todos los DEXes disponibles
  const availableDexes = await getAvailableDexes();
  console.log(`📊 DEXes disponibles en ${NETWORK}: ${availableDexes.length}`);
  
  // 2. Filtrar a los DEXes con mayor liquidez conocida
  // Estos son los 30 DEXes principales por liquidez total según los datos
  const topDexes = [
    'uniswap_v3',          // Enormes pools como ETH/USDC ($108M)
    'curve',               // Gran liquidez en pools de stablecoins ($176M+)
    'uniswap_v2',          // Pools establecidos como PEPE/WETH ($34M)
    'uniswap-v4-ethereum', // Pools importantes ($21M+)
    'balancer_ethereum',   // Pools grandes ($144M+)
    'sushiswap',           // Pool de WBTC/WETH ($22M)
    'ethervista',          // Pool de alta liquidez ($406K+)
    'x7-finance-ethereum', // Varios pools con liquidez
    'defi_swap',           // Pool CRO/ETH ($445K)
    'shibaswap',           // Pool SHIB/WETH ($3.9M)
    'hopeswap',            // Tiene un pool de $40K
    'antfarm-ethereum',    // Pool PEPE/USDC ($163K)
    'smardex-ethereum',    // Pool de $1.9M
    'sakeswap',            // Tiene varios pools de buena liquidez
    'radioshack_ethereum', // Liquidez $16K+
    'solidlydex',          // Pool $20K
    'unicly',              // Pool de $155K
    'verse',               // Pool de $1.4M
    'elk_finance_ethereum',// Pool de $6.8K
    'standard_ethereum',   // Pequeños pools
    'swapr_ethereum',      // Pequeños pools
    'x7-finance',          // Algunos pools pequeños
    'saitaswap-ethereum',  // Pool de $6K
    'kyberswap_elastic',   // Algunos pools
    'apeswap_ethereum',    // Pequeños pools
    'pancakeswap_ethereum',
    'pancakeswap-v3-ethereum',
    'sushiswap-v3-ethereum',
    'justmoney-ethereum',
    'kyberswap_classic_ethereum'
  ];
  
  // Asegurar que todos los DEXes solicitados existan
  const dexesToFetch = topDexes.filter(dex => availableDexes.includes(dex));
  console.log(`🚀 Consultando datos para ${dexesToFetch.length} DEXes de mayor liquidez:`, dexesToFetch);
  
  // 3. Obtener datos solo para estos DEXes
  console.log(`📡 Obteniendo pools por volumen para cada DEX...`);
  const allResults = await Promise.all(dexesToFetch.map(fetchTopPools));

  // Create output with ALL pools for each DEX (sorted by liquidity)
  const output = dexesToFetch.reduce<Record<string, DexPoolsResponse>>((acc, dex) => {
    const result = allResults.find(r => r.dex === dex);
    
    if (result?.result?.data?.length > 0) {
      // Sort pools by reserve_in_usd (liquidity) in descending order
      const sortedPools = [...result.result.data].sort((a, b) => {
        const reserveA = parseFloat(a.attributes?.reserve_in_usd || '0');
        const reserveB = parseFloat(b.attributes?.reserve_in_usd || '0');
        return reserveB - reserveA;
      });
      
      // Use all pools
      console.log(`💰 ${dex}: guardando todos los ${sortedPools.length} pools ordenados por liquidez`);
      
      // Guardar toda la información, incluido metadata completo
      acc[dex] = {
        data: sortedPools,
        included: result.result.included,
        meta: result.result.meta
      };
    } else {
      acc[dex] = { data: [] };
    }
    
    return acc;
  }, {});

  // Log summary of pools found
  console.log(`\n📋 Resumen de pools encontrados:`);
  for (const dex of dexesToFetch) {
    const poolCount = output[dex]?.data?.length || 0;
    if (poolCount > 0) {
      const totalLiquidity = output[dex].data.reduce((sum, pool) => {
        return sum + parseFloat(pool.attributes?.reserve_in_usd || '0');
      }, 0);
      console.log(`${dex}: ${poolCount} pools - Liquidez total: $${totalLiquidity.toLocaleString()}`);
    } else {
      console.log(`${dex}: ${poolCount} pools (DEX no disponible o sin pools)`);
    }
  }

  // Ruta del fichero de salida
  const outPath = path.resolve(process.cwd(), 'data/dexespools.json');

  // Guardar JSON completo
  await writeFile(outPath, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\n✅ Datos guardados en ${outPath} (todos los pools con información completa)`);
}

main().catch(console.error);

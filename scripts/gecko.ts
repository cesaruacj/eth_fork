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
    per_page: 30, // Solicitamos más pools para luego ordenarlos por liquidez
    sort: 'h24_volume_usd_desc',
    include: 'base_token,quote_token,dex'
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

async function main() {
  console.log(`🔍 Buscando DEXes disponibles en la red ${NETWORK}...`);
  
  // First get available DEXes
  const availableDexes = await getAvailableDexes();
  console.log(`📊 DEXes disponibles en ${NETWORK}: ${availableDexes.length}`, availableDexes);
  
  // Check which of our DEXes are available
  for (const dex of DEXES) {
    if (availableDexes.includes(dex)) {
      console.log(`✅ DEX encontrado: ${dex}`);
    } else {
      console.log(`❌ DEX no disponible: ${dex}`);
    }
  }
  
  // Filter our DEX list to only include available ones
  const dexesToFetch = DEXES.filter(dex => availableDexes.includes(dex));
  console.log(`🚀 Consultando datos para ${dexesToFetch.length} DEXes:`, dexesToFetch);
  
  // Fetch data only for available DEXes
  console.log(`📡 Obteniendo pools por volumen para cada DEX...`);
  const allResults = await Promise.all(dexesToFetch.map(fetchTopPools));

  // Create output with top 10 pools by liquidity for each DEX
  const output = DEXES.reduce<Record<string, DexPoolsResponse>>((acc, dex) => {
    const result = allResults.find(r => r.dex === dex);
    
    if (result?.result?.data?.length > 0) {
      // Sort pools by reserve_in_usd (liquidity) in descending order
      const sortedPools = [...result.result.data].sort((a, b) => {
        const reserveA = parseFloat(a.attributes?.reserve_in_usd || '0');
        const reserveB = parseFloat(b.attributes?.reserve_in_usd || '0');
        return reserveB - reserveA;
      });
      
      // Take only the top 10 pools by liquidity
      const top10ByLiquidity = sortedPools.slice(0, 10);
      
      console.log(`💰 ${dex}: seleccionados top 10 pools por liquidez de ${sortedPools.length} pools`);
      
      acc[dex] = {
        data: top10ByLiquidity,
        included: result.result.included
      };
    } else {
      acc[dex] = { data: [] };
    }
    
    return acc;
  }, {});

  // Log summary of pools found
  console.log(`\n📋 Resumen de pools con mayor liquidez encontrados:`);
  for (const dex of DEXES) {
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
  console.log(`\n✅ Datos guardados en ${outPath} (solo los 10 pools con mayor liquidez por DEX)`);
}

main().catch(console.error);

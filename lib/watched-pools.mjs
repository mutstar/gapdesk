import {CHAINS} from './assets.js';
import {readPools} from './pool-reader.mjs';

// PancakeSwap V2 factory.getPair on BSC. Keep reported pools and their
// USDC conversion pools in one multicall, independent of token directory coverage.
const chain=56,usdc=CHAINS[chain].usdc;
const mltp='0xf390fb7d16f2cbba037c1fc48862463116a7e545';
const busd='0xe9e7cea3dedca5984780bafc599bd69add087d56';
const wbnb='0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const reference=(token,symbol)=>({id:'dex:'+chain+':'+token,chain,token,symbol,decimals:18,kind:'DEX',venue:'dex',
  name:symbol+' · BNB Chain',ask:null,bid:null,time:0,referenceOnly:true,reference:'contract'});
export const watchedAssets=[reference(mltp,'MLTP')];
const assets=[...watchedAssets,reference(busd,'BUSD'),reference(wbnb,'WBNB')];
const symbols=new Map(assets.map(a=>[a.token,a.symbol]));
const tracked=new Set(watchedAssets.map(a=>a.token));
const pair=(pool,base,quote,settlementPool)=>({chain,pool,base,quote,dexId:'pancakeswap',protocol:'v2',settlementPool});
const busdUsdc=pair('0x2354ef4df11afacb85a5c7f98b624072eccddbb1',busd,usdc);
const wbnbUsdc=pair('0xd99c7f6c65857ac913a8f880a4cb84032ab2fc5b',wbnb,usdc);
const entries=[busdUsdc,wbnbUsdc,
  pair('0xa10b3b6d5f76835c83293a1c74bdde1f22f71df4',mltp,busd,busdUsdc.pool),
  pair('0xc901468e1c205e57f075572e11be8eee8aa63111',mltp,wbnb,wbnbUsdc.pool)];
export async function readWatchedPools(){
  const result=await readPools(entries,assets,{timeoutMs:6500});
  return result.markets.filter(m=>tracked.has(m.token)&&m.depth&&m.depthBridges?.length)
    .map(m=>{
      const quote=m.depth.token0===m.token?m.depth.token1:m.depth.token0;
      return {...m,watchedPool:true,name:'PancakeSwap V2 · '+m.symbol+'/'+symbols.get(quote)};
    });
}

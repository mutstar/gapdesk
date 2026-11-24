import {networks} from './dex-venues.mjs';
import {CHAINS,NATIVE} from './assets.js';

export function eventPrices(swaps,registry,assets,factories,now=Date.now()) {
  const index=new Map(assets.map(a=>[a.chain+':'+a.token,a])),markets=[];
  const known=new Map(factories.map(p=>[p.chain+':'+p.pool,p]));
  for(const s of swaps){
    const chain=networks[s.chain],config=CHAINS[chain];
    if(!config||!Number.isFinite(s.time)||s.time<=now-45000||s.time>now+5000)continue;
    let tokens,dexId='uniswap';
    if(s.protocol==='v4'){
      const pair=registry.identity(s.chain,s.pool);
      if(!pair)continue;
      tokens=[pair.token0,pair.token1];
    }else{
      const verified=known.get(chain+':'+s.pool)??registry.factory(s.chain,s.pool);
      if(!verified||s.protocol!==verified.protocol)continue;
      tokens=[verified.base,verified.quote].sort();
      dexId=verified.dexId;
    }
    const sides=tokens.map(token=>index.get(chain+':'+token));
    if(!sides.every(a=>a&&Number.isInteger(a.decimals)&&a.decimals>=0&&a.decimals<=36))continue;
    const ratio=s.rawRatio * 10**(sides[0].decimals-sides[1].decimals);
    for(const [i,asset] of sides.entries()){
      if(asset.token===NATIVE||asset.token===config.usdc)continue;
      const anchor=sides[1-i],stable=anchor.token===config.usdc,factor=i===0?ratio:1/ratio;
      const time=stable?s.time:Math.min(s.time,anchor.time);
      if(!Number.isFinite(time)||time<=now-45000||!stable&&anchor.time>now+5000)continue;
      const ask=factor*(stable?1:anchor.ask),bid=factor*(stable?1:anchor.bid);
      if(!(Number.isFinite(ask)&&bid>0&&ask>=bid))continue;
      markets.push({...asset,id:asset.id+':'+s.pool,pool:s.pool,dexId,name:(dexId==='uniswap'?'Uniswap':'PancakeSwap')+' '+s.protocol.toUpperCase()+' · '+config.name,
        reference:'venue-index',referenceOnly:false,observationOnly:true,ask,bid,time});
    }
  }
  return markets;
}

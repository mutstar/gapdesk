import {geckoNetworks} from './dex-venues.mjs';

const lowerHex=t=>/^0x[\da-f]+$/i.test(t)?t.toLowerCase():t;
export function indexedTicks(entry,data,previous){
  if(!Array.isArray(data?.data))throw Error('Invalid pool trade response');
  const input=data.data,seen=previous?.id,found=seen?input.findIndex(t=>t.id===seen):-1;
  const gap=!!seen&&found===-1&&input.length>=300;
  const fresh=found>=0?input.slice(0,found):input;
  let seq=previous?.seq??0,last=previous?.time??0;
  const tokens=[entry.token0,entry.token1].map(lowerHex).sort();
  const ticks=[];
  for(const trade of [...fresh].reverse()){
    const a=trade.attributes??{},time=Date.parse(a.block_timestamp);
    if(trade.type!=='trade'||typeof trade.id!=='string'||!Number.isSafeInteger(time)||time<last)continue;
    const [from,to]=[a.from_token_address,a.to_token_address].map(t=>typeof t==='string'?lowerHex(t):null);
    if(from===to||!tokens.includes(from)||!tokens.includes(to))continue;
    const value=Number(a.to_token_amount)/Number(a.from_token_amount);
    if(!Number.isFinite(value)||value<=0)continue;
    if(last!==time)seq=0;
    last=time;seq++;
    ticks.push({chain:entry.chain,pool:entry.pool,tokens,venue:entry.venue,protocol:'indexed',time,block:time,seq,
      hash:trade.id,humanUnits:true,rawRatio:from===tokens[0]?value:1/value});
  }
  return {ticks,next:{id:input[0]?.id??seen??null,seq,time:last,limited:gap}};
}
export async function refreshIndexedTrades(registry,get){
  const chains=registry.chains().sort();
  if(!chains.length)return;
  let cursor=registry.cursor('trade-networks')??0;
  for(let n=0;n<6;n++){
    const chain=chains[cursor++%chains.length],pool=registry.nextTradePool(chain);
    registry.commit([],'trade-networks',cursor);
    if(!pool)continue;
    const key='trades/'+chain+'/'+pool.pool;
    try{
      const slug=geckoNetworks[chain]??chain;
      const {data}=await get('https://api.geckoterminal.com/api/v2/networks/'+encodeURIComponent(slug)+'/pools/'+encodeURIComponent(pool.pool)+'/trades');
      const {ticks,next}=indexedTicks(pool,data,registry.cursor(key));
      registry.commit([],key,next,ticks,'index');
    }catch(error){
      if(/재시도|429/.test(error.message))break;
    }finally{
      // A missing index entry must not starve later pools. Its trade cursor is
      // unmodified on failure and the pool is retried on the next circuit.
      registry.commit([],'trade-pool/'+chain,pool.pool);
    }
    await new Promise(done=>setTimeout(done,2100));
  }
}

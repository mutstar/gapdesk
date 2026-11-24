import {CHAINS} from './assets.js';
import {networks} from './dex-venues.mjs';

// Official V4 PositionManager exposes the immutable pool key by its bytes25 prefix.
const managers={ethereum:'0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e',bsc:'0x7a4a5c919ae2541aed11041a1aeee68f1287f95b',
  base:'0x7c5f5a4bbd8fd63184577525326123b519429bdc',arbitrum:'0xd88f38f930b7952f2db2432cb002e7abbf3dd869'};
export function decodePoolKey(raw){
  if(!/^0x(?:[0-9a-f]{64}){5}$/.test(raw))return null;
  const words=raw.slice(2).match(/.{64}/g);
  if(![words[0],words[1],words[4]].every(w=>/^0{24}[0-9a-f]{40}$/.test(w))||words[0]>=words[1])return null;
  return words.slice(0,2).map(w=>'0x'+w.slice(-40));
}
export function createKeyResolver(registry,request=fetch){
  const retry=new Map();
  let running=false;
  return async function resolve(swaps){
    if(running)return;
    running=true;
    const now=Date.now();
    try{
      for(const [id,until] of retry)if(until<=now)retry.delete(id);
      await Promise.allSettled(Object.entries(managers).map(async ([chain,to])=>{
        const batch=swaps.filter(s=>s.chain===chain && s.protocol==='v4' && !retry.has(chain+s.pool)&&!registry.identity(chain,s.pool))
          .sort((a,b)=>b.time-a.time).slice(0,40);
        if(!batch.length)return;
        const calls=batch.map(({pool},i)=>({id:i+1,jsonrpc:'2.0',method:'eth_call',params:[{
          to,data:'0x86b6be7d'+pool.slice(2,52)+'0'.repeat(14)},'latest']}));
        const r=await request(CHAINS[networks[chain]].rpc,{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify(calls),signal:AbortSignal.timeout(5000)});
        if(!r.ok)return;
        const rows=[];
        for(const item of await r.json()){
          const p=batch[item.id-1];
          if(!p||item.error)continue;
          const tokens=decodePoolKey(item.result);
          if(tokens)rows.push({...p,venue:'uniswap',tokens,initialized:true});
          else retry.set(chain+p.pool,now+300000);
        }
        registry.commit(rows);
      }));
    }finally{running=false}
  };
}

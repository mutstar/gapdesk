import {CHAINS} from './assets.js';

// PoolManager Initialize indexes poolId, currency0 and currency1.
const initialize='0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
const managers={1:'0x000000000004444c5dc75cb358380d2e3de08a90',56:'0x28e2ea090877bf75740558f6bfb36a5ffee9e9df',
  8453:'0x498581ff718922c3f8e6a244956af099b2652b2b',42161:'0x360e68faccca8ca495c1b759fd9eee466db9fb32'};
const heads=new Map(),recent=new Map(),warmup={1:20,56:120,8453:80,42161:120};
const hex=n=>'0x'+n.toString(16);
async function rpc(chain,method,params,signal){
  const r=await fetch(CHAINS[chain].rpc,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal});
  if(!r.ok)throw Error('V4 RPC '+r.status);
  const j=await r.json();
  if(j.error||j.result==null)throw Error('V4 RPC unavailable');
  return j.result;
}
export async function recentV4Pools(assets){
  const supported=new Set(assets.map(a=>a.chain+':'+a.token)),now=Date.now();
  await Promise.allSettled(Object.entries(managers).map(async ([id,address])=>{
    const chain=Number(id),signal=AbortSignal.timeout(3500);
    const tip=Number(BigInt(await rpc(chain,'eth_blockNumber',[],signal)));
    const from=Math.max(0,tip-499,(heads.get(chain)??tip-warmup[chain])-2);
    if(from>tip)return;
    const logs=await rpc(chain,'eth_getLogs',[{address,topics:[initialize],fromBlock:hex(from),toBlock:hex(tip)}],signal);
    if(!Array.isArray(logs))return;
    for(const log of logs){
      const [signature,pool,a,b]=log.topics??[];
      if(log.removed||log.address?.toLowerCase()!==address||signature!==initialize||!/^0x[0-9a-f]{64}$/.test(pool)||
         ![a,b].every(t=>/^0x0{24}[0-9a-f]{40}$/.test(t)))continue;
      const base='0x'+a.slice(-40),quote='0x'+b.slice(-40);
      if(!supported.has(id+':'+base)&&!supported.has(id+':'+quote))continue;
      recent.set(id+':'+pool,{chain,pool,base,quote,dexId:'uniswap',initialized:true,seen:now});
    }
    heads.set(chain,tip);
  }));
  for(const [id,p] of recent)if(now-p.seen>20*60000)recent.delete(id);
  return [...recent.values()];
}

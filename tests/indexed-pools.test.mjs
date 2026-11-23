import test from 'node:test';
import assert from 'node:assert/strict';
import {createIndexedPoolReader} from '../lib/indexed-pools.mjs';
import {CHAINS} from '../lib/assets.js';
const addr=n=>'0x'+n.toString(16).padStart(40,'0');
const token=addr(11), usdc=CHAINS[1].usdc;
const entries=Array.from({length:32},(_,i)=>({chain:1,base:token,quote:usdc,dexId:'uniswap',pool:'0x'+BigInt(65536+i).toString(16).padStart(64,'0')}));
const makePair=e=>({chainId:'ethereum',dexId:e.dexId,pairAddress:e.pool,baseToken:{address:e.base},quoteToken:{address:e.quote},priceNative:'2'});
const assets=[{id:'dex:1:'+token,chain:1,token,symbol:'A',ask:3,bid:3,time:Date.now()}];
test('indexed V4 batches reconcile distinct pools by exact chain, addresses and market', async()=>{
 const sizes=[];
 const reader=createIndexedPoolReader({intervalMs:0,fetchImpl:async url=>{
   const ids=url.split('/').at(-1).split(',');sizes.push(ids.length);
   const pairs=ids.map(id=>makePair(entries.find(e=>e.pool===id)));
   if(ids.includes(entries[0].pool)){pairs[0].chainId='base';pairs[1].baseToken.address=addr(404);pairs[2].dexId='other';pairs.push(pairs[3]);}
   return Response.json({pairs});
 }});
 const {coverage,markets}=await reader([...entries,entries[0]],assets);
 const stats=coverage.find(c=>c.chain===1);
 assert.deepEqual(sizes,[30,2]);
 assert.equal(stats.registered,32);assert.equal(stats.attempted,32);assert.equal(stats.returned,29);assert.equal(stats.priced,29);assert.equal(stats.contracts,1);
 assert.ok(markets.every(m=>m.ask===2&&m.bid===2&&m.id.endsWith(m.pool)));
});
test('stale HTTP age and stale quote anchor cannot become a fresh indexed mark',async()=>{
 const other={...entries[0],quote:addr(29)};
 const reader=createIndexedPoolReader({intervalMs:0,fetchImpl:async()=>Response.json({pairs:[makePair(entries[0])]}, {headers:{Age:'60'}})});
 assert.equal((await reader([entries[0]],assets)).markets.length,0);
 const fresh=createIndexedPoolReader({intervalMs:0,fetchImpl:async()=>Response.json({pairs:[makePair(other)]})});
 assert.equal((await fresh([other],[...assets,{token:other.quote,chain:1,ask:1,bid:1,time:Date.now()-60000}])).markets.length,0);
});
test('expired polling timeslice resumes at next batch; a 429 persists across cycles',async()=>{
 const ids=[];
 const read=createIndexedPoolReader({intervalMs:40,fetchImpl:async url=>{
    ids.push(url.split('/').at(-1).split(',')[0]);
    return Response.json({pairs:[]});
 }});
 await read(entries,assets,{timeoutMs:8});
 await read(entries,assets,{timeoutMs:100});
 assert.equal(ids[0],entries[0].pool);assert.equal(ids[1],entries[30].pool);
 let calls=0;
 const limited=createIndexedPoolReader({intervalMs:10,fetchImpl:async()=>{calls++;return new Response(null,{status:429,headers:{'Retry-After':'5'}});}});
 const a=await limited(entries,assets),b=await limited(entries,assets);
 assert.equal(calls,1);assert.equal(a.coverage[0].attempted,30);assert.equal(b.coverage[0].attempted,0);assert.equal(b.coverage[0].complete,false);
});

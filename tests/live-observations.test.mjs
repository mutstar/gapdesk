import test from 'node:test';
import assert from 'node:assert/strict';
import {createObservationProgress} from '../lib/live-observations.mjs';
import {discover,prepareScan,wideScan} from '../lib/universe.mjs';
import {observationFrame} from '../lib/observation-window.mjs';
import {CHAINS} from '../lib/assets.js';

function deferred(){
  let resolve;
  const promise=new Promise(r=>{resolve=r});
  return {resolve,promise};
}
const token='0x'+'1'.repeat(40);
const network={token,chain:1,deposit:true,withdraw:true,minIn:0,minOut:0,decimals:6,fee:0,rate:0};
const exchange=(id,ask,time)=>({id,venue:id,name:id,symbol:'ACE',kind:'CEX',ask,bid:ask,time,networks:[network]});

test('incremental frames preserve actual times, exact contract screening and source order without any executable rows',async()=>{
  const at=Date.now()-2000, config={startedAt:at,budget:1000,floor:5,maxImpact:1};
  const first=exchange('cheap',1,at), high=exchange('dear',1.2,at+300);
  const other={...high,id:'namesake',venue:'namesake',bid:100,ask:100,networks:[{...network,token:'0x'+'2'.repeat(40)}]};
  let next=deferred();
  const progress=createObservationProgress({...config,delayMs:1,onProgress:frame=>next.resolve(frame),
    observe(spots){return {spotGaps:discover(spots,1000,5,1,false,true).spotGaps,futures:{rows:[]}}}});
  try{
    progress.addMarkets([first],{id:first.id,name:first.name,at,count:1,ok:true});
    const early=await next.promise;
    assert.equal(early.complete,false);
    assert.deepEqual(early.recentMarkets.map(m=>[m.id,m.time]),[[first.id,at]]);
    assert.deepEqual(early.spotGaps,[]);
    next=deferred();
    progress.addMarkets([other,high],{id:high.id,name:high.name,at,count:2,ok:true});
    const frame=await next.promise;
    assert.deepEqual(frame.sources.map(s=>s.id),[first.id,high.id]);
    assert.deepEqual(frame.spotGaps,discover([first,other,high],1000,5).spotGaps);
    assert.equal(frame.spotGaps[0].time,at);
    assert.equal(frame.spotGaps[0].sell.id,high.id);
    assert.equal(frame.rows,undefined);
    assert.equal(frame.eligible,undefined);
    assert.equal(frame.startedAt,at);
  }finally{progress.close()}
});

test('prepareScan publishes a venue while a different venue is still pending', {timeout:5000},async()=>{
  const original=globalThis.fetch, delayed=deferred(), observed=deferred(),startedAt=Date.now();
  let done=false;
  globalThis.fetch=async url=>{
    const u=new URL(url);
    if(u.hostname==='api.kucoin.com')await delayed.promise;
    if(u.hostname==='api.bithumb.com'){
      const quote={order_currency:'USDC',asks:[{price:'1300'}],bids:[{price:'1299'}]};
      return Response.json({status:'0000',data:u.pathname.includes('assetsstatus')?{}:{timestamp:startedAt,USDC:quote}});
    }
    return new Response(null,{status:503});
  };
  const scan=prepareScan({budget:1234,floor:2,maxImpact:0.7,startedAt,poolPass:async()=>({markets:[]}),
    onProgress(frame){if(frame.sources.some(s=>s.id==='bithumb'&&s.ok))observed.resolve(frame)}
  }).then(result=>{done=true;return result});
  try{
    const early=await observed.promise;
    assert.equal(done,false);
    assert.equal(early.budget,1234);
    assert.ok(!early.sources.some(s=>s.id==='kucoin'));
    assert.equal(early.recentMarkets[0].id,'bithumb:KRW-USDC');
    assert.equal(early.recentMarkets[0].time,startedAt);
    delayed.resolve();
    const {snapshot}=await scan;
    assert.ok(snapshot.sources.some(s=>s.id==='kucoin'&&!s.ok));
    assert.deepEqual(snapshot.recentMarkets,early.recentMarkets);
  }finally{delayed.resolve();await scan;globalThis.fetch=original}
});

test('a modeled DEX pair appears at its block time before a slower pool read completes',{timeout:5000},async()=>{
  const original=globalThis.fetch,remaining=deferred(),observed=deferred();
  const startedAt=Date.now()-1500;
  globalThis.fetch=async()=>new Response(null,{status:503});
  function pool(hex,price){
    const address='0x'+hex.repeat(40);
    return {id:'dex:1:'+token+':'+address,kind:'DEX',name:'pool '+hex,chain:1,token,symbol:'ACE',
      dexId:'uniswap',pool:address,ask:price,bid:price,time:startedAt,blockTime:startedAt,block:55,decimals:6,
      depth:{chain:1,pool:address,block:55,time:startedAt,dexId:'uniswap',protocol:'v2',feePpm:3000,
        token0:token,token1:CHAINS[1].usdc,decimals0:6,decimals1:6,reserve0:'10000000000000',reserve1:String(price*1e13)}};
  }
  const reference=pool('c',3); delete reference.depth;
  const markets=[pool('a',1),pool('b',2),reference];
  let completed=false;
  const scan=prepareScan({budget:1000,floor:5,startedAt,poolPass:async(_assets,_cex,onMarkets)=>{
    onMarkets(markets);
    await remaining.promise;
    return {markets};
  },onProgress(frame){if(frame.spotGaps.length)observed.resolve(frame)}
  }).then(result=>{completed=true;return result});
  try{
    const frame=await observed.promise;
    assert.equal(completed,false);
    assert.equal(frame.spotGaps[0].time,startedAt);
    assert.deepEqual(frame.recentMarkets.filter(m=>m.kind==='DEX').map(m=>m.pool),markets.map(m=>m.pool));
    assert.equal(frame.sources.find(s=>s.id==='pools-1').count,3);
    remaining.resolve();
    const {snapshot,verify}=await scan;
    assert.deepEqual(frame.spotGaps,snapshot.spotGaps);
    assert.equal(frame.diagnosticGaps[0].diagnosis.code,'depth_unverified');
    assert.deepEqual(frame.diagnosticGaps,snapshot.diagnosticGaps);
    const failed=[];
    assert.deepEqual(await verify(check=>failed.push(check)),[]);
    assert.equal(failed.length,1);
    assert.equal(failed[0].id,frame.spotGaps[0].id);
    assert.equal(failed[0].cycle,startedAt);
    assert.equal(failed[0].diagnosis.code,'unverified');
    assert.ok(!snapshot.eligible.includes(frame.diagnosticGaps[0].id));
    const full=await wideScan({budget:1000,floor:5,startedAt,poolPass:async()=>({markets})});
    const book=observationFrame(full,true);
    assert.equal(full.rows.length,0);
    assert.equal(book.routeChecks[0].diagnosis.code,'unverified');
    assert.deepEqual(book.diagnosticGaps,frame.diagnosticGaps);
  }finally{remaining.resolve();await scan;globalThis.fetch=original}
});

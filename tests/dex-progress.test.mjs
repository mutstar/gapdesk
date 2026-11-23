import test from 'node:test';
import assert from 'node:assert/strict';
import {CHAINS} from '../lib/assets.js';
import {readPools} from '../lib/pool-reader.mjs';
import {depthFactory} from '../lib/pool-depth.mjs';
import {createIndexedPoolReader} from '../lib/indexed-pools.mjs';

const chain=1, usdc=CHAINS[chain].usdc;
const addr=n=>'0x'+n.toString(16).padStart(40,'0');
const word=n=>BigInt(n).toString(16).padStart(64,'0');
const addressWord=a=>a.slice(2).padStart(64,'0');
const asset=token=>({chain,token,id:'dex:1:'+token,decimals:6,kind:'DEX',symbol:'X',ask:1,bid:1,time:Date.now()});

function responseWords(values) {
  const heads=[],bodies=[];
  let offset=32*values.length;
  for(const value of values){
    const body=word(1)+word(64)+word(value.length/2)+value;
    heads.push(word(offset));bodies.push(body);offset+=body.length/2;
  }
  return '0x'+word(32)+word(values.length)+heads.join('')+bodies.join('');
}

test('ready RPC pool streams before a deferred settlement pool, then updates with same-block depth',async()=>{
  const token=addr(15301),anchor='0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
  const pairs=[[token,anchor],[anchor,usdc]].map(([base,quote],i)=>({chain,base,quote,pool:addr(15311+i),dexId:'uniswap',protocol:'v2'}));
  const second=Promise.withResolvers(),firstSeen=Promise.withResolvers();
  const head=Math.floor(Date.now()/1000)-2;
  let request=0;
  const rpc=async(_,method)=>{
    if(method==='eth_getBlockByNumber')return {number:'0x245',timestamp:'0x'+head.toString(16)};
    const i=request++,{base,quote}=pairs[i];
    if(i===1)await second.promise;
    return responseWords([addressWord(depthFactory(chain,'uniswap','v2')),addressWord(base),addressWord(quote),word(1e12)+word(2e12)+word(0)]);
  };
  const frames=[];
  const scan=readPools(pairs,[asset(token),asset(anchor)],{rpc,batchSize:1,concurrency:1,intervalMs:0,
    onMarkets:markets=>{frames.push(markets);firstSeen.resolve();}});
  await Promise.race([firstSeen.promise,scan]);
  try {
    assert.equal(frames.length,1);assert.equal(frames[0][0].pool,pairs[0].pool);
    assert.equal(frames[0][0].time,head*1000);assert.deepEqual(frames[0][0].depthBridges,[]);
  } finally {second.resolve();}
  const result=await scan;
  assert.equal(result.markets.length,2);assert.equal(result.coverage[0].usdcDepthPools,2);
  const revised=frames[1].find(m=>m.pool===pairs[0].pool);
  assert.deepEqual(revised.depthBridges.map(m=>m.pool),[pairs[1].pool]);
  assert.deepEqual(frames[0][0].depthBridges,[]);assert.equal(revised.time,head*1000);
});

test('indexed batch emits independently with the upstream date and exact registered pool identity',async()=>{
  const base=addr(1040),date=new Date(Date.now()-10_000).toUTCString();
  const entries=Array.from({length:32},(_,i)=>({chain,base,quote:usdc,pool:addr(i+500),dexId:'somedex'}));
  const gate=Promise.withResolvers(),seen=Promise.withResolvers();
  const reader=createIndexedPoolReader({intervalMs:0,fetchImpl:async url=>{
    const ids=url.split('/').at(-1).split(',');
    if(ids.length===30)await gate.promise;
    return Response.json({pairs:ids.map(pool=>({chainId:'ethereum',pairAddress:pool,dexId:'somedex',
      baseToken:{address:pool===entries.at(-1).pool?addr(340):base},quoteToken:{address:usdc},priceNative:'2'}))},{headers:{date}});
  }});
  const frames=[];
  const scan=reader(entries,[asset(base)],{onMarkets:ms=>{frames.push(ms);seen.resolve();}});
  await Promise.race([seen.promise,scan]);
  try{
    assert.equal(frames.length,1);assert.equal(frames[0].length,1);assert.equal(frames[0][0].pool,entries[30].pool);
    assert.equal(frames[0][0].time,Date.parse(date));assert.equal(frames[0][0].depth,undefined);
  }finally{gate.resolve();}
  assert.equal((await scan).markets.length,31);
});

test('catalog and CEX overlap and a ready screener pool publishes while a full RPC pass is pending',async()=>{
  const saved=globalThis.fetch, token=addr(2071), pool=addr(2072);
  const cex=Promise.withResolvers(),rpc=Promise.withResolvers(),seen=Promise.withResolvers();
  const catalogs=new Set(),frames=[];
  globalThis.fetch=async url=>{
    const u=new URL(url);
    if(u.hostname==='li.quest'){
      const id=Number(u.searchParams.get('chains'));
      catalogs.add(id);
      const tokens=[{chainId:id,address:CHAINS[id].usdc,symbol:'USDC',priceUSD:'1',decimals:6}];
      if(id===1)tokens.push({chainId:id,address:token,symbol:'TOKEN',priceUSD:'1',decimals:6});
      return Response.json({tokens:{[id]:tokens}});
    }
    const pairs=u.pathname.includes('ethereum')&&u.pathname.includes(token)?[{
      chainId:'ethereum',dexId:'uniswap',pairAddress:pool,baseToken:{address:token},quoteToken:{address:usdc},priceNative:'1.1',
    }]:[];
    return Response.json(pairs);
  };
  const consume=batch=>{frames.push(batch);seen.resolve();};
  const {loadDex}=await import('../lib/dex-catalog.mjs?progress');
  let callback;
  const scan=loadDex([],0,[],{cexReady:cex.promise,onMarkets:consume,
    poolPass:async(_markets,_cex,emit)=>{callback=emit;await rpc.promise;return {markets:[],coverage:[]};}});
  try{
    assert.equal(catalogs.size,4);
    cex.resolve([]);
    await Promise.race([seen.promise,scan]);
    assert.equal(callback,consume);
    assert.ok(frames.flat().every(m=>!m.referenceOnly&&m.pool===pool));
    assert.ok(frames.flat().some(m=>m.token===token&&m.ask===1.1));
  }finally{
    cex.resolve([]);rpc.resolve();
    try{await scan;}finally{globalThis.fetch=saved;}
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {discover} from '../lib/universe.mjs';
import {poolValuationAssets} from '../lib/pool-anchors.mjs';
import {CHAINS,NATIVE} from '../lib/assets.js';

test('each 30s slot fetches all four catalogs and retains the upstream cache age', async () => {
  const {loadDex}=await import('../lib/dex-catalog.mjs?slots');
  const original=globalThis.fetch, seen=[];
  globalThis.fetch=async url=>{
    const u=new URL(url);
    if(u.pathname!=='/v1/tokens')return Response.json([]);
    const chain=Number(u.searchParams.get('chains'));
    seen.push(chain);
    return Response.json({tokens:{[chain]:[{address:CHAINS[chain].usdc,symbol:'USDC',chainId:chain,decimals:CHAINS[chain].decimals,priceUSD:'1'}]}},{headers:{age:'180'}});
  };
  try {
    const now=Math.floor(Date.now()/30000)*30000;
    const a=await loadDex([],0,[],{startedAt:now});
    await loadDex([],0,[],{startedAt:now});
    const b=await loadDex([],0,[],{startedAt:now+30000});
    assert.deepEqual(seen,[1,56,8453,42161,1,56,8453,42161]);
    assert.equal(b.poolCoverage.referenceContracts,4);
    assert.ok(a.markets.every(m=>m.time<=Date.now()-180000));
    const simulatedPool={...a.markets[0],id:'test-pool',reference:'pool',pool:'test',bid:2,ask:2,time:Date.now()};
    const {summaries,candidates}=discover([...a.markets,simulatedPool],1000,5);
    assert.equal(candidates.length,0);
    assert.equal(summaries[0].status,'기준가 시차 있음');
  } finally {globalThis.fetch=original;}
});

test('only the canonical wrapped native receives a current CEX anchor',()=>{
  const native={token:NATIVE,chain:8453}, wrapped='0x4200000000000000000000000000000000000006';
  const book={ask:2,bid:1.99,quote:'USDC',quoteReady:true,tradeEnabled:true,time:Date.now(),symbol:'ETH',networks:[native]};
  const assets=[wrapped,'0x1111111111111111111111111111111111111111'].map(token=>({chain:8453,token,symbol:'WETH',ask:null}));
  assert.deepEqual(poolValuationAssets(assets,[book]).map(a=>a.ask),[2,null]);
  assert.equal(poolValuationAssets(assets,[{...book,time:Date.now()-46000}])[0].ask,null);
});
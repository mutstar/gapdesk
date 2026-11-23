import test from 'node:test';
import assert from 'node:assert/strict';
import {CHAINS} from '../lib/assets.js';
import {spotRouteId} from '../lib/contract-identity.mjs';
import {discover} from '../lib/universe.mjs';

const token='0x'+'1'.repeat(40);
const match={chain:1,token};
function exchange(id,price,network={}){
  return {id,name:id,venue:id,symbol:'ABC',kind:'CEX',ask:price,bid:price,time:Date.now(),
    networks:[{...match,deposit:true,withdraw:true,decimals:6,minIn:0,minOut:0,fee:0,rate:0,...network}]};
}
function pool(hex,price){
  const address='0x'+hex.repeat(40), time=Date.now();
  return {...match,id:'dex:'+address,name:'Pool '+hex,kind:'DEX',dexId:'uniswap',symbol:'ABC',pool:address,
    ask:price,bid:price,time,blockTime:time,block:125,decimals:6,
    depth:{...match,pool:address,block:125,time,dexId:'uniswap',protocol:'v2',feePpm:3000,token0:token,
      token1:CHAINS[1].usdc,decimals0:6,decimals1:6,reserve0:'10000000000000',reserve1:String(price*1e13)}};
}

test('each spot venue family keeps its own best positive observation even below the qualification floor',()=>{
  const low=exchange('Low',1),high=exchange('High',1.25),a=pool('a',1.5),b=pool('b',2.2);
  const {spotGaps,candidates,summaries}=discover([low,high,a,b],1000,10000);
  assert.equal(candidates.length,0);
  assert.deepEqual(spotGaps.map(r=>[r.buy.id,r.sell.id]),[[low.id,b.id],[a.id,b.id],[low.id,high.id]]);
  assert.equal(summaries[0].gap,spotGaps[0].gap);
  for(const row of spotGaps){
    assert.equal(row.id,spotRouteId(row.buy.id,row.sell.id,match));
    assert.deepEqual(row.match,match);
    assert.equal(row.kind,'spot_spot');
    assert.equal(row.gap,(row.bid/row.ask-1)*100);
    assert.ok(row.time>0);
  }
});

test('mixed pairs preserve DEX-to-CEX direction and reject blocked, stale or namesake extremes',()=>{
  const a=pool('a',1),b=exchange('Sell',1.1);
  const closed=exchange('Blocked',2,{deposit:false}),foreign=exchange('Namesake',4,{token:'0x'+'2'.repeat(40)});
  const stale={...exchange('Stale',3),networkTime:Date.now()-46000};
  const {spotGaps}=discover([a,b,closed,foreign,stale],1000,1);
  assert.deepEqual(spotGaps.map(r=>[r.buy.kind,r.sell.kind,r.buy.id,r.sell.id]),[['DEX','CEX',a.id,b.id]]);
  assert.deepEqual(discover([a,b],1000,1,.1).spotGaps,[]);
});

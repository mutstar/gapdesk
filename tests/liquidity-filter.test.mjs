import test from 'node:test';
import assert from 'node:assert/strict';
import {CHAINS} from '../lib/assets.js';
import {discover} from '../lib/universe.mjs';

const ca='0x'+'1'.repeat(40),time=Date.now();
function pool(id,price,quantity){
  const pool='0x'+id.repeat(40);
  return {id:'dex:1:'+ca+':'+pool,kind:'DEX',dexId:'uniswap',name:'pool '+id,chain:1,symbol:'TEST',token:ca,
    pool,ask:price,bid:price,time,blockTime:time,block:123,decimals:6,
    depth:{pool,chain:1,block:123,time,dexId:'uniswap',protocol:'v2',feePpm:3000,token0:ca,token1:CHAINS[1].usdc,
      decimals0:6,decimals1:6,reserve0:String(quantity*1e6),reserve1:String(price*quantity*1e6)}};
}
test('thin and unmodeled pools never set displayed extremes or qualify, even with a huge apparent gap',()=>{
  const buy=pool('a',1,10000000),sell=pool('b',1.1,10000000),thin=pool('c',99,15);
  const unmodeled={...pool('d',120,10000000),depth:null,liquidityUSD:1e10};
  const markets=[buy,sell,thin,unmodeled];
  const result=discover(markets,1000,1,1);
  const [row]=result.summaries;
  assert.equal(result.depthCoverage.passed,2);
  assert.equal(result.depthCoverage.excluded,2);
  assert.equal(row.buy,buy.name);
  assert.equal(row.sell,sell.name);
  assert.ok(row.gap>9&&row.gap<10);
  assert.ok(result.candidates.every(p=>p.buy===buy&&p.sell===sell));
  assert.ok(result.candidates.length);
  const strict=discover(markets,1000,1,.1);
  assert.equal(strict.depthCoverage.passed,0);
  assert.equal(strict.summaries[0].gap,null);
  assert.equal(strict.candidates.length,0);
  const large=discover(markets,100000,1,1);
  assert.equal(large.summaries[0].gap,null);
});
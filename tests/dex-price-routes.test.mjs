import test from 'node:test';
import assert from 'node:assert/strict';
import {discover} from '../lib/universe.mjs';
import {dexPriceRoutes,qualifiedDexRoutes,visibleDexPrices} from '../lib/dex-price-routes.mjs';

test('every positive same-contract pool pair remains observable without depth or amount qualification',()=>{
  const now=Date.now(),token='0x'+'1'.repeat(40);
  const pool=(id,ask,bid,extra={})=>({id,pool:id,kind:'DEX',symbol:'ACE',chain:1,token,name:id,time:now,ask,bid,...extra});
  const pools=[pool('a',1,null),pool('b',2,2),pool('c',null,3),pool('other',9,9,{token:'0x'+'2'.repeat(40)}),
    pool('stale',100,100,{time:now-60000}),pool('duplicate',200,200,{pool:'a'}),pool('other-chain',99,99,{chain:56})];
  for(const budget of [10,10000]){
    const {dexPrices,candidates}=discover(pools,budget,200,0.01);
    const raw=dexPriceRoutes({dexPoolGroups:dexPrices});
    assert.deepEqual(raw.map(r=>[r.buy.pool,r.sell.pool]),[['a','b'],['a','c'],['b','c']]);
    assert.equal(candidates.length,0);
    assert.ok(visibleDexPrices(raw,now+46000,false).every(r=>r.previous));
    assert.equal(visibleDexPrices(raw,now+300000,false).length,0);
  }
});
test('qualified routes keep alternatives per CA and require fresh matching verified notional',()=>{
  const now=Date.now(),match={chain:1,token:'0x'+'3'.repeat(40)};
  const q={match,buyKind:'DEX',sellKind:'DEX',buy:'first',sell:'second',from:1,to:1,qty:10,arrival:10,proceeds:102,budget:100,maxImpact:1,profit:1,buyQuoteAt:now,sellQuoteAt:now,expires:now+40000};
  const rows=[{...q,id:'a'},{...q,id:'b'},{...q,id:'old',sellQuoteAt:now-45000}];
  assert.deepEqual(qualifiedDexRoutes(rows,100,1,1,now).map(r=>r.id),['a','b']);
  assert.equal(qualifiedDexRoutes(rows,100,2,1,now).length,0);
  assert.equal(qualifiedDexRoutes(rows,500,1,1,now).length,0);
});

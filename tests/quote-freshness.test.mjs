import test from 'node:test';
import assert from 'node:assert/strict';
import { qualify } from '../lib/qualification.mjs';
import { isFreshQualified, QUOTE_MAX_AGE_MS } from '../lib/quote-freshness.mjs';

test('both leg times and the route expiry are checked whenever a qualified row is used',()=>{
  const now=1_800_000_000_000, row={buyQuoteAt:now-5,sellQuoteAt:now,expires:now+100_000};
  assert.equal(isFreshQualified(row,now),true);
  for(const side of ['buyQuoteAt','sellQuoteAt']){
    for(const bad of [undefined,null,NaN,0,'0',now+1,now-QUOTE_MAX_AGE_MS]){
      assert.equal(isFreshQualified({...row,[side]:bad},now),false);
    }
    assert.equal(isFreshQualified({...row,[side]:now-QUOTE_MAX_AGE_MS+1},now),true);
  }
  assert.equal(isFreshQualified(row,now+QUOTE_MAX_AGE_MS-5),false);
  assert.equal(isFreshQualified({...row,expires:now},now),false);
  assert.equal(isFreshQualified({expires:now+1000},now),false);
});

test('a fresh main book cannot hide an expired, missing or future FX leg',async()=>{
  const now=Date.now(), token='0x'+'1'.repeat(40);
  const networks=[{chain:8453,token,decimals:6,deposit:true,withdraw:true,minOut:0,minIn:0,fee:0,rate:0}];
  const buy={id:'a',kind:'CEX',symbol:'ACE',quote:'USDT',networks}, sell={...buy,id:'b',quote:'USDC'};
  const book=(price,time)=>({asks:[[price,10000]],bids:[[price,10000]],time,fee:0,step:1,min:1});
  const run=fx=>qualify({buy,sell},1000,5,undefined,{},{
    nets:async()=>networks,
    book:async market=>market.id===buy.id?{...book(10,now-1000),fx}:book(12,now-2000)
  });
  const result=await run(book(1,now-5000));
  assert.deepEqual([result.buyQuoteAt,result.sellQuoteAt,result.expires],[now-5000,now-2000,now-5000+QUOTE_MAX_AGE_MS]);
  for(const fx of [null,book(1,now-QUOTE_MAX_AGE_MS),book(1,now+10000)])assert.equal(await run(fx),null);
});

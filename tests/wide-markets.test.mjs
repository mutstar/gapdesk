import test from 'node:test';
import assert from 'node:assert/strict';
import {wideMarkets} from '../lib/wide-markets.mjs';
import {discover} from '../lib/universe.mjs';

test('public CEX prices retain quote units; only identified, two-sided and convertible rows can form an observed gap',()=>{
  const t=Date.now(),token='0x'+'a'.repeat(40);
  const row=(b,q,a,p,ts=t,last=null)=>[b,q,null,b+'-'+q,a,p,10,10,.01,ts,last];
  const file={id:'example',venue:'example',name:'Example',catalogAt:t,networks:{ACE:[[56,token]]},modes:{
    spot:{total:5,rows:[row('USDC','KRW',1501,1500),row('ACE','KRW',150,145),row('LAST','KRW',null,null,t,130),
      row('OLD','KRW',20,19,t-45001),row('UNKNOWN','USD',1,.9)]},
    swap:{total:1,rows:[['ACE','USDT','USDT','ACE_USDT',1.1,1.0,3,4,.1,t,1]]}}};
  const native={venue:'gate',kind:'CEX',name:'Gate.io',id:'gate:ACE_USDT',symbol:'ACE',ask:.21,bid:.2,quote:'USDC',
    networks:[{chain:56,token}],time:t,tradeEnabled:true,observationOnly:true,settlementFx:{ask:1,bid:1,time:t}};
  const wide=wideMarkets([file],[native],t);
  assert.equal(wide.batches[0].source.count,4);assert.equal(wide.batches[0].source.books,3);
  assert.equal(wide.feeds[0].markets[0].spotAnchorIds.length,0);
  const ace=wide.batches[0].rows.find(x=>x.symbol==='ACE');
  assert.ok(Math.abs(ace.ask-.1)<1e-12); assert.ok(Math.abs(ace.bid-145/1501)<1e-12);assert.ok(ace.observationOnly);
  assert.ok(wide.samples.some(s=>s.id.endsWith(':last:KRW')&&s.bid===130));
  assert.equal(wide.batches[0].rows.find(x=>x.symbol==='UNKNOWN').ask,null);
  const result=discover([native,...wide.batches[0].rows],1000,5,1,true);
  assert.equal(result.candidates.length,0);
  assert.ok(result.signalData.gaps.some(g=>g.buy==='Example 현물'&&g.sell==='Gate.io'&&g.match.token===token));
});

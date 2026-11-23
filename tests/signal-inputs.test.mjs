import test from 'node:test';
import assert from 'node:assert/strict';
import {signalInputs} from '../lib/signal-inputs.mjs';
const market=(id,name,ask,bid)=>({id,venue:id,kind:'CEX',name,symbol:'ACE',networks:[],ask,bid,time:Date.now()});
test('blocked observation records exact venue sides, preserves lack of evidence, and never joins known namesakes',()=>{
 const a=market('left','KuCoin',1,0.99),b={...market('bithumb','빗썸',2.1,2),depositOpen:false,observationOnly:true};
 const other=market('other','Bitget',3,2.99),ms=[a,b,other];
 const marks=new Map(ms.map(m=>[m.id,{buy:m.ask,sell:m.bid}]));
 const ids=new Map([[a.id,'canonical'],[other.id,'another']]);
 const {gaps,samples,marketIds}=signalInputs(ms,marks,ids,[],1000,5);
 const entry=gaps.find(r=>r.id==='left|bithumb');
 assert.equal(entry.blocked,'매도처 입금 중단');assert.equal(entry.gap,100);
 assert.ok(!gaps.some(r=>r.id==='left|other'));
 b.depositOpen=null;
 assert.equal(signalInputs(ms,marks,ids,[],1000,5).gaps.find(r=>r.id===entry.id).blocked,null);
 assert.equal(samples.find(r=>r.venue==='bithumb').asset,null);assert.equal(marketIds.length,3);
});

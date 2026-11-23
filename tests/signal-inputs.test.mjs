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
 assert.equal(gaps.length,0);
 const ca={chain:1,token:'0x'+'1'.repeat(40)};
 a.networks=[ca];b.networks=[ca];b.symbol='ALIAS';other.networks=[{...ca,token:'0x'+'2'.repeat(40)}];
 const entry=signalInputs(ms,marks,ids,[],1000,5).gaps.find(r=>r.id.startsWith('left|bithumb~ca='));
 assert.deepEqual(entry.match,ca);
 assert.equal(entry.blocked,'매도처 입금 중단');assert.equal(entry.gap,100);
 assert.ok(!gaps.some(r=>r.id==='left|other'));
 b.depositOpen=null;
 assert.ok(!signalInputs(ms,marks,ids,[],1000,5).gaps.some(r=>r.id===entry.id));
 assert.equal(samples.find(r=>r.venue==='bithumb').asset,null);assert.equal(marketIds.length,3);
});

test('DEX pool observations at the configured gross floor are archived only as unverified',()=>{
 const at=Date.now(),base={symbol:'ACE',kind:'DEX',dexId:'uniswap',name:'Uniswap V4',chain:56,token:'0x'+'1'.repeat(40),time:at};
 const left={...base,id:'dex:left',pool:'0x'+'a'.repeat(64),ask:1,bid:1};
 const right={...base,id:'dex:right',pool:'0x'+'b'.repeat(64),ask:1.001,bid:1.001};
 const read=(floor)=>signalInputs([left,right],new Map(),new Map(),[],1000,floor).gaps;
 assert.equal(read(1).length,1);assert.match(read(1)[0].reason,/미검증/);
 assert.equal(read(1.01).length,0);
});

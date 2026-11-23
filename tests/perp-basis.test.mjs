import test from 'node:test';
import assert from 'node:assert/strict';
import {perpBasis} from '../lib/perp-basis.mjs';

const now=1700000000000;
const contract={chain:42161,token:'0x25118290e6a5f4139381d072181157035864099d'};
const otherContract={chain:42161,token:'0x7afb5689bfeab0e906ec437b6d49ce24bdf3a5ca'};
const spot={id:'bitget:ACEUSDT',symbol:'ACE',venue:'bitget',pair:'ACEUSDT',name:'Bitget',kind:'CEX',quote:'USDT',time:now,
  ask:10,bid:9.99,askSize:200,bidSize:200,step:.1,networks:[contract],networkTime:now,tradeEnabled:true};
const fx={time:now,bid:1,ask:1};
const perp={...spot,spotAnchorIds:[spot.id],id:'bitget:perp:ACEUSDT',contract:'ACEUSDT',kind:'PERP',ask:10.5,bid:10.4,step:.3};
function scan({spots=[spot],perps=[perp],rates=fx,budget=1000}={}){
 return perpBasis({spots,marks:new Map(spots.map(m=>[m.id,{buy:m.ask,sell:m.bid}])),
   feeds:perps.map(m=>({source:{venue:m.venue},fx:rates,markets:[m]})),budget,maxImpact:1,now});
}
test('checks both directions with matched quantities and venue FX',()=>{
 const cash={...spot,quote:'USDC'};
 const a=scan({spots:[cash]}).book.rows[0];
 assert.equal(a.buy.kind,'CEX');assert.equal(a.sell.kind,'PERP');assert.ok(Math.abs(a.qty-99.9)<1e-9);
 assert.ok(Math.abs(a.gap-4)<1e-9);
 const b=scan({spots:[cash],rates:{...fx,ask:1.2,bid:1.19}}).book.rows[0];
 assert.equal(b.buy.kind,'PERP');assert.equal(b.sell.kind,'CEX');
 assert.ok(Math.abs(b.ask-perp.ask/1.19)<1e-9);
});
test('excludes stale, crossed in time, under-sized, mismatched or unanchored legs',()=>{
 for(const p of [{time:now-46000},{time:now-20000},{bidSize:99},{minQty:110},{maxQty:90},{spotAnchorIds:['other']} ]){
  const other={...spot,venue:'kucoin',id:'other',networks:[otherContract],askSize:0,bidSize:0};
  assert.deepEqual(scan({spots:[{...spot,quote:'USDC'},other],perps:[{...perp,...p}]}).book.rows,[]);
 }
 assert.deepEqual(scan({rates:{...fx,time:now-46000}}).book.rows,[]);
});
test('compares only identical exposure on the common lot of two perpetual contracts',()=>{
 const other={...perp,venue:'kucoin',id:'kucoin:perp:ACEUSDTM',spotAnchorIds:[spot.id],step:.2,ask:11.1,bid:11};
 const r=scan({spots:[{...spot,quote:'USDC'}],perps:[perp,other]}).book.rows.find(r=>r.kind==='perp_perp');
 assert.ok(r);assert.equal(r.sell.id,other.id);assert.ok(Math.abs(r.qty/.6-Math.round(r.qty/.6))<1e-8);
});
test('requires the exact chain and contract on both sides, irrespective of ticker or venue labels',()=>{
 const anchor={...spot,quote:'USDC',askSize:0,bidSize:0};
 const opposite={...spot,id:'kucoin:RAIN-USDC',name:'KuCoin',venue:'kucoin',quote:'USDC'};
 for(const networks of [[],[otherContract],[{...contract,chain:1}],[{chain:1,token:'0x'+'0'.repeat(40)}]]){
   assert.deepEqual(scan({spots:[anchor,{...opposite,networks}]}).book.rows,[]);
 }
 const valid={...opposite,symbol:'ALIAS'};
 const row=scan({spots:[anchor,valid]}).book.rows[0];
 assert.equal(row.buy.id,valid.id);assert.deepEqual(row.match,contract);
 const later=scan({spots:[{...anchor,networkTime:now-30000},valid]}).book.rows[0];
 assert.equal(later.time,now-30000);
 assert.equal(scan({spots:[{...valid,networkTime:now-46000},anchor]}).book.rows.length,0);
 for(const ids of [undefined,[],['missing'],[spot.id,'missing']]){
   assert.equal(scan({spots:[anchor,opposite],perps:[{...perp,spotAnchorIds:ids}]}).book.matched,0);
 }
});
test('conflicting constituents and multiple addresses on one chain fail closed',()=>{
 const first={...spot,quote:'USDC'},second={...first,id:'kucoin:ACE-USDT',networks:[otherContract]};
 const joined={...perp,spotAnchorIds:[first.id,second.id]};
 assert.equal(scan({spots:[first,second],perps:[joined]}).book.matched,0);
 assert.equal(scan({spots:[{...first,networks:[contract,otherContract]}]}).book.matched,0);
 const noNative={...first,symbol:'ETH',networks:[{chain:1,token:'0x'+'0'.repeat(40)}]};
 assert.equal(scan({spots:[noNative],perps:[{...perp,symbol:'ETH'}]}).book.matched,0);
});
test('the common contract is derived from all anchor networks without duplicating a market pair',()=>{
 const chainB={...otherContract,chain:56};
 const member={...spot,quote:'USDC',networks:[chainB,contract]};
 const cross={...member,id:'kucoin:ACE-USDT',networks:[contract],askSize:0,bidSize:0};
 const joined={...perp,spotAnchorIds:[member.id,cross.id]};
 const a=scan({spots:[member,cross],perps:[joined]});
 assert.equal(a.book.rows.length,1);assert.deepEqual(a.book.rows[0].match,contract);
 assert.equal(a.samples[0].asset,'42161:'+contract.token);
 const b=scan({spots:[member]});
 assert.equal(b.book.rows.length,1);assert.equal(b.samples[0].asset,null);
 const reversed=scan({spots:[{...member,networks:[contract,chainB]}]});
 assert.deepEqual(b.book.rows[0].match,reversed.book.rows[0].match);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {perpBasis} from '../lib/perp-basis.mjs';

const now=1700000000000;
const spot={id:'bitget:ACEUSDT',symbol:'ACE',venue:'bitget',pair:'ACEUSDT',name:'Bitget',kind:'CEX',quote:'USDT',time:now,
  ask:10,bid:9.99,askSize:200,bidSize:200,step:.1,networks:[],tradeEnabled:true};
const fx={time:now,bid:1,ask:1};
const perp={...spot,id:'bitget:perp:ACEUSDT',contract:'ACEUSDT',kind:'PERP',ask:10.5,bid:10.4,step:.3};
function scan({spots=[spot],assets=['asset'],perps=[perp],rates=fx,budget=1000}={}){
 return perpBasis({spots,identityOf:new Map(spots.map((m,i)=>[m.id,assets[i]])),marks:new Map(spots.map(m=>[m.id,{buy:m.ask,sell:m.bid}])),
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
 for(const p of [{time:now-46000},{time:now-20000},{bidSize:99},{symbol:'OTHER'},{minQty:110},{maxQty:90},{spotAnchorIds:['other']} ]){
  const other={...spot,venue:'kucoin',id:'other',askSize:0,bidSize:0};
  assert.deepEqual(scan({spots:[{...spot,quote:'USDC'},other],assets:['a','b'],perps:[{...perp,...p}]}).book.rows,[]);
 }
 assert.deepEqual(scan({rates:{...fx,time:now-46000}}).book.rows,[]);
});
test('compares only identical exposure on the common lot of two perpetual contracts',()=>{
 const other={...perp,venue:'kucoin',id:'kucoin:perp:ACEUSDTM',spotAnchorIds:[spot.id],step:.2,ask:11.1,bid:11};
 const r=scan({spots:[{...spot,quote:'USDC'}],perps:[perp,other]}).book.rows.find(r=>r.kind==='perp_perp');
 assert.ok(r);assert.equal(r.sell.id,other.id);assert.ok(Math.abs(r.qty/.6-Math.round(r.qty/.6))<1e-8);
});
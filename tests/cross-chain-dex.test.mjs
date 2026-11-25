import test from 'node:test';
import assert from 'node:assert/strict';
import {discover} from '../lib/universe.mjs';
import {dexPriceRoutes} from '../lib/dex-price-routes.mjs';
import {qualify} from '../lib/qualification.mjs';
import {routeContractsMatch} from '../lib/contract-identity.mjs';
import {steps} from '../lib/wallet.js';
const addr=n=>'0x'+String(n).repeat(40);
function fixture(){
  const time=Date.now();
  const pool=(id,chain,token,price)=>({id,kind:'DEX',name:id,chain,token,decimals:6,pool:addr(8),symbol:'TEST',
    ask:price,bid:price,time,reference:'venue-index',observationOnly:false});
  const b=pool('base',8453,addr(1),10),s=pool('arb',42161,addr(2),12);
  const exchange={id:'listing',kind:'CEX',name:'listing',venue:'listing',symbol:'TEST',networks:[b,s],networkTime:time};
  return {b,s,exchange};
}
test('cross-chain singleton pools require a direct, recent, unambiguous CA listing',()=>{
  const {b,s,exchange}=fixture();
  const raw=markets=>dexPriceRoutes({dexPoolGroups:discover(markets,1000,1).dexPrices},'cross');
  const [r]=raw([b,{...s,symbol:'ALIAS'},exchange]);
  assert.deepEqual([r.match.token,r.targetMatch.token,r.buy.chain,r.sell.chain,r.identitySource],[b.token,s.token,b.chain,s.chain,'listing']);
  assert.equal(raw([b,{...s,token:b.token}]).length,0);
  assert.equal(raw([b,s,{...exchange,networkTime:0}]).length,0);
  assert.equal(raw([b,s,{...exchange,networks:[b,s,{...s,token:addr(3)}]}]).length,0);
  const mid={chain:1,token:addr(3)};
  assert.equal(raw([b,s,{...exchange,networks:[b,mid]},{...exchange,id:'other',networks:[mid,s]}]).length,0);
});
test('cross-chain qualification chains minimum outputs through exact pools and bridge, deducts gas and expires',async()=>{
  const {b,s,exchange}=fixture(),[pair]=discover([b,s,exchange],1000,1).candidates.filter(c=>c.targetMatch);
  const inputs=[];
  const quote=async(from,to,src,dst,amount)=>{
    inputs.push(amount);
    const bridge=from!==to,buy=from===b.chain&&!bridge;
    return {fromChain:from,toChain:to,fromToken:src,toToken:dst,inputUnits:amount,pool:bridge?null:b.pool,
      minimum:bridge?'99000000':buy?'100000000':'1188000000',fromDecimals:6,toDecimals:6,at:Date.now(),gas:1,tool:bridge?'bridge':'swap',duration:12};
  };
  const run=(change=x=>x,floor=1)=>qualify(pair,1000,floor,addr(4),{},{gas:async()=>0,quote:async(...args)=>change(await quote(...args),args)});
  const row=await run();
  assert.ok(routeContractsMatch(row));
  assert.equal(routeContractsMatch({...row,toToken:b.token}),false);
  assert.deepEqual(inputs,['1000000000','100000000','99000000']);
  assert.equal(row.profit,184.7);
  assert.deepEqual(steps(row).map(step=>step.side),['buy','bridge','sell']);
  for(const replacement of [null,{toToken:b.token},{at:Date.now()-60000},{inputUnits:'1'},{gas:200},{minimum:'0'},{tool:null}]){
    assert.equal(await run(q=>q.tool==='bridge'?(replacement&&{...q,...replacement}):q),null);
  }
  assert.equal(await run(q=>q.tool==='swap'?{...q,pool:addr(9)}:q),null);
  assert.equal(await run(q=>q,185),null);
});

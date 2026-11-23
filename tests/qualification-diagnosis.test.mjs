import test from 'node:test';
import assert from 'node:assert/strict';
import {qualify} from '../lib/qualification.mjs';
import {CHAINS} from '../lib/assets.js';
const token='0x'+'1'.repeat(40);
const network={chain:8453,token,decimals:6,tokenDecimals:6,deposit:true,withdraw:true,minOut:0,minIn:0,fee:0,rate:0};
const venue=(name,price)=>({id:name,venue:name,name,symbol:'ACE',kind:'CEX',quote:'USDC',ask:price,bid:price,networks:[network]});
const buy=venue('KuCoin',10),sell=venue('Bitget',11);
const book=(price,overrides={})=>({bids:[[price,10000]],asks:[[price,10000]],step:0.000001,fee:0,min:1,time:Date.now(),...overrides});
async function attempt({pair={buy,sell,match:network},floor=5,impact=1,...io}={}){
  const failures=[];let below=false;
  const row=await qualify(pair,1000,floor,undefined,{},{nets:m=>m.networks,book:m=>book(m.ask),
    onBelowFloor:()=>below=true,onDiagnosis:r=>failures.push(r),...io},impact);
  assert.equal(failures.length,row?0:1);
  return {row,diagnosis:failures[0],below};
}
test('precision recheck labels confirmed transfer halts separately from absent network proof',async()=>{
  for(const [market,field,expected] of [[buy,'withdraw','withdraw_closed'],[sell,'deposit','deposit_closed']]){
    const failed=await attempt({nets:m=>m===market?[{...network,[field]:false,[field+'Open']:false}]:[network]});
    assert.equal(failed.diagnosis.code,expected);
    const unknown=await attempt({nets:m=>m===market?[{...network,[field]:false}]:[network]});
    assert.equal(unknown.diagnosis.code,'transfer_unverified');
  }
  const lookup=await attempt({nets(){throw Error('private-secret')}});
  assert.equal(lookup.diagnosis.code,'transfer_unverified');assert.doesNotMatch(lookup.diagnosis.detail,/private-secret/);
});
test('the live amount determines minimum transfer and order ladder failures',async()=>{
  const min=await attempt({nets:m=>m===sell?[{...network,minIn:150}]:[network]});
  assert.equal(min.diagnosis.code,'transfer_limit');assert.match(min.diagnosis.detail,/100 ACE.*150 ACE/);
  const thin=await attempt({book:m=>m===buy?book(10,{asks:[[10,2],[11,3]]}):book(11)});
  assert.equal(thin.diagnosis.code,'depth');assert.match(thin.diagnosis.detail,/53 USDC.*1,000 USDC/);
  const unknown=await attempt({book:m=>m===buy?book(10,{asks:[]}):book(11)});
  assert.equal(unknown.diagnosis.code,'depth_unverified');
});
test('diagnosis names aging legs and never interprets missing/future FX as a stale price',async()=>{
  const stale=await attempt({book:m=>book(m.ask,{time:Date.now()-(m===sell?51000:0)})});
  assert.equal(stale.diagnosis.code,'stale_quote');assert.match(stale.diagnosis.detail,/Bitget 매도.*51초/);
  for(const fx of [undefined,book(1,{time:Date.now()+2000})]){
    const missing=await attempt({pair:{buy:{...buy,quote:'USDT'},sell},book:m=>book(m.ask,{fx})});
    assert.equal(missing.diagnosis.code,'unverified');assert.match(missing.diagnosis.detail,/환전/);
  }
});
test('fees are blamed only when removing them from the same order books would clear the floor',async()=>{
  assert.ok((await attempt()).row);
  const expensive=await attempt({nets:m=>m===buy?[{...network,fee:9}]:[network]});
  assert.equal(expensive.diagnosis.code,'fees');assert.match(expensive.diagnosis.detail,/100 USDC.*1 USDC.*5 USDC/);assert.equal(expensive.below,true);
  const repriced=await attempt({book:m=>book(m===buy?10:10.01,{fee:0.001})});
  assert.equal(repriced.diagnosis.code,'below_floor');
  const feeFallback=await attempt({book:m=>m===buy?book(10,{asks:[[10,98]],fee:0.04}):book(10.4)});
  assert.equal(feeFallback.diagnosis.code,'below_floor');
});
test('only a fully matched and modeled pool yields a numeric impact reason',async()=>{
  const at=Date.now(),pool='0x'+'3'.repeat(40),stable=CHAINS[8453].usdc;
  const dex={...buy,kind:'DEX',pool,token,chain:8453,block:99,blockTime:at,time:at,decimals:6,
    depth:{chain:8453,pool,block:99,time:at,dexId:'uniswap',protocol:'v2',feePpm:3000,token0:token,token1:stable,
      decimals0:6,decimals1:6,reserve0:'10000000000',reserve1:'10000000000'}};
  const pair={buy:dex,sell};
  const slip=await attempt({pair,impact:1});
  assert.equal(slip.diagnosis.code,'slippage');assert.match(slip.diagnosis.detail,/10\..*1%/);
  const missing=await attempt({pair:{buy:{...dex,depth:undefined},sell}});
  assert.equal(missing.diagnosis.code,'depth_unverified');
  const big={...dex,depth:{...dex.depth,reserve0:'100000000000000',reserve1:'100000000000000'}};
  const quote=async(from,to,src,dst,input)=>({fromChain:from,toChain:to,fromToken:src,toToken:dst,inputUnits:input,minimum:'900000000',
    fromDecimals:6,toDecimals:6,at:Date.now(),gas:0});
  const router=await attempt({pair:{buy:big,sell},quote});
  assert.equal(router.diagnosis.code,'slippage');assert.match(router.diagnosis.detail,/라우터.*11\./);
});

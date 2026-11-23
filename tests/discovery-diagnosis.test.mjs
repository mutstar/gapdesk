import test from 'node:test';
import assert from 'node:assert/strict';
import {discover} from '../lib/universe.mjs';
import {transferStatus} from '../lib/contract-identity.mjs';
import {CHAINS} from '../lib/assets.js';
const ca='0x'+'1'.repeat(40);
function exchange(name,px,network={},extra={}){
  const time=Date.now();
  return {kind:'CEX',id:name,name,venue:name,symbol:'ACE',ask:px,bid:px,time,networkTime:time,networks:[
    {chain:1,token:ca,withdraw:true,deposit:true,minIn:0,minOut:0,fee:0,rate:0,decimals:6,...network}],...extra};
}
function pool(price){
  const time=Date.now(),address='0x'+'2'.repeat(40);
  return {chain:1,token:ca,id:'pool',pool:address,name:'Uniswap',symbol:'ACE',kind:'DEX',
    ask:price,bid:price,blockTime:time,time,block:1,depth:{chain:1,pool:address,block:1,time,dexId:'uniswap',protocol:'v2',
      token0:ca,token1:CHAINS[1].usdc,decimals0:6,decimals1:6,feePpm:3000,reserve0:'10000000000',reserve1:String(price*1e10)}};
}
function blocked(a,b,budget=1000,impact=1){
  const d=discover([a,b],budget,5,impact,true);
  assert.equal(d.spotGaps.length,0);
  assert.equal(d.candidates.length,0);
  assert.ok(d.signalData.gaps.every(g=>g.blocked));
  assert.equal(d.diagnosticGaps.length,1);
  const [r]=d.diagnosticGaps;
  assert.equal(r.buy.id,a.id);assert.equal(r.sell.id,b.id);
  assert.equal(r.buyQuoteAt,a.time);assert.equal(r.sellQuoteAt,b.time);
  return r.diagnosis;
}
test('closed transfer is directional, same CA, and different from missing transfer metadata',()=>{
  const a=exchange('KuCoin',1),b=exchange('Bitget',2);
  assert.equal(blocked(a,exchange('Bitget',2,{deposit:false,depositOpen:false})).code,'deposit_closed');
  assert.equal(blocked(exchange('KuCoin',1,{withdraw:false,withdrawOpen:false}, {observationOnly:true}),b).code,'withdraw_closed');
  assert.equal(blocked(a,exchange('Bitget',2,{deposit:false,depositOpen:null})).code,'transfer_unverified');
  assert.match(blocked(exchange('KuCoin',1,{withdraw:false,withdrawOpen:false}),exchange('Bitget',2,{deposit:false,depositOpen:false})).detail,/Ethereum .*KuCoin 출금 중단 .*Bitget 입금 중단/);
  assert.equal(discover([a,exchange('Other',5,{chain:56})],1000,5).diagnosticGaps.length,0);
  assert.equal(discover([a,exchange('Other',5,{token:'0x'+'3'.repeat(40)})],1000,5).diagnosticGaps.length,0);
  assert.equal(discover([a,exchange('Bitget',2,{withdraw:false,withdrawOpen:false})],1000,5).spotGaps.length,1);
});
test('min transfer limits use the entered amount and remaining qty after withdrawal fees',()=>{
  const a=exchange('KuCoin',1,{fee:10}),b=exchange('Bitget',2,{minIn:95});
  const status=blocked(a,b,100);
  assert.equal(status.code,'transfer_limit');assert.match(status.detail,/90 ACE .*95 ACE/);
  assert.equal(discover([a,b],110,5).spotGaps.length,1);
});
test('separates expired quote, expired network status and missing depth from measured pool price impact',()=>{
  const now=Date.now(),cex=exchange('sale',2),dex=pool(1);
  assert.equal(blocked(exchange('buy',1,{}, {time:now-50000,quoteReady:false}),cex).code,'stale_quote');
  assert.equal(blocked(exchange('buy',1,{}, {networkTime:now-50000}),cex).code,'stale_network');
  assert.equal(blocked({...dex,depth:null},cex).code,'depth_unverified');
  const issue=blocked(dex,cex);
  assert.equal(issue.code,'slippage');assert.match(issue.detail,/Uniswap 매수 .*% .*1%/);
  assert.equal(discover([dex,cex],10,5).spotGaps.length,1);
});
test('observations report gross floor, fee-proven upper bound, or pending using the entered budget',()=>{
  const a=exchange('buy',1,{fee:1},{tradeFee:.001}),b=exchange('sale',1.01,{}, {tradeFee:.001});
  const diag=(budget,floor)=>discover([a,b],budget,floor).spotGaps[0].diagnosis;
  assert.equal(diag(100,5).code,'gross_below_floor');
  assert.equal(diag(1000,8).code,'fees');
  assert.equal(diag(1000,5).code,'pending');
  assert.equal(discover([{...a,tradeFee:null},b],1000,8).spotGaps[0].diagnosis.code,'pending');
});
test('shows one rejected and one screened route per chain/CA/family, without promoting rejections',()=>{
  const venues=[exchange('buy',1),exchange('sale',1.1),exchange('closed',1.5,{deposit:false,depositOpen:false}),exchange('blocked',1.2,{deposit:false,depositOpen:false})];
  const {spotGaps,diagnosticGaps,candidates}=discover(venues,1000,5);
  assert.equal(spotGaps[0].sell.name,'sale');
  assert.equal(diagnosticGaps.length,1);assert.equal(diagnosticGaps[0].sell.name,'closed');
  assert.ok(!candidates.some(c=>c.id===diagnosticGaps[0].id));
  assert.deepEqual(diagnosticGaps,discover(venues,1000,5,1,false,true).diagnosticGaps);
});

test('venue labels use the matched chain and contract, and preserve independent exchange flags',()=>{
  const a=exchange('buyer',1,{withdrawOpen:true,depositOpen:false});
  const b=exchange('seller',1.1,{withdrawOpen:false,depositOpen:true});
  b.networks.push({...b.networks[0],chain:56,withdrawOpen:true,depositOpen:false});
  const discovered=discover([a,b],1000,5,1);
  const gap=discovered.spotGaps.find(g=>g.match.chain===1);
  const asset=discovered.summaries.find(g=>g.match?.chain===1);
  assert.deepEqual(gap.buy.transfer,{deposit:false,withdraw:true,at:a.networkTime});
  assert.deepEqual(asset.sellTransfer,{deposit:true,withdraw:false,at:b.networkTime});
  assert.deepEqual(gap.sell.transfer,asset.sellTransfer);
  assert.equal(asset.sellKind,'CEX');
  assert.deepEqual(transferStatus(b,{chain:1,token:'0x'+'2'.repeat(40)}),{deposit:null,withdraw:null,at:b.networkTime});
  b.networks.push({...b.networks[0],depositOpen:false});
  assert.deepEqual(transferStatus(b,gap.match),{deposit:null,withdraw:false,at:b.networkTime});
  assert.equal(transferStatus(pool(1),gap.match),undefined);
});

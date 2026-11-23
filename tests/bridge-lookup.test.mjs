import test from 'node:test';
import assert from 'node:assert/strict';
import {lookupBridge} from '../lib/bridge-lookup.mjs';
import {CHAINS,NATIVE} from '../lib/assets.js';

const input={from:8453,to:42161,fromToken:CHAINS[8453].usdc,toToken:CHAINS[42161].usdc,budget:1000};
const wallet='0x0000000000000000000000000000000000000001';
const fixture=(fetch)=>({fetch,cooldowns:new Map()});
function lifi(url,fromDecimals=6,toDecimals=6,min='999000000') {
  const q=new URL(url).searchParams, from=Number(q.get('fromChain')), to=Number(q.get('toChain'));
  return {action:{fromChainId:from,toChainId:to,fromAddress:wallet,toAddress:wallet,fromAmount:q.get('fromAmount'),
    fromToken:{address:q.get('fromToken'),decimals:fromDecimals},toToken:{address:q.get('toToken'),decimals:toDecimals}},
    tool:'lifi',estimate:{executionDuration:20,gasCosts:[{amountUSD:'0.01'}],toAmountMin:min,toAmount:min},
    includedSteps:[{tool:'same-chain swap',action:{fromChainId:from,toChainId:from}},
      {tool:'across',toolDetails:{name:'Across'},action:{fromChainId:from,toChainId:to}}],
    transactionRequest:{to:'0x'+'a'.repeat(40),chainId:from,data:'0x12345678'}};
}
function relay(body) {
  const {originChainId:from,destinationChainId:to,originCurrency:input,destinationCurrency:output,amount}=JSON.parse(body);
  return {details:{sender:wallet,recipient:wallet,currencyIn:{amount,currency:{chainId:from,address:input,decimals:6}},
    currencyOut:{minimumAmount:'998000000',amount:'999000000',currency:{chainId:to,address:output,decimals:6}},timeEstimate:3},
    steps:[{kind:'transaction',id:'deposit',items:[{data:{from:wallet,to:'0x'+'b'.repeat(40),data:'0x98765432',chainId:from}}]}]};
}
test('display uses the actual nested bridge and minimum receive amount; tx stays private to the provider response',async()=>{
  const result=await lookupBridge(input,fixture(async url=>Response.json(lifi(url))));
  assert.equal(result.provider,'Across');assert.equal(result.minReceive,'999');assert.equal(result.sendAmount,'1000');
  assert.equal(result.duration,20);assert.equal(result.gasUSD,.01);
  assert.equal(result.expires-result.at,45000);assert.equal('transactionRequest' in result,false);
});
test('a non-USDC bridge uses exact atomic minimum from the buy leg',async()=>{
  const requests=[];
  const result=await lookupBridge({...input,fromToken:NATIVE,toToken:NATIVE},fixture(async url=>{
    const q=new URL(url).searchParams;requests.push(q);
    return Response.json(requests.length===1?lifi(url,6,18,'1234567890123456789'):lifi(url,18,18,'1200000000000000000'));
  }));
  assert.equal(requests[1].get('fromAmount'),'1234567890123456789');
  assert.equal(result.sendAmount,'1.234567890123456789');assert.equal(result.minReceive,'1.2');
});
test('a rate-limited router can fall back to a fresh Relay quote, with no further requests during cooldown',async()=>{
  let count=0;
  const opts=fixture(async(url,options)=>{
    if(url.startsWith('https://li.quest')){count++;return Response.json({code:1005},{status:429,headers:{'retry-after':'90'}});}
    return Response.json(relay(options.body));
  });
  for(let i=0;i<2;i++)assert.equal((await lookupBridge(input,opts)).provider,'Relay');
  assert.equal(count,1);
});
test('distinguishes no quote from stale quotes, mismatched contracts and transient errors',async()=>{
  const unavailable=async url=>url.startsWith('https://li.quest')?Response.json({code:1002},{status:404}):
    Response.json({errorCode:'NO_QUOTES'},{status:400});
  assert.equal((await lookupBridge(input,fixture(unavailable))).status,'unavailable');
  for(const mode of ['stale','mismatch','timeout']){
    const result=await lookupBridge(input,fixture(async url=>{
      if(!url.startsWith('https://li.quest'))return unavailable(url);
      if(mode==='timeout')return Response.json({code:1002,errors:{failed:[{subpaths:{'1':[{code:'TOOL_TIMEOUT'}]}}]}},{status:404});
      const j=lifi(url);if(mode==='mismatch')j.action.toToken.address=NATIVE;
      return Response.json(j,{headers:{age:mode==='stale'?'90':'0'}});
    }));
    assert.equal(result.status,'unknown',mode);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {quoteImpact,quotedPool} from '../lib/quote-impact.mjs';
import {getQuote} from '../lib/market.mjs';
import {CHAINS,DIAMOND} from '../lib/assets.js';

const chain=8453, now=Date.now(), stable=CHAINS[chain].usdc;
const token='0x'+'2'.repeat(40), pool='0x'+'3'.repeat(40), wallet='0x'+'4'.repeat(40);
const market={chain,kind:'DEX',pool,token,decimals:6,bid:100,ask:100,time:now};
const quote={fromChain:chain,toChain:chain,fromToken:stable,toToken:token,inputUnits:'1000000000',
  minimum:'9900000',pool:null,fromDecimals:6,toDecimals:6,at:now};
test('worst execution vs marginal spot applies the adverse cap to exact buy and sell amounts',()=>{
  const req={market,side:'buy',inputUnits:quote.inputUnits,quote,now};
  assert.equal(quoteImpact(req),null); // 1000 / 9.9 = 101.0101, outside 1%.
  const pass=quoteImpact({...req,quote:{...quote,minimum:'9910000'}});
  assert.ok(pass.impactPct>0.9&&pass.impactPct<1);
  assert.equal(pass.poolMatched,false);
  const sell={...quote,fromToken:token,toToken:stable,inputUnits:'10000000',minimum:'990000000',pool};
  assert.equal(quoteImpact({...req,inputUnits:sell.inputUnits,quote:sell,side:'sell'}).poolMatched,true);
  assert.equal(quoteImpact({...req,quote:{...quote,minimum:'20000000'},market:{...market,time:now-45001}}),null);
  assert.equal(quoteImpact({...req,quote:{...quote,minimum:'20000000',at:now-45001}}),null);
  assert.equal(quoteImpact({...req,quote:{...quote,minimum:'20000000',fromToken:token}}),null);
  assert.equal(quoteImpact({...req,quote:{...quote,minimum:'20000000',pool:token}}),null);
  assert.equal(quoteImpact({...req,quote:{...quote,minimum:'20000000',inputUnits:'1'}}),null);
  assert.equal(quoteImpact({...req,quote:{...quote,minimum:'20000000',fromDecimals:18}}),null);
  // Never use a size-adjusted ask as the independent spot when the caller has captured it.
  assert.equal(quoteImpact({...req,market:{...market,ask:150,spotAsk:100}}),null);
});

function entered() {
  const fromToken={chainId:chain,address:stable,decimals:6},toToken={chainId:chain,address:token,decimals:6};
  const action={fromChainId:chain,toChainId:chain,fromToken,toToken,fromAddress:wallet,toAddress:wallet,fromAmount:quote.inputUnits};
  const hop={pool,fromToken,toToken,fromAmount:action.fromAmount,toAmount:'10000000',path:0};
  return {action,estimate:{toAmountMin:'9970000',gasCosts:[{amountUSD:'0.02'}],executionDuration:1,approvalAddress:DIAMOND},
    transactionRequest:{to:DIAMOND,data:'0x1234',chainId:chain,value:'0x0'}, includedSteps:[{type:'swap',action,estimate:{toAmount:hop.toAmount,hops:[hop]}}]};
}
test('only a full-size single-hop documented pool is associated with the quote',()=>{
  const good=entered(), swap=good.includedSteps[0], hop=swap.estimate.hops[0];
  assert.equal(quotedPool(good),pool);
  assert.equal(quotedPool({...good,includedSteps:[]}),null);
  assert.equal(quotedPool({...good,includedSteps:[swap,swap]}),null);
  swap.estimate.hops=[hop,hop]; assert.equal(quotedPool(good),null);
  swap.estimate.hops=[{...hop,fromAmount:'1'}]; assert.equal(quotedPool(good),null);
  swap.estimate.hops=[{...hop,fromToken:{...hop.fromToken,chainId:1}}]; assert.equal(quotedPool(good),null);
  swap.estimate.hops=[{...hop,pool:undefined}]; assert.equal(quotedPool(good),null);
});
test('getQuote propagates validated identity and rejects stale HTTP quote timestamps',async()=>{
  const original=globalThis.fetch;
  try{
    globalThis.fetch=async()=>Response.json(entered());
    const q=await getQuote(chain,chain,stable,token,quote.inputUnits,wallet);
    assert.equal(q.pool,pool);
    assert.equal(q.fromToken,stable);
    assert.equal(q.inputUnits,quote.inputUnits);
    globalThis.fetch=async()=>Response.json(entered(),{headers:{age:'60'}});
    await assert.rejects(getQuote(chain,chain,stable,token,quote.inputUnits,wallet));
  }finally{globalThis.fetch=original}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {CHAINS,DIAMOND,NATIVE} from '../lib/assets.js';
const address='0x0000000000000000000000000000000000000001';
async function runScenario(opts={},floor=5){
  const market=await import('../lib/market.mjs?case='+crypto.randomUUID());
  const actual=globalThis.fetch;
  globalThis.fetch=async path=>{
    const url=new URL(path),q=url.searchParams,ku=url.hostname.includes('kucoin');
    const response=data=>Response.json(data,{headers:{date:new Date().toUTCString()}});
    const cex=data=>response({code:ku?'200000':'00000',data});
    if(url.pathname.includes('orderbook')){
      const price=ku?130:100;
      return cex({time:Date.now(),ts:Date.now()-(opts.stale?60000:0),asks:[[price+1,100]],bids:[[price,100]]});
    }
    if(url.pathname.includes('currencies'))return cex({chains:[{chainId:'base',contractAddress:'',isWithdrawEnabled:true,isDepositEnabled:!opts.closed,withdrawMinFee:'0.001',withdrawFeeRate:'0',withdrawMinSize:0.001,depositMinSize:0.001,withdrawPrecision:8}]});
    if(url.pathname.includes('coins'))return cex([{chains:[{chain:opts.cross?'ArbitrumOne':'BASE',withdrawable:'true',rechargeable:'true',withdrawFee:opts.fee||0.001,extraWithdrawFee:0,minDepositAmount:0.001,minWithdrawAmount:0.001,withdrawMinScale:8}]}]);
    if(url.pathname.includes('symbols'))return cex(ku?{enableTrading:true,baseIncrement:0.000001,minFunds:1,takerFeeCoefficient:1}:[{status:'online',takerFeeRate:0.001,minTradeUSDT:1,quantityPrecision:6}]);
    const from=Number(q.get('fromChain')),to=Number(q.get('toChain')),src=q.get('fromToken'),dst=q.get('toToken'),amount=q.get('fromAmount');
    if(from!==to&&opts.noBridge)return new Response('',{status:404});
    const buy=src!==NATIVE;
    const min=from!==to?BigInt(amount)*999n/1000n:buy?BigInt(amount)*10n**12n/BigInt(from===8453?105:125):BigInt(amount)*BigInt(from===8453?104:124)/10n**12n;
    return response({tool:'fixture',action:{fromChainId:from,toChainId:to,fromToken:{address:src},toToken:{address:dst},fromAddress:address,toAddress:address,fromAmount:amount},
     estimate:{toAmountMin:String(min),gasCosts:[{amountUSD:'.02'}],feeCosts:[],executionDuration:10,approvalAddress:DIAMOND},
     transactionRequest:{to:DIAMOND,data:'0x1234',chainId:from,value:buy?'0x0':'0x'+BigInt(amount).toString(16)}});
  };
  try{return (await market.scan(1000,floor)).rows}finally{globalThis.fetch=actual}
}
test('verified positive routes cover every requested venue pairing',async()=>{const rows=await runScenario();assert.deepEqual(new Set(rows.map(r=>r.kind)),new Set(['DEX–DEX','CEX–CEX','CEX–DEX']));assert.ok(rows.every(r=>r.profit>=5));});
test('disabled deposits exclude the receiving venue',async()=>{const rows=await runScenario({closed:true});assert.ok(rows.every(r=>r.dest!=='kucoin'));});
test('no cross-chain quote excludes disjoint networks despite price spread',async()=>{const rows=await runScenario({cross:true,noBridge:true});assert.ok(!rows.some(r=>r.id==='bitget-kucoin'));assert.ok(!rows.some(r=>r.from!==r.to));});
test('stale books, excessive withdrawal fees and profit floor exclude rows',async()=>{assert.ok(!(await runScenario({stale:true})).some(r=>r.source==='bitget'));assert.ok(!(await runScenario({fee:50})).some(r=>r.source==='bitget'));assert.equal((await runScenario({},999)).length,0)});

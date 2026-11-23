import test from 'node:test';
import assert from 'node:assert/strict';
import {loadGateSpot} from '../lib/gate-spot.mjs';
import {discover} from '../lib/universe.mjs';
import {createSpikeTracker} from '../lib/venue-spikes.mjs';
import {quoteImpact,quotedPool} from '../lib/quote-impact.mjs';

const token='0xc27a719105a987b4c34116223cae8bd8f4b5def4',pool='0x'+'a'.repeat(64);
test('Gate joins chain CA, preserves unknown transfer terms and suppresses suspended BBO',async t=>{
 const pair=base=>({base,quote:'USDT',id:base+'_USDT',trade_status:'tradable'});
 const ticker=p=>({currency_pair:p.id,lowest_ask:'1.001',highest_bid:'1'});
 let closed=false;
 t.mock.method(globalThis,'fetch',async url=>{
   const pairs=['USDC','ACE'].map(pair);
   const row={currency:'ACE',delisted:false,trade_disabled:closed,deposit_disabled:closed,withdraw_disabled:false,
     chains:[{name:'BSC',addr:token,deposit_disabled:closed,withdraw_disabled:false}]};
   const data=url.endsWith('/currencies')?[row]:url.endsWith('/currency_pairs')?pairs:pairs.map(ticker);
   return Response.json(data,{headers:{date:new Date().toUTCString()}});
 });
 let ace=(await loadGateSpot()).find(m=>m.symbol==='ACE');
 assert.ok(ace.quoteReady&&ace.observationOnly);
 assert.deepEqual(ace.networks[0],{chain:56,token,depositOpen:true,withdrawOpen:true,deposit:false,withdraw:false});
 closed=true;ace=(await loadGateSpot()).find(m=>m.symbol==='ACE');
 assert.equal(ace.ask,null);assert.equal(ace.networks[0].depositOpen,false);
});

test('ACE V4 observation enters raw gate gaps and per-pool spike history without passing qualification',async()=>{
 const start=Math.floor(Date.now()/30000)*30000;
 const tracker=await createSpikeTracker();
 for(const [n,price] of [0.020793,0.020793,0.006186].entries()){
   // Use a fresh wall clock for discovery and replay the observed samples on the historical slot grid.
   const time=Date.now(),dex={kind:'DEX',chain:56,token,pool,dexId:'uniswap',id:'dex:56:'+token+':'+pool,
     name:'Uniswap V4 · BNB Chain',symbol:'ACE',ask:price,bid:price,time,decimals:18};
   const gate={kind:'CEX',venue:'gate',name:'Gate.io',id:'gate:ACE_USDT',symbol:'ACE',networks:[{chain:56,token,depositOpen:true}],
     ask:.067,bid:.066466,time,networkTime:time,observationOnly:true,tradeEnabled:true};
   const result=discover([dex,gate],1000,5,1,true);
   assert.equal(result.candidates.length,0);
   assert.ok(result.signalData.gaps.some(g=>g.buy===dex.name&&g.sell==='Gate.io'&&g.match.token===token));
   const at=start+n*30000;
   const events=await tracker.observe(result.signalData.samples.map(s=>({...s,time:at})),{at});
   if(n===2)assert.ok(events.some(e=>e.marketId===dex.id&&e.windowSec===60&&Math.abs(e.changePct+70.25)<.01));
 }
});

test('a bytes32 V4 quote identifies the exact pool and amount',()=>{
 const stable={address:'0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',chainId:56},asset={address:token,chainId:56};
 const action={fromChainId:56,toChainId:56,fromToken:stable,toToken:asset,fromAmount:'100'};
 const hop={...action,pool,toAmount:'200'};
 assert.equal(quotedPool({action,includedSteps:[{type:'swap',estimate:{hops:[hop],toAmount:'200'}}]}),pool);
 const time=Date.now(),market={kind:'DEX',chain:56,token,pool,decimals:18,time,ask:.5};
 const quote={pool,fromChain:56,toChain:56,fromToken:stable.address,toToken:token,inputUnits:'100',minimum:'200',fromDecimals:18,toDecimals:18,at:time};
 assert.equal(quoteImpact({market,side:'buy',inputUnits:'100',quote}).poolMatched,true);
 assert.equal(quoteImpact({market,side:'buy',inputUnits:'100',quote:{...quote,pool:'0x'+'b'.repeat(64)}}),null);
});

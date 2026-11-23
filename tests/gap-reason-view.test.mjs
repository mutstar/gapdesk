import test from 'node:test';
import assert from 'node:assert/strict';
import {gapReasonView,spotReasonGroups,walletGapReason} from '../lib/gap-reason-view.mjs';

const now=2_000_000,cfg={budget:1000,floor:5,maxImpact:1},ca={chain:1,token:'0x'+'1'.repeat(40)};
const row=(id,kind='CEX')=>({id,symbol:id,kind:'spot_spot',match:ca,time:now-1000,gap:4,
  buy:{name:'Buy',kind},sell:{name:'Sell',kind:'CEX'},diagnosis:{code:'pending',detail:'대기'}});
const frame=(data={})=>({...cfg,at:now-10,startedAt:now-1000,spotGaps:[],diagnosticGaps:[],complete:true,...data});
const check=(r,cycle,diag={code:'fees',detail:'비용 차감 후 2 USDC'})=>({...r,cycle,checkedAt:now-100,diagnosis:diag,status:'below_floor'});
const view=(f,opts={})=>gapReasonView({observations:{frame:f},now,budget:1000,verified:[],...opts});

test('counts one reason per exact observed or precisely checked spot route within the selected venue family',()=>{
 const a=row('a'),b={...row('b','DEX'),diagnosis:{code:'deposit_closed',detail:'입금 중단'}},c=row('c'),perp={...row('p'),kind:'perp_spot'};
 const f=frame({spotGaps:[a],diagnosticGaps:[a,b],futures:{rows:[perp]}});
 f.routeChecks=[check(a,f.startedAt),check(a,f.startedAt),check(c,f.startedAt)];
 const v=view(f);
 assert.deepEqual(v.blocked.map(r=>r.id),['b']);
 assert.equal(v.live.find(r=>r.id==='a').diagnosis.code,'fees');
 assert.equal(v.live.find(r=>r.id==='p').diagnosis.code,'perp');
 assert.deepEqual(spotReasonGroups(v,'전체').map(g=>[g.code,g.count]),[['fees',2],['deposit_closed',1]]);
 assert.deepEqual(spotReasonGroups(v,'DEX–CEX').map(g=>g.code),['deposit_closed']);
});
test('does not attach an old precision result to a current scan, other settings, or lookalike CA',()=>{
 const a=row('x'),f=frame({spotGaps:[a]}),past=frame({startedAt:now-31000});
 past.routeChecks=[check(a,past.startedAt)];
 const pending=view(f,{snapshot:past}).live[0];
 assert.equal(pending.diagnosis.code,'pending');
 assert.equal(pending.lastCheck.diagnosis.code,'fees');
 assert.equal(view(f,{snapshot:{...past,floor:99}}).live[0].lastCheck,null);
 const other={...a,match:{...ca,chain:56}};
 f.routeChecks=[check(other,f.startedAt)];
 assert.equal(view(f).live[0].diagnosis.code,'pending');
});
test('fresh/old partial rows and known buy/sell quote or network expiry have distinct causes',()=>{
 const a=row('x'),f=frame({spotGaps:[a]});
 assert.equal(view(f,{waiting:true}).live[0].diagnosis.code,'refresh');
 const age=now-46000;
 for(const [fields,code] of [[{buyQuoteAt:age},'stale_quote'],[{sellQuoteAt:age},'stale_quote'],[{networkAt:age},'stale_network'],[{},'expired']]){
   const v=view(frame({spotGaps:[{...a,...fields,time:age}]}));
   assert.equal(v.live[0].diagnosis.code,code);
 }
 const expired={...a,budget:1000,buyQuoteAt:age,sellQuoteAt:now,expires:now+999};
 f.routeChecks=[{...check(a,f.startedAt),status:'passed',diagnosis:{code:'passed',detail:'통과'}}];
 assert.equal(view(f,{verified:[expired]}).live[0].exact,null);
 const valid={...expired,buyQuoteAt:now-100};
 assert.equal(view(f,{verified:[valid]}).live[0].diagnosis.code,'passed');
 assert.equal(view(frame({diagnosticGaps:[a]}),{verified:[valid]}).blocked[0].exact,null);
});
test('a new blocked route replaces its own earlier observed route; no route is duplicated',()=>{
 const a=row('x'),prior=frame({startedAt:now-31000,spotGaps:[a]});
 const f=frame({complete:false,diagnosticGaps:[{...a,diagnosis:{code:'slippage',detail:'3% > 1%'}}]});
 const v=view(f,{observations:{frame:f,previous:prior}});
 assert.equal(v.live.length,0);
 assert.equal(v.blocked.length,1);
 assert.equal(spotReasonGroups(v,'전체')[0].count,1);
});
test('wallet filter distinguishes missing read, low USDC, low gas, and manual CEX leg',()=>{
 const a={budget:1000,buyKind:'DEX',sellKind:'DEX',from:1,to:8453,buyGas:.02,bridgeGas:.02,sellGas:.02,gasPriceFrom:1000,gasPriceTo:1000};
 assert.equal(walletGapReason(a,'',{}).code,'wallet_missing');
 assert.equal(walletGapReason({...a,sellKind:'CEX'},'addr',{}).code,'wallet_cex');
 assert.equal(walletGapReason(a,'addr',{}).code,'wallet_unknown');
 assert.equal(walletGapReason(a,'addr',{1:{usdc:20}}).code,'wallet_usdc');
 assert.equal(walletGapReason(a,'addr',{1:{usdc:1000,eth:9},8453:{eth:0}}).code,'wallet_gas');
 assert.equal(walletGapReason(a,'addr',{1:{usdc:1000,eth:9},8453:{eth:1}}),null);
});

test('timed-out precision and a later failed check never display an executable reason',()=>{
 const r=row('x'),f=frame({spotGaps:[r]});
 const quote={...r,budget:1000,buyQuoteAt:now-49000,sellQuoteAt:now,expires:now-4000};
 const old=view(f,{snapshot:{...f,rows:[quote]}});
 assert.equal(old.live[0].diagnosis.code,'stale_quote');
 const valid={...quote,buyQuoteAt:now-500,sellQuoteAt:now-500,verifiedAt:now-200,expires:now+10000};
 f.routeChecks=[check(r,f.startedAt)];
 assert.equal(view(f,{verified:[valid]}).live[0].diagnosis.code,'fees');
});
test('aged indicative evidence can show the latest precise result, without counting carry-forward as current',()=>{
 const late={...row('x'),time:now-50000,buyQuoteAt:now-50000},f=frame({spotGaps:[late]});
 f.routeChecks=[check(late,f.startedAt)];
 const v=view(f);
 assert.equal(v.live[0].diagnosis.code,'stale_quote');
 assert.equal(v.live[0].lastCheck.diagnosis.code,'fees');
 const next=frame({startedAt:now-100,complete:false});
 const carried=view(next,{observations:{frame:next,previous:f}});
 assert.equal(carried.live[0].previous,true);
 assert.deepEqual(spotReasonGroups(carried,'전체'),[]);
});

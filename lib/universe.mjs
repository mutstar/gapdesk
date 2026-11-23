import {venueFamily} from './venue-family.mjs';
import {strictContractKey,marketContracts,spotRouteId,transferStatus} from './contract-identity.mjs';
import {loadBitgetPerps} from './bitget-perps.mjs';
import {loadKucoinPerps} from './kucoin-perps.mjs';
import {loadBinancePerps,enrichBinanceInterest} from './binance-perps.mjs';
import {perpBasis} from './perp-basis.mjs';
import {signalInputs} from './signal-inputs.mjs';
import {poolFill} from './pool-depth.mjs';
import {loadCex} from './cex-catalog.mjs';
import {loadDex} from './dex-catalog.mjs';
import {createObservationProgress} from './live-observations.mjs';
import {isFreshQualified} from './quote-freshness.mjs';
import {dexDiagnosis,filledSpreadDiagnosis,observedDiagnosis,priceGap,quoteDiagnosis,transferDiagnosis} from './discovery-diagnosis.mjs';
import {qualify,probe} from './qualification.mjs';
import {CHAINS,NATIVE} from './assets.js';

const key=m=>m.chain+':'+m.token;
const current=m=>m.ask>0&&m.bid>0&&m.quoteReady!==false&&m.time>0&&Date.now()-m.time>=-5000&&Date.now()-m.time<45000;
function compatibleMarkets(a,b){
 if(a.id===b.id||a.kind==='CEX'&&b.kind==='CEX'&&a.venue===b.venue)return false;
 if(a.kind==='DEX'&&b.kind==='DEX'&&a.chain===b.chain&&(!a.pool||!b.pool||a.pool===b.pool))return false;
 return true;
}
function assetGroups(markets){
 const parent=new Map();
 function root(k){
   if(!parent.has(k))parent.set(k,k);
   let top=k;while(parent.get(top)!==top)top=parent.get(top);
   while(k!==top){const next=parent.get(k);parent.set(k,top);k=next}return top;
 }
 const labels=new Map();
 for(const m of markets){
   const keys=m.kind==='DEX'?[key(m)]:m.networks.map(key);
   if(m.kind==='DEX'&&CHAINS[m.chain]?.usdc===m.token)keys.push('gapdesk-usdc-settlement');
   if(m.kind==='DEX'&&m.identity)keys.push('issuer:'+m.identity);
   if(m.kind==='DEX'&&m.token===NATIVE&&CHAINS[m.chain]?.gas==='ETH')keys.push('native-eth');
   if(keys.length){const base=root(keys[0]);for(const k of keys.slice(1)){const other=root(k);if(other!==base)parent.set(other,base)}labels.set(m.id,keys[0]);}
 }
 const groups=new Map();
 for(const m of markets){const k=labels.get(m.id);if(!k)continue;const id=root(k);if(!groups.has(id))groups.set(id,[]);groups.get(id).push(m)}
 return groups;
}
function unavailableStatus(group,marks,asset,entry){
 let low=null,high=null;
 for(const m of group){
   const q=marks.get(m.id);if(!q)continue;
   if(q.buy>0&&(!low||q.buy<low.price))low={m,price:q.buy};
   if(q.sell>0&&(!high||q.sell>high.price))high={m,price:q.sell};
 }
 if(!low||!high)return entry.filtered?'DEX 깊이·가격 한도 미충족':'비교 시세 대기';
 if(low.m===high.m)return entry.contracts.length>1?'같은 CA의 비교 마켓 없음 · 다른 컨트랙트 불일치':'같은 CA의 비교 시세 대기';
 if(high.price<=low.price)return '양의 가격 차이 없음';
 const sides=[[high.m,'depositOpen','입금'],[low.m,'withdrawOpen','출금']];
 for(const [m,flag,label] of sides){
   if(m.kind!=='CEX')continue;
   const nets=m.networks.filter(n=>strictContractKey(n)===asset);
   if(nets.length&&nets.every(n=>n[flag]===false))return m.name+' · 공통 네트워크 '+label+' 중단';
 }
 return '금액별 입출금 또는 이동 경로 미확인';
}
export function discover(markets,budget,floor,maxImpact=1,signals=false,observationsOnly=false){
 const marks=new Map(), counts=new Map(), buyExcess=new Map();
 const now=Date.now();
 const depthCoverage={observed:0,passed:0,excluded:0,noDepth:0,noFill:0,buyPassed:0,sellPassed:0};
 const tickers=new Map(),marketById=new Map(markets.map(m=>[m.id,m])),gas={};
 for(const m of markets){
   const symbol=String(m.symbol||'').trim().toUpperCase();if(!symbol)continue;
   if(!tickers.has(symbol))tickers.set(symbol,{symbol,contracts:new Map(),count:0,venues:new Set(),priced:0,openIn:false,openOut:false,cex:false,halt:false,observed:0});
   const a=tickers.get(symbol);a.count++;a.venues.add(m.kind==='DEX'?(CHAINS[m.chain]?.name||String(m.chain)) :m.name);
   if(m.kind==='CEX'){a.cex=true;a.openIn ||=m.networks.some(n=>n.deposit);a.openOut ||=m.networks.some(n=>n.withdraw);
    if(m.venue==='bithumb'&&m.depositOpen===false&&m.withdrawOpen===false)a.halt=true;}
   let buy=null,sell=null,buyImpact=null,sellImpact=null;
   if(current(m)){
     if(m.kind==='CEX'){buy=m.ask;sell=m.bid}
     else {
       if(m.token===NATIVE)gas[m.chain]=m.bid;
       if(m.pool&&!m.referenceOnly){
         const purchase=poolFill(m,'buy',budget,maxImpact,pct=>buyExcess.set(m.id,pct)),sale=poolFill(m,'sell',budget/m.bid,maxImpact);
         buy=purchase?.effectivePrice??null;sell=sale?.effectivePrice??null;
         buyImpact=purchase?.impactPct??null;sellImpact=sale?.impactPct??null;
       }
     }
   }
   if(m.kind==='DEX'&&m.pool){
     const id=m.chain+':'+m.pool,r=counts.get(id)||{buy:false,sell:false};
     r.modeled ||= current(m)&&!!m.depth;
     r.buy ||= buy!==null;r.sell ||= sell!==null;counts.set(id,r);
     if(!buy&&!sell)a.filtered=true;
   }
   if(buy===null&&sell===null)continue;
   marks.set(m.id,{buy,sell,buyImpact,sellImpact});
   a.priced++;a.observed=Math.max(a.observed,m.time);

 }
 const candidates=[],identityOf=new Map(),exact=new Map();let checked=0;
 for(const m of markets){
   const contracts=marketContracts(m);
   if(contracts.length===1)identityOf.set(m.id,strictContractKey(contracts[0]));
   for(const match of contracts){
     const id=strictContractKey(match);
     if(!exact.has(id))exact.set(id,{match,markets:[],best:null});
     exact.get(id).markets.push(m);
   }
 }
 // Catalog relationships are only used for manual bridge lookup. Every gap below
 // is constructed in a single exact (chain, CA) bucket.

 for(const [chain,info] of Object.entries(CHAINS)){
   const mark=markets.find(m=>m.kind==='CEX'&&m.symbol===info.gas&&current(m)&&m.networks.some(n=>String(n.chain)===chain&&n.token===NATIVE));
   if(mark)gas[chain]=mark.ask;
 }
 for(const [asset,group] of observationsOnly?[]:assetGroups(markets)){
   for(const m of group){

     const entry=tickers.get(String(m.symbol||'').trim().toUpperCase());
     if(!entry)continue;
     for(const n of m.kind==='DEX'?[m]:m.networks){
       if(!n.chain||!n.token)continue;
       const id=key(n);
       if(!entry.contracts.has(id))entry.contracts.set(id,{chain:n.chain,token:n.token,identity:asset,venues:new Set()});
       if(m.kind==='CEX')entry.contracts.get(id).venues.add(m.name);
     }
   }
 }
 const spotGaps=[], diagnosticGaps=[];
 for(const [asset,bucket] of exact){
   const {markets:group,match}=bucket;
   const bestByPair=new Map(),rejected=new Map();
   // Catalogue prices are not exchange quotes. Both diagnostic legs must have
   // an identified venue or pool, a contract and a recent source timestamp.
   const quoted=group.filter(m=>Number.isFinite(m.time)&&m.time>0&&m.time<=now+5000&&now-m.time<120000&&
     (m.kind==='CEX'||m.pool&&!m.referenceOnly));
   for(const b of quoted){
     const buyMark=marks.get(b.id),ask=buyMark?.buy;
     const buyAllowed=ask&&!b.observationOnly&&b.tradeEnabled!==false;
     for(const s of quoted){
       if(!compatibleMarkets(b,s))continue;
       const family=venueFamily(b.kind,s.kind);
       const raw=Number.isFinite(b.ask)&&b.ask>0&&Number.isFinite(s.bid)?s.bid/b.ask-1:0;
       const inspect=raw>0 && raw>(rejected.get(family)?.spread??0);
       const allowed=buyAllowed&&current(s)&&!s.observationOnly&&s.tradeEnabled!==false;
       if(!allowed&&!inspect)continue;
       if(allowed)checked++;
       let excess=null, sale=null, bid=null;
       if(ask && (allowed||inspect&&s.kind==='DEX'&&current(s))){
         sale=s.kind==='DEX'?poolFill(s,'sell',budget/ask,maxImpact,pct=>{excess=pct}):null;
         bid=s.kind==='DEX'?sale?.effectivePrice:marks.get(s.id)?.sell;
       }
       const spread=ask&&bid?bid/ask-1:0;
       const observed=Math.min(b.time,s.time,b.networkTime??b.time,s.networkTime??s.time);
       let transfer;
       if(allowed&&spread>0&&now-observed<45000){
         transfer=transferDiagnosis(b,s,asset,budget/ask);
         if(!transfer){
           if(!bucket.best||spread>bucket.best.spread)bucket.best={b,s,ask,bid,spread,observed,
             buyImpact:buyMark.buyImpact,sellImpact:sale?.impactPct??null};
           if(!bestByPair.has(family)||spread>bestByPair.get(family).spread)
             bestByPair.set(family,{b,s,ask,bid,spread,observed});
           if(!observationsOnly&&spread*budget>=floor){
             candidates.push({buy:b,sell:s,id:spotRouteId(b.id,s.id,match),spread,signalAsk:ask,signalBid:bid,direct:true,match});
           }
           continue;
         }
       }
       if(!inspect)continue;
       const issue=quoteDiagnosis(b,s,now) || transfer || transferDiagnosis(b,s,asset,ask?budget/ask:null) ||
         (b.kind==='DEX'&&!ask?dexDiagnosis(b,true,buyExcess.get(b.id),maxImpact,budget):null) ||
         (s.kind==='DEX'&&!bid?dexDiagnosis(s,false,excess,maxImpact,budget):null) ||
         (ask&&bid&&spread<=0?filledSpreadDiagnosis(b,s,ask,bid,budget):null) ||
         {code:'unverified',detail:'주문 규칙 또는 금액별 실행 견적 미확인'};
       rejected.set(family,{b,s,spread:raw,issue});
     }
   }
   for(const {b,s,ask,bid,observed} of bestByPair.values())
     spotGaps.push(priceGap(b,s,match,ask,bid,observed,observedDiagnosis(b,s,match,budget,floor,ask,bid)));
   for(const {b,s,issue} of rejected.values())
     diagnosticGaps.push(priceGap(b,s,match,b.ask,s.bid,Math.min(b.time,s.time),issue));
 }
 const byGap=(a,b)=>b.gap-a.gap||a.id.localeCompare(b.id);
 spotGaps.sort(byGap);
 diagnosticGaps.sort(byGap);
 if(observationsOnly)return {spotGaps,diagnosticGaps,marks};
 const catalog=[...tickers.values()].map(a=>{
    const groups=new Map();
    const contracts=[...a.contracts.values()].sort((l,r)=>String(l.chain).localeCompare(String(r.chain),'en',{numeric:true})||l.token.localeCompare(r.token)).map(n=>{
      if(!groups.has(n.identity))groups.set(n.identity,groups.size);
      return {chain:n.chain,token:n.token,group:groups.get(n.identity),...(n.venues.size?{venues:[...n.venues].sort()}:{})};
    });
    return {symbol:a.symbol,contracts,markets:a.count,priced:a.priced,venues:[...a.venues],ask:null,bid:null,buy:'',sell:'',gap:null,time:a.observed,
     halt:a.halt,cex:a.cex,openIn:a.openIn,openOut:a.openOut,filtered:!!a.filtered};
 });
 const bySymbol=new Map(catalog.map(a=>[a.symbol,a]));
 const summaries=[];
 for(const [asset,bucket] of exact){
   const {best,match}=bucket;
   const representative=best?.b||bucket.markets.find(m=>m.kind==='CEX')||bucket.markets[0];
   const entry=bySymbol.get(String(representative.symbol).trim().toUpperCase());
   if(!entry)continue;
   const aliases=[...new Set(bucket.markets.map(m=>String(m.symbol).trim().toUpperCase()))].sort();
   const reference=entry.contracts.find(n=>strictContractKey(n)===asset);
   const contracts=reference?entry.contracts.filter(n=>n.group===reference.group):[match];
   summaries.push({...entry,asset,match,aliases,contracts,markets:bucket.markets.length,
     priced:bucket.markets.filter(m=>marks.has(m.id)).length,
     venues:[...new Set(bucket.markets.map(m=>m.name).filter(Boolean))],
     buyKind:best?.b.kind,sellKind:best?.s.kind,buyTransfer:transferStatus(best?.b,match),sellTransfer:transferStatus(best?.s,match),
     buy:best?.b.name||'',sell:best?.s.name||'',ask:best?.ask??null,bid:best?.bid??null,
     buyImpact:best?.buyImpact??null,sellImpact:best?.sellImpact??null,
     gap:best?best.spread*100:null,time:best?.observed??entry.time,
     status:best?'체인·CA 일치 · 입출금 경로 확인':unavailableStatus(bucket.markets,marks,asset,entry)});
 }
 for(const entry of catalog){
   if(!entry.contracts.some(c=>strictContractKey(c)))summaries.push({...entry,asset:'unmatched:'+entry.symbol,match:null,
     status:'CA 미확인 · 갭 제외'});
 }
 summaries.sort((a,b)=>(b.gap??-1)-(a.gap??-1)||a.symbol.localeCompare(b.symbol));
 candidates.sort((a,b)=>b.spread-a.spread||a.id.localeCompare(b.id));
 for(const r of counts.values()){
   depthCoverage.observed++;
   if(r.buy||r.sell)depthCoverage.passed++;else {depthCoverage.excluded++;if(r.modeled)depthCoverage.noFill++;else depthCoverage.noDepth++;}
   if(r.buy)depthCoverage.buyPassed++;if(r.sell)depthCoverage.sellPassed++;
 }
 return {summaries,spotGaps,diagnosticGaps,candidates,marketById,marks,identityOf,checked,gas,depthCoverage,signalData:signals?signalInputs(markets,marks,identityOf,candidates,budget,floor):null};
}
// Stable lexical rotation visits the tail even when a very large indicative gap persists.
export function queueSlice(items,cursor,limit=4){
 if(items.length<=limit)return {batch:items,next:cursor};
 const ranked=items.slice(0,1),sorted=items.filter(x=>x!==ranked[0]).sort((a,b)=>a.id.localeCompare(b.id));
 let i=cursor?sorted.findIndex(x=>x.id.localeCompare(cursor)>0):0;if(i<0)i=0;
 const rotating=Array.from({length:limit-1},(_,j)=>sorted[(i+j)%sorted.length]);
 return {batch:[...ranked,...rotating],next:rotating.at(-1).id};
}
export async function prepareScan({budget,floor,address=probe,only='',cursor='',poolCursor=0,limit=4,startedAt=Date.now(),poolPass,maxImpact=1,savedEntries=[],signals=false,previousCandidates=null,onProgress=undefined}){
 const progress=onProgress&&!only?createObservationProgress({startedAt,budget,floor,maxImpact,onProgress,
   observe(spots,feeds){
     const comparable=spots.filter(m=>m.kind==='CEX'||m.pool&&!m.referenceOnly);
     const {spotGaps,diagnosticGaps,marks}=discover(comparable,budget,floor,maxImpact,false,true);
     return {spotGaps,diagnosticGaps,futures:perpBasis({spots:comparable,marks,feeds,budget,maxImpact}).book};
   }}):null;
 const cexRequest=loadCex({onMarkets:progress?.addMarkets});
 const perpFeeds=only?[]:Promise.all([loadBitgetPerps,loadKucoinPerps,loadBinancePerps].map(async load=>{
   const feed=await load();progress?.addFeed(feed);return feed;
 }));
 const dexRequest=loadDex([],poolCursor,only?only.split('~ca=')[0].split('|'):[],{
   startedAt,poolPass,savedEntries,onMarkets:progress?.addMarkets,cexReady:cexRequest.then(c=>c.markets)
 }).catch(()=>({markets:[],sources:[{id:'dex',name:'DEX 피드',ok:false,count:0}],nextCursor:poolCursor,poolCoverage:{}}));
 let cex,dex,feeds;
 try{[cex,dex,feeds]=await Promise.all([cexRequest,dexRequest,perpFeeds])}
 finally{progress?.close()}
 const spots=[...cex.markets,...dex.markets];
 const {summaries,spotGaps,diagnosticGaps,candidates,marks,identityOf,checked,gas,depthCoverage,signalData}=discover(spots,budget,floor,maxImpact,signals);
 const futures=perpBasis({spots,marks,identityOf,feeds,budget,maxImpact});
 await enrichBinanceInterest(futures.book.rows);
 if(signalData){
   signalData.samples.push(...futures.samples);
   signalData.marketIds.push(...futures.marketIds);
   for(const row of futures.book.rows){
     if(row.gap<1)break;
     signalData.gaps.push({id:row.id,symbol:row.symbol,buy:row.buy.name,sell:row.sell.name,ask:row.ask,bid:row.bid,
       gap:row.gap,match:row.match,basis:row.kind,blocked:null,reason:row.sell.kind!=='PERP'?'현물 보유 또는 차입 필요':null});
   }
 }
 let {batch,next}=queueSlice(candidates,cursor,limit);
 if(previousCandidates&&limit>1&&!only){
   const newlyOpened=candidates.filter(c=>!previousCandidates.has(c.id)).slice(0,limit-1);
   const ids=new Set(newlyOpened.map(c=>c.id));
   batch=[...newlyOpened,...batch.filter(c=>!ids.has(c.id))].slice(0,limit);
 }
 if(only){const safe=candidates.find(c=>c.id===only);batch=safe?[safe]:[]}
 // Quote failures affect one candidate and never promote an indicative row.
 const verify=async(onCheck=undefined)=>(await Promise.all(batch.map(async p=>{
   let belowFloor=false,diagnosis;
   const row=await qualify(p,budget,floor,address,gas,{
     onBelowFloor:()=>{belowFloor=true},
     onDiagnosis:evidence=>{diagnosis=evidence}
   },maxImpact).catch(()=>null);
   const checkedAt=Date.now(),passed=isFreshQualified(row,checkedAt);
   if(passed)row.verifiedAt=checkedAt;
   const {buy,sell}=p;
   const networkTimes=[buy,sell].filter(m=>m.kind==='CEX'&&m.networkTime>0).map(m=>m.networkTime);
   const networkAt=networkTimes.length?Math.min(...networkTimes):null;
   onCheck?.({id:p.id,match:p.match,cycle:startedAt,checkedAt,status:passed?'passed':belowFloor?'below_floor':'unconfirmed',
     profit:passed?row.profit:null,kind:'spot_spot',symbol:buy.symbol,
     buy:{id:buy.id,kind:buy.kind,name:buy.name},sell:{id:sell.id,kind:sell.kind,name:sell.name},
     ask:p.signalAsk,bid:p.signalBid,gap:p.spread*100,time:Math.min(buy.time,sell.time,networkAt??Infinity),
     buyQuoteAt:row?.buyQuoteAt??buy.time,sellQuoteAt:row?.sellQuoteAt??sell.time,networkAt,
     diagnosis:passed?{code:'passed',detail:'양쪽 최신 호가와 금액별 순차익을 확인했어요.'}:
       diagnosis??{code:'unverified',detail:'이번 정밀 조회에서 양쪽 체결 견적을 확인하지 못했어요.'}});
   return row;
 }))).filter(r=>isFreshQualified(r,Date.now())).sort((a,b)=>b.profit-a.profit);
 const sources=[...cex.sources,...dex.sources,...feeds.map(f=>f.source)].map(s=>({...s,time:s.at||s.time||0}));
 const eth=cex.markets.find(m=>m.venue==="kucoin"&&m.symbol==="ETH"&&m.quote==="USDC"&&current(m));
 return {verify,signalData,snapshot:{contractScreened:true,transferScreened:true,futures:futures.book,at:Date.now(),startedAt,budget,floor,maxImpact,depthCoverage,checked,ethReference:eth?{ask:eth.ask,bid:eth.bid}:null,eligible:candidates.map(c=>c.id),attempted:batch.map(c=>c.id),candidateCount:candidates.length,tested:batch.length,rows:[],tokens:only?[]:(summaries??[]),spotGaps:only?[]:spotGaps,diagnosticGaps:only?[]:diagnosticGaps,routeChecks:[],recentMarkets:progress?.recent()||[],marketCount:progress?.marketCount(),
   nextCursor:next,poolCursor:dex.nextCursor??poolCursor,poolCoverage:dex.poolCoverage,sources}};
}

export async function wideScan(options){
 const {snapshot,verify}=await prepareScan(options);
 const routeChecks=[];
 const rows=await verify(check=>routeChecks.push(check));
 return {...snapshot,routeChecks,rows};
}

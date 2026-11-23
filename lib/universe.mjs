import {loadCex} from './cex-catalog.mjs';
import {loadDex} from './dex-catalog.mjs';
import {qualify,paths,probe} from './qualification.mjs';
import {CHAINS,NATIVE} from './assets.js';

const key=m=>m.chain+':'+m.token;
const fullId=(b,s)=>b.id+'|'+s.id;
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
   if(m.kind==='DEX'&&m.identity)keys.push('issuer:'+m.identity);
   if(m.kind==='DEX'&&m.token===NATIVE&&CHAINS[m.chain]?.gas==='ETH')keys.push('native-eth');
   if(keys.length){const base=root(keys[0]);for(const k of keys.slice(1)){const other=root(k);if(other!==base)parent.set(other,base)}labels.set(m.id,keys[0]);}
 }
 const groups=new Map();
 for(const m of markets){const k=labels.get(m.id);if(!k)continue;const id=root(k);if(!groups.has(id))groups.set(id,[]);groups.get(id).push(m)}
 return groups;
}
export function discover(markets,budget,floor){
 const tickers=new Map(),marketById=new Map(markets.map(m=>[m.id,m])),gas={};
 for(const m of markets){
   const symbol=String(m.symbol||'').trim().toUpperCase();if(!symbol)continue;
   if(!tickers.has(symbol))tickers.set(symbol,{symbol,count:0,venues:new Set(),priced:0,low:null,high:null,openIn:false,openOut:false,cex:false,halt:false,observed:0});
   const a=tickers.get(symbol);a.count++;a.venues.add(m.kind==='DEX'?(CHAINS[m.chain]?.name||String(m.chain)) :m.name);
   if(m.kind==='CEX'){a.cex=true;a.openIn ||=m.networks.some(n=>n.deposit);a.openOut ||=m.networks.some(n=>n.withdraw);
    if(m.venue==='bithumb'&&m.depositOpen===false&&m.withdrawOpen===false)a.halt=true;}
   const catalogReference=m.reference==='catalog'&&m.ask>0&&m.bid>0&&Date.now()-m.time<600000;
   if(!current(m)&&!catalogReference)continue;
   if(m.kind==='DEX'&&m.token===NATIVE&&m.bid>0)gas[m.chain]=m.bid;
   a.priced++;a.observed=Math.max(a.observed,m.time);
   if(!a.low||m.ask<a.low.ask)a.low=m;
   if(!a.high||m.bid>a.high.bid)a.high=m;
 }
 const candidates=[],identityOf=new Map();let checked=0;
 for(const [chain,info] of Object.entries(CHAINS)){
   const mark=markets.find(m=>m.kind==='CEX'&&m.symbol===info.gas&&current(m)&&m.networks.some(n=>String(n.chain)===chain&&n.token===NATIVE));
   if(mark)gas[chain]=mark.ask;
 }
 for(const [asset,group] of assetGroups(markets)){
   for(const m of group)identityOf.set(m.id,asset);
   for(const b of group){
     if(!current(b)||b.observationOnly||b.tradeEnabled===false)continue;
     for(const s of group){
       if(!current(s)||s.observationOnly||s.tradeEnabled===false||!compatibleMarkets(b,s))continue;
       checked++;
       const spread=s.bid/b.ask-1;
       if(!(spread>0&&spread*budget>=floor)||!paths(b,s).length)continue;
       candidates.push({buy:b,sell:s,id:fullId(b,s),spread});
     }
   }
 }
 const summaries=[...tickers.values()].map(a=>{
    const separate=a.low&&a.high&&a.low.id!==a.high.id;
    const gap=separate?Math.max(0,(a.high.bid/a.low.ask-1)*100):null;
    return {symbol:a.symbol,markets:a.count,priced:a.priced,venues:[...a.venues],ask:a.low?.ask??null,bid:a.high?.bid??null,
     buy:a.low?.name??'',sell:a.high?.name??'',gap,time:a.low&&a.high?Math.min(a.low.time,a.high.time):a.observed,halt:a.halt,cex:a.cex,openIn:a.openIn,openOut:a.openOut,status:separate&&(!current(a.low)||!current(a.high))?'기준가 시차 있음':separate&&(!identityOf.has(a.low.id)||identityOf.get(a.low.id)!==identityOf.get(a.high.id))&&!a.halt?"동일 자산 미확인":a.halt?"빗썸 입출금 중단":!separate?"비교 시세 대기":!a.low?.kind||a.low?.observationOnly||a.high?.observationOnly?"경로 미확인":"체결 미검증"};
 });
 summaries.sort((a,b)=>(b.gap??-1)-(a.gap??-1)||a.symbol.localeCompare(b.symbol));
 candidates.sort((a,b)=>b.spread-a.spread||a.id.localeCompare(b.id));
 return {summaries,candidates,marketById,checked,gas};
}
// Stable lexical rotation visits the tail even when a very large indicative gap persists.
export function queueSlice(items,cursor,limit=4){
 if(items.length<=limit)return {batch:items,next:cursor};
 const ranked=items.slice(0,1),sorted=items.filter(x=>x!==ranked[0]).sort((a,b)=>a.id.localeCompare(b.id));
 let i=cursor?sorted.findIndex(x=>x.id.localeCompare(cursor)>0):0;if(i<0)i=0;
 const rotating=Array.from({length:limit-1},(_,j)=>sorted[(i+j)%sorted.length]);
 return {batch:[...ranked,...rotating],next:rotating.at(-1).id};
}
export async function prepareScan({budget,floor,address=probe,only='',cursor='',poolCursor=0,limit=4,startedAt=Date.now(),poolPass}){
 const cex=await loadCex();
 let dex;
 try{dex=await loadDex(cex.markets,poolCursor,only?only.split('|'):[],{startedAt,poolPass})}catch{dex={markets:[],sources:[{id:'dex',name:'DEX 피드',ok:false,count:0}],nextCursor:poolCursor,poolCoverage:{}}}
 const {summaries,candidates,marketById,checked,gas}=discover([...cex.markets,...dex.markets],budget,floor);
 let {batch,next}=queueSlice(candidates,cursor,limit);
 if(only){const [left,right]=only.split('|'),b=marketById.get(left),s=marketById.get(right);
  const safe=candidates.find(c=>c.buy===b&&c.sell===s);batch=safe?[safe]:[]}
 // Quote failures affect one candidate and never promote an indicative row.
 const verify=async()=>(await Promise.all(batch.map(p=>qualify(p,budget,floor,address,gas).catch(()=>null)))).filter(Boolean)
  .filter(r=>r.expires>Date.now()).sort((a,b)=>b.profit-a.profit);
 const sources=[...cex.sources,...dex.sources].map(s=>({...s,time:s.at||s.time||0}));
 const eth=cex.markets.find(m=>m.venue==="kucoin"&&m.symbol==="ETH"&&m.quote==="USDC"&&current(m));
 return {verify,snapshot:{at:Date.now(),startedAt,budget,checked,ethReference:eth?{ask:eth.ask,bid:eth.bid}:null,eligible:candidates.map(c=>c.id),attempted:batch.map(c=>c.id),candidateCount:candidates.length,tested:batch.length,rows:[],tokens:only?[]:summaries,
   nextCursor:next,poolCursor:dex.nextCursor??poolCursor,poolCoverage:dex.poolCoverage,sources}};
}

export async function wideScan(options){
 const {snapshot,verify}=await prepareScan(options);
 return {...snapshot,rows:await verify()};
}

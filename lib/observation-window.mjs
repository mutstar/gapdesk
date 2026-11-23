import {strictContractKey} from './contract-identity.mjs';
import {isFreshQualified} from './quote-freshness.mjs';
import {venueFamily} from './venue-family.mjs';

export const OBSERVATION_LIVE_MS = 45_000;
export const OBSERVATION_HOLD_MS = 120_000;
export const DISPLAY_RETENTION_MS = 300_000;

export function sameSettings(a,b) {
  return !!a && !!b && a.budget === b.budget && a.floor === b.floor && a.maxImpact === b.maxImpact;
}

export function observationFrame(data,complete=false) {
  const {startedAt,at,budget,floor,maxImpact,spotGaps,diagnosticGaps,routeChecks,futures,sources,marketCount,recentMarkets} = data;
  return {startedAt,at,budget,floor,maxImpact,complete,spotGaps:spotGaps||[],diagnosticGaps:diagnosticGaps||[],routeChecks:routeChecks||[],futures,
    sources:sources||[],marketCount,recentMarkets:recentMarkets||[]};
}

export function frameOrder(a,b) {
  return a.startedAt-b.startedAt || Number(a.complete)-Number(b.complete) || a.at-b.at || (a.seq||0)-(b.seq||0);
}

const frameRows=frame=>[...(frame?.spotGaps||[]),...(frame?.futures?.rows||[])];
const recent=(time,now)=>Number.isFinite(time)&&time>0&&time<=now+5000&&now-time<DISPLAY_RETENTION_MS;
function collectStops(books,frames,now){
  const stops=new Map();
  function record(id,time){
    if(recent(time,now)&&time>(stops.get(id)??0))stops.set(id,time);
  }
  for(const book of books)for(const [id,time] of book?.stops||[])record(id,time);
  for(const frame of frames)for(const row of frame?.diagnosticGaps||[]){
    const ca=strictContractKey(row.match),code=row.diagnosis?.code;
    if(!ca||!row.id)continue;
    if(code==='withdraw_closed'||code==='deposit_closed')record(ca+'|'+row.id,row.networkAt);
    if(['fees','slippage','transfer_limit','depth'].includes(code))record(ca+'|'+row.id,Math.min(row.buyQuoteAt,row.sellQuoteAt));
  }
  return stops;
}
function collectFailedChecks(books,frames,now){
  const failures=new Map();
  // A completed relay frame keeps its scan timestamp as later precision checks arrive.
  const received=Date.now();
  function record(id,time){
    if(Number.isFinite(time)&&time>0&&time<=received+5000&&now-time<DISPLAY_RETENTION_MS&&time>(failures.get(id)??0))failures.set(id,time);
  }
  for(const book of books)for(const [id,time] of book?.failures||[])record(id,time);
  for(const frame of frames)for(const check of frame?.routeChecks||[]){
    const ca=strictContractKey(check.match);
    if(ca&&check.id&&check.cycle===frame.startedAt&&check.status!=='passed')record(ca+'|'+check.id,check.checkedAt);
  }
  return failures;
}
function insertRows(map,rows,now,stops,faded){
  for(const r of rows){
    const ca=strictContractKey(r?.match),family=venueFamily(r?.buy?.kind,r?.sell?.kind);
    if(!ca||!family||!r.id||!Number.isFinite(r.gap)||r.gap<=0||!recent(r.time,now))continue;
    if((stops.get(ca+'|'+r.id)??0)>=r.time)continue;
    const displayKey=ca+'|'+(r.kind==='spot_spot'?family:r.kind+'|'+r.id);
    const previous=faded||!!r.previous,old=map.get(displayKey);
    if(old&&(old.time>r.time||old.time===r.time&&(
      old.previous!==previous?!old.previous:old.id!==r.id&&old.gap>=r.gap)))continue;
    map.set(displayKey,{...r,displayKey,previous});
  }
}
export function mergeFrame(state,incoming){
  const {previous:seed,...candidate}=incoming;
  if(!sameSettings(state?.frame,candidate))state=null;
  const delayed=state&&!state.cacheOnly&&frameOrder(candidate,state.frame)<=0;
  if(delayed&&(state.frame.complete||candidate.startedAt>=state.frame.startedAt||
    state.previous&&frameOrder(candidate,state.previous)<=0))return state;
  const frame=delayed?state.frame:candidate;
  const previous=[seed,candidate,state?.cacheOnly?null:state?.frame,state?.previous]
    .filter(f=>sameSettings(f,frame)&&f.startedAt<frame.startedAt).sort((a,b)=>frameOrder(b,a))[0]||null;
  const stops=collectStops([state],[previous,frame],frame.at);
  const rows=new Map();
  insertRows(rows,state?.displayRows||[],frame.at,stops,true);
  if(previous)insertRows(rows,frameRows(previous),frame.at,stops,true);
  insertRows(rows,frameRows(frame),frame.at,stops,false);
  const displayRows=[...rows.values()];
  if(frame.complete||!state)displayRows.sort((a,b)=>b.gap-a.gap);
  return {frame,previous:frame.complete?null:previous,displayRows,stops,
    failures:collectFailedChecks([state],[previous,frame],frame.at)};
}

// Supplemental sources can fill gaps but cannot promote an old quote to current.
export function combineObservationBooks(primary,secondary){
  if(!primary||!secondary)return primary||secondary;
  if(!sameSettings(primary.frame,secondary.frame))return primary;
  const now=Math.max(primary.frame.at,secondary.frame.at),rows=new Map();
  const stops=collectStops([primary,secondary],[],now);
  insertRows(rows,primary.displayRows,now,stops,false);
  insertRows(rows,secondary.displayRows,now,stops,true);
  return {...primary,displayRows:[...rows.values()],stops,failures:collectFailedChecks([primary,secondary],[],now)};
}

export function displayedObservations(state,now,waiting=false){
  if(!state?.frame||!now)return [];
  const book=state.displayRows?state:mergeFrame(null,{...state.frame,previous:state.previous});
  return book.displayRows.filter(r=>recent(r.time,now)).map(r=>({...r,
    previous:r.previous||!!(waiting&&book.frame.complete)||now-r.time>=OBSERVATION_LIVE_MS}));
}

const fields=(obj,keys)=>Object.fromEntries(keys.filter(k=>obj?.[k]!=null).map(k=>[k,obj[k]]));
const legKeys=['id','kind','name','contract','chain','token','fundingRate','intervalHours','nextFundingAt','openInterestUsdt','transfer'];
export function observationCache(book,now){
  if(!book?.frame)return null;
  const {budget,floor,maxImpact}=book.frame;
  const rows=displayedObservations(book,now).slice(0,500).map(r=>({
    ...fields(r,['id','symbol','kind','time','gap','ask','bid']),match:fields(r.match,['chain','token']),
    buy:fields(r.buy,legKeys),sell:fields(r.sell,legKeys)
  }));
  return {budget,floor,maxImpact,rows};
}
export function restoreObservationCache(cache,config,now){
  if(!sameSettings(cache,config)||!Array.isArray(cache.rows))return null;
  const rows=new Map();
  insertRows(rows,cache.rows.slice(0,500),now,new Map(),true);
  if(!rows.size)return null;
  return {frame:{...config,startedAt:0,at:0,complete:false},previous:null,cacheOnly:true,
    displayRows:[...rows.values()],stops:new Map()};
}

// The smaller observation channel can report a newer failure before the next
// full relay payload arrives. In that interval the older quote cannot be used.
export function currentQualifiedRows(snapshot,observations,now) {
  const rows=(snapshot?.rows||[]).filter(r=>isFreshQualified(r,now));
  const book=observations?.frame?observations:null,frame=book?.frame||observations;
  if (!rows.length || !sameSettings(snapshot,frame)) return rows;
  if(!book&&frame.startedAt<snapshot.startedAt)return rows;
  const stops=book?.stops||collectStops([], [frame],now);
  const failures=book?.failures||collectFailedChecks([], [frame],now);
  const checked=new Map();
  for(const check of snapshot.routeChecks||[]){
    if(check.cycle===snapshot.startedAt&&check.status==='passed')checked.set(strictContractKey(check.match)+'|'+check.id,check);
  }
  return rows.filter(r=>{
    const id=strictContractKey(r.match)+'|'+r.id;
    const quoteAt=Math.min(r.buyQuoteAt,r.sellQuoteAt),networkAt=checked.get(id)?.networkAt;
    const confirmedAt=Number.isFinite(networkAt)?Math.min(quoteAt,networkAt):quoteAt;
    return (stops.get(id)??-Infinity)<confirmedAt&&(failures.get(id)??-Infinity)<(r.verifiedAt??quoteAt);
  });
}

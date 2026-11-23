import {strictContractKey} from './contract-identity.mjs';
import {isFreshQualified} from './quote-freshness.mjs';
import {venueFamily} from './venue-family.mjs';

export const OBSERVATION_LIVE_MS = 45_000;
export const OBSERVATION_HOLD_MS = 120_000;

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

// Only a different cycle can supply the faded rows. A disappearing quote within
// a cumulative frame must not be reinstated as a fresh comparison.
export function mergeFrame(state,incoming) {
  const {previous:seed,...frame}=incoming;
  if (!sameSettings(state?.frame,frame)) state=null;
  const older=(other)=>other && sameSettings(other,frame) && other.startedAt<frame.startedAt;
  if (state && frameOrder(frame,state.frame)<=0) {
    if (!state.frame.complete && state.frame.startedAt>frame.startedAt && (!state.previous || frameOrder(frame,state.previous)>0))
      return {...state,previous:frame};
    return state;
  }
  const previous=[seed,state?.frame,state?.previous].filter(older).sort((a,b)=>frameOrder(b,a))[0];
  return {frame,previous:frame.complete?null:previous||null};
}

export function displayedObservations(state,now,waiting=false) {
  if (!state?.frame || !now) return [];
  const result=[], seen=new Set();
  function add(frame,previous) {
    for (const r of [...(frame?.spotGaps||[]),...(frame?.futures?.rows||[])]) {
      const ca=strictContractKey(r.match),family=venueFamily(r.buy?.kind,r.sell?.kind),age=now-r.time;
      if (!ca || !family || !(r.gap>0) || !Number.isFinite(age) || age< -5000 || age>=OBSERVATION_HOLD_MS) continue;
      const key=r.kind==='spot_spot' ? ca+'|'+family : ca+'|'+r.id;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({...r,previous:previous||age>=OBSERVATION_LIVE_MS});
    }
  }
  add(state.frame,waiting && state.frame.complete);
  if (!state.frame.complete) add(state.previous,true);
  return result;
}

// The smaller observation channel can report a newer failure before the next
// full relay payload arrives. In that interval the older quote cannot be used.
export function currentQualifiedRows(snapshot,frame,now) {
  const rows=(snapshot?.rows||[]).filter(r=>isFreshQualified(r,now));
  if (!rows.length || !sameSettings(snapshot,frame) || frame.startedAt<snapshot.startedAt) return rows;
  const stops=new Map();
  function invalidate(route,at){
    const key=strictContractKey(route.match);
    if (!key || !Number.isFinite(at) || at>now) return;
    const id=key+'|'+route.id;
    stops.set(id,Math.max(at,stops.get(id)||0));
  }
  for (const check of frame.routeChecks||[]) {
    if (check.cycle===frame.startedAt && check.status!=='passed') invalidate(check,check.checkedAt);
  }
  for (const r of frame.diagnosticGaps||[]) {
    const code=r.diagnosis?.code;
    if (code==='deposit_closed'||code==='withdraw_closed') invalidate(r,r.networkAt);
    else if (['slippage','fees','transfer_limit','depth'].includes(code)) invalidate(r,Math.min(r.buyQuoteAt,r.sellQuoteAt));
  }
  return rows.filter(r=>(stops.get(strictContractKey(r.match)+'|'+r.id)??-Infinity)<
    (r.verifiedAt??Math.max(r.buyQuoteAt,r.sellQuoteAt)));
}

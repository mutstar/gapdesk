import {strictContractKey} from './contract-identity.mjs';
import {venueFamily} from './venue-family.mjs';
import {isFreshQualified,QUOTE_MAX_AGE_MS} from './quote-freshness.mjs';
import {displayedObservations,sameSettings,OBSERVATION_HOLD_MS} from './observation-window.mjs';
import {CHAINS} from './assets.js';

const labels={
  deposit_closed:'입금 중단',withdraw_closed:'출금 중단',transfer_unverified:'입출금 조건 미확인',
  transfer_limit:'이체 금액 한도',order_limit:'최소 주문 조건',stale_quote:'호가 유효시간 경과',stale_network:'입출금 정보 갱신 대기',
  depth:'호가·풀 잔량 부족',depth_unverified:'잔량 정보 미확인',slippage:'슬리피지·체결가 영향',
  fees:'비용 차감 후 순차익 부족',below_floor:'예상 순차익 미달',gross_below_floor:'수수료 차감 전 기준 미달',
  market_unavailable:'마켓 거래 조건 미충족',pending:'정밀 견적 대기',unverified:'정밀 견적 미확인',
  expired:'관찰 유효시간 경과',refresh:'새 관찰 대기',perp:'선물 가격 비교',passed:'현물 조건 충족',
  wallet_missing:'지갑 연결 필요',wallet_cex:'거래소 계정 필요',wallet_unknown:'지갑 잔액 확인 대기',
  wallet_usdc:'USDC 잔액 부족',wallet_gas:'가스 잔액 부족'
};
export const reasonLabel=code=>labels[code]||'경로 확인 결과';
const fmt=n=>n.toLocaleString('ko-KR',{maximumSignificantDigits:7});
const reason=(code,detail)=>({code,detail});
function routeKey(row){
  const ca=strictContractKey(row?.match);
  return ca&&row.id?[ca,row.id].join('|'):null;
}
function scoped(rows){
  const map=new Map();
  for(const row of rows){const k=routeKey(row);if(k)map.set(k,row)}
  return map;
}

// Uses the same funds predicate as the execution list. Missing balances mean the
// chain has not returned a usable wallet read.
export function walletGapReason(row,address,balances={}){
  if(!address)return reason('wallet_missing','지갑을 연결하면 체인별 USDC와 가스 잔액을 확인할 수 있어요.');
  if(row.buyKind!=='DEX'||row.sellKind!=='DEX')return reason('wallet_cex','이 경로는 거래소 계정에서 주문하거나 입출금해야 해요.');
  const from=balances[row.from],to=balances[row.to];
  const chain=id=>CHAINS[id]?.name||String(id);
  if(!Number.isFinite(from?.usdc))return reason('wallet_unknown',chain(row.from)+'의 USDC 잔액을 확인 중이에요.');
  if(from.usdc<row.budget)return reason('wallet_usdc',chain(row.from)+' 잔액 '+fmt(from.usdc)+' USDC · 필요 '+fmt(row.budget)+' USDC');
  const gas=[
    [row.from,from?.eth,(row.buyGas+row.bridgeGas+(row.approvalGas||0)+.02)/(row.gasPriceFrom||1)],
    [row.to,to?.eth,(row.sellGas+(row.approvalGas||0)+.02)/(row.gasPriceTo||1)]
  ];
  for(const [id,balance,needed] of gas){
    if(!Number.isFinite(balance)||!Number.isFinite(needed))return reason('wallet_unknown',chain(id)+'의 가스 잔액과 필요량을 확인 중이에요.');
    if(balance<needed){
      const unit=CHAINS[id]?.gas||'가스 토큰';
      return reason('wallet_gas',chain(id)+' 잔액 '+fmt(balance)+' '+unit+' · 필요 '+fmt(needed)+' '+unit);
    }
  }
  return null;
}

function quoteAgeReason(row,now){
  const legs=[[row.buyQuoteAt,row.buy?.name,'매수'],[row.sellQuoteAt,row.sell?.name,'매도']];
  const late=legs.filter(([t])=>t>0&&now-t>=QUOTE_MAX_AGE_MS);
  if(late.length)return reason('stale_quote',late.map(([t,name,side])=>name+' '+side+' 호가 '+Math.floor((now-t)/1000)+'초 경과').join(' · ')+' (유효시간 45초)');
  if(row.networkAt>0&&now-row.networkAt>=QUOTE_MAX_AGE_MS)return reason('stale_network','입출금 정보 확인 후 '+Math.floor((now-row.networkAt)/1000)+'초가 지났어요. 유효시간은 45초예요.');
  if(now-row.time>=QUOTE_MAX_AGE_MS)return reason('expired','마지막 가격·경로 관찰 후 '+Math.floor((now-row.time)/1000)+'초가 지났어요.');
  return null;
}
function diagnosisOf(row,check,exact,now){
  if(row.kind!=='spot_spot')return reason('perp','현물 조건 충족 건수에서 제외돼요. 선물 진입 갭은 수수료와 펀딩 전 가격 차이예요.');
  if(exact)return reason('passed','양쪽 호가와 이동 비용을 반영한 순차익이 설정 금액을 충족해요.');
  if(row.previous)return quoteAgeReason(row,now)||reason('refresh','직전 스캔의 가격이에요. 이번 스캔에서 같은 경로의 호가를 기다리고 있어요.');
  const age=quoteAgeReason(row,now);
  if(age)return row.diagnosis?.code===age.code&&row.diagnosis?.detail&&age.code!=='stale_quote'?row.diagnosis:age;
  if(check?.diagnosis && check.status!=='passed' && check.diagnosis.code!=='passed')return check.diagnosis;
  if(check?.status==='passed')return reason('pending','직전 정밀 견적의 유효시간을 다시 확인하고 있어요.');
  if(row.diagnosis?.detail&&row.diagnosis.code!=='passed')return row.diagnosis;
  return reason('pending','설정한 금액으로 양쪽 체결가와 비용을 확인할 차례예요.');
}
function collectChecks(frames,frame,now){
  const current=new Map(),past=new Map();
  for(const f of frames){
    if(!sameSettings(f,frame))continue;
    for(const c of f.routeChecks||[]){
      const k=routeKey(c);
      if(!k || c.cycle!==f.startedAt || c.checkedAt>now || now-c.checkedAt>=QUOTE_MAX_AGE_MS || !Number.isFinite(c.checkedAt))continue;
      const target=c.cycle===frame.startedAt?current:c.cycle<frame.startedAt?past:null;
      if(target&&(!target.has(k)||target.get(k).checkedAt<c.checkedAt))target.set(k,c);
    }
  }
  return {current,past};
}
/** @param {{observations:any,snapshot:any,now:number,budget:number,waiting?:boolean,verified?:Array<Record<string,any>>}} options */
export function gapReasonView({observations,snapshot,now,budget,waiting=false,verified=[]}){
  const usable=f=>f?.budget===budget&&f.at>0&&f.at<=now+5000&&now-f.at<OBSERVATION_HOLD_MS;
  const frame=usable(observations?.frame)?observations.frame:usable(snapshot)?{...snapshot,complete:true}:null;
  if(!frame)return {frame:null,live:[],blocked:[],extra:[]};
  const state=frame===observations?.frame?observations:{frame};
  const {current,past}=collectChecks([snapshot,observations?.previous,frame],frame,now);
  const previousQuotes=sameSettings(snapshot,frame)?scoped(snapshot.rows||[]):new Map();
  const verifiedMap=scoped(verified.filter(r=>r.budget===budget&&isFreshQualified(r,now)));
  const currentKeys=scoped(frame.spotGaps||[]);
  const blockedMap=scoped((frame.diagnosticGaps||[]).filter(r=>r.kind==='spot_spot'&&r.gap>0&&venueFamily(r.buy?.kind,r.sell?.kind)&&!currentKeys.has(routeKey(r))));
  function withReason(r,blocked=false){
    const key=routeKey(r);
    const verifiedRow=verifiedMap.get(key),check=current.get(key);
    const checkedAt=verifiedRow?.verifiedAt??Math.max(verifiedRow?.buyQuoteAt||0,verifiedRow?.sellQuoteAt||0);
    const newerFailure=check&&check.status!=='passed'&&check.checkedAt>=checkedAt;
    const exact=!r.previous&&!blocked&&!newerFailure&&r.kind==='spot_spot'?(verifiedRow||null):null;
    let diagnosis=diagnosisOf(r,check,exact,now);
    const prior=past.get(key),oldQuote=previousQuotes.get(key);
    let lastCheck=null;
    if(!exact && !blocked && diagnosis.code==='pending' && oldQuote && snapshot.startedAt===frame.startedAt &&
       !isFreshQualified(oldQuote,now) && oldQuote.buyQuoteAt>0 && oldQuote.sellQuoteAt>0){
      const elapsed=quoteAgeReason({...r,buyQuoteAt:oldQuote.buyQuoteAt,sellQuoteAt:oldQuote.sellQuoteAt,networkAt:0,time:now},now);
      if(elapsed)diagnosis=elapsed;
      else if(oldQuote.expires<=now)diagnosis=reason('expired','정밀 견적의 경로 유효시간이 지났어요. 비용과 이동 조건을 다시 확인하고 있어요.');
    }
    if(check?.diagnosis && check.status!=='passed' && !exact && check.diagnosis.detail!==diagnosis.detail){
      lastCheck={...check,prior:false};
    }else if(['pending','refresh'].includes(diagnosis.code)&&prior?.diagnosis&&prior.status!=='passed'){
      lastCheck={...prior,prior:true};
    }
    return {...r,diagnosis,exact,lastCheck};
  }
  const live=displayedObservations(state,now,waiting).filter(r=>!blockedMap.has(routeKey(r))).map(r=>({...withReason(r),carried:r.kind==='spot_spot'&&!currentKeys.has(routeKey(r))}));
  const blocked=[...blockedMap.values()].map(r=>withReason(r,true)).sort((a,b)=>b.gap-a.gap||a.id.localeCompare(b.id));
  const shown=scoped([...live,...blocked]);
  const extra=[...current.values()].filter(c=>!shown.has(routeKey(c))&&c.buy?.kind&&c.sell?.kind).map(c=>withReason(c));
  return {frame,live,blocked,extra};
}
export function spotReasonGroups(view,family){
  const counts=new Map();
  for(const row of [...view.live,...view.blocked,...view.extra]){
    if(row.carried||row.kind!=='spot_spot'||(family!=='전체'&&venueFamily(row.buy.kind,row.sell.kind)!==family))continue;
    const {code,detail}=row.diagnosis;
    if(code==='passed')continue;
    const group=counts.get(code)||{code,count:0,symbol:row.symbol,detail,lastCheck:row.lastCheck};
    group.count++;counts.set(code,group);
  }
  return [...counts.values()].sort((a,b)=>b.count-a.count||a.code.localeCompare(b.code));
}

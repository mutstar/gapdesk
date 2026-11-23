'use client';
import {gapReasonView,reasonLabel,spotReasonGroups,walletGapReason} from '../lib/gap-reason-view.mjs';
import {isFreshQualified} from '../lib/quote-freshness.mjs';
import {venueFamily} from '../lib/venue-family.mjs';
import {marketTime} from './market-arrivals';
import {OBSERVATION_HOLD_MS,sameSettings} from '../lib/observation-window.mjs';

type Row=Record<string,any>;
export type Diagnosis={code:string,detail:string};
type SummaryProps={observations:Row|null,snapshot:Row|null,waiting:boolean,now:number,budget:number,family:string,own:boolean,
  address:string,balances?:Row,verified:Row[],busy:boolean,error:string};
const amount=(v:number)=>v.toLocaleString('ko-KR',{maximumFractionDigits:2});

export function DexEmptySummary({observations,snapshot,budget,floor,maxImpact,now}:{observations:Row|null,snapshot:Row|null,budget:number,floor:number,maxImpact:number,now:number}){
  const config={budget,floor,maxImpact};
  const frame=[observations?.frame,observations?.previous,snapshot&&{...snapshot,complete:true}]
    .filter(f=>f?.complete&&sameSettings(f,config)&&f.at<=now+5000&&now-f.at<OBSERVATION_HOLD_MS)
    .sort((a,b)=>b.at-a.at)[0];
  if(!frame)return <p className="signalEmpty" role="status">{amount(budget)} USDC 기준 DEX–DEX 스캔을 기다리고 있어요.</p>;
  const reasons=new Map<string,number>(),paths=new Map<string,string>();
  for(const r of frame.diagnosticGaps||[]){
    if(r.buy?.kind==='DEX'&&r.sell?.kind==='DEX'&&r.gap>0&&r.id)paths.set(r.id,r.diagnosis?.code||'unverified');
  }
  for(const r of frame.routeChecks||[]){
    if(r.buy?.kind!=='DEX'||r.sell?.kind!=='DEX'||r.cycle!==frame.startedAt||!r.id)continue;
    if(r.status==='passed')paths.delete(r.id);
    else paths.set(r.id,r.diagnosis?.code||'unverified');
  }
  for(const code of paths.values())reasons.set(code,(reasons.get(code)||0)+1);
  return <section className="gapReasonSummary" aria-label="DEX–DEX 최근 스캔">
    <strong>{amount(budget)} USDC 기준 · 목표 순차익 {amount(floor)} USDC</strong>
    <p>{marketTime(frame.at)} KST 완료 · {paths.size?'검증을 통과하지 못했거나 견적이 없는 경로 '+paths.size.toLocaleString()+'건':'이번 회차에 기록된 제외 경로가 없어요.'}</p>
    {reasons.size>0&&<details><summary>주요 원인</summary><ul>{[...reasons].sort((a,b)=>b[1]-a[1]).map(([code,count])=><li key={code}><div><strong>{reasonLabel(code)}</strong><b>{count.toLocaleString()}건</b></div></li>)}</ul></details>}
  </section>;
}

export function RouteReason({budget,diagnosis,lastCheck}:{budget:number,diagnosis:Diagnosis,lastCheck?:Row|null}){
  const neutral=['pending','unverified','refresh','expired','depth_unverified','transfer_unverified','perp','stale_network'].includes(diagnosis.code);
  return <div className={'routeReason '+(diagnosis.code==='passed'?'reasonPassed':neutral?'reasonNeutral':'reasonBlocked')}>
    <div><strong>{reasonLabel(diagnosis.code)}</strong><small>{amount(budget)} USDC 기준</small></div>
    <p>{diagnosis.detail}</p>
    {lastCheck?.diagnosis&&<p className="olderCheck">{lastCheck.prior?'직전 스캔 정밀 검증':'최근 정밀 검증'} · {marketTime(lastCheck.checkedAt)} KST · {lastCheck.diagnosis.detail}</p>}
  </div>;
}

export function GapReasonSummary(props:SummaryProps){
  const {observations,snapshot,waiting,now,budget,family,own,address,balances={},verified,busy,error}=props;
  const view=gapReasonView({observations,snapshot,waiting,now,budget,verified});
  const groups=spotReasonGroups(view,family);
  const total=groups.reduce((n,g)=>n+g.count,0);
  const qualified=verified.filter(r=>r.budget===budget&&isFreshQualified(r,now)&&(family==='전체'||venueFamily(r.buyKind,r.sellKind)===family));
  const walletGroups=new Map<string,{count:number,detail:string,symbol:string}>();
  if(own)for(const r of qualified){
    const why=walletGapReason(r,address,balances);
    if(why){const group=walletGroups.get(why.code)||{count:0,detail:why.detail,symbol:r.symbol};group.count++;walletGroups.set(why.code,group)}
  }
  const frame=view.frame;
  const noEvidence=error||(!frame||busy||!frame.complete?'같은 체인·CA의 양쪽 시세와 검증 결과를 수집하고 있어요.':'이번 스캔에서 선택한 거래소 조합에 양의 가격 차이가 있는 현물 경로를 확인하지 못했어요.');
  return <section className="gapReasonSummary" aria-labelledby="zero-gap-reasons">
    <div className="reasonPanelHead"><h3 id="zero-gap-reasons">조건 충족 갭이 0건인 이유</h3><span>{amount(budget)} USDC 기준</span></div>
    {own&&!address&&!walletGroups.size&&<p>지갑을 연결하면 내 잔액으로 실행할 수 있는 경로를 확인해요.</p>}
    {walletGroups.size>0&&<><p>현물 조건을 충족한 {qualified.length}건이 내 지갑 필터에서 제외됐어요.</p>
      <ul>{[...walletGroups].map(([code,g])=><li key={code}><div><strong>{reasonLabel(code)}</strong><b>{g.count}건</b></div><small>{g.symbol} · {g.detail}</small></li>)}</ul></>}
    {groups.length>0?<><p>{family==='전체'?'전체 조합':family}에서 확인한 현물 경로 {total.toLocaleString()}건 · {frame?.complete?'스캔 완료':'수집 중'} · {marketTime(frame!.at)} KST</p>
      <ul>{groups.map(g=><li key={g.code}><div><strong>{reasonLabel(g.code)}</strong><b>{g.count.toLocaleString()}건</b></div><small>{g.symbol} · {g.detail}</small>{g.lastCheck&&<small>{g.lastCheck.prior?'직전 스캔 정밀 검증':'최근 정밀 검증'} · {marketTime(g.lastCheck.checkedAt)} KST · {g.lastCheck.diagnosis.detail}</small>}</li>)}</ul></>:
      !walletGroups.size&&<p role="status">{noEvidence}</p>}
  </section>;
}

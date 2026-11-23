'use client';
import {gapReasonView,reasonLabel,spotReasonGroups,walletGapReason} from '../lib/gap-reason-view.mjs';
import {isFreshQualified} from '../lib/quote-freshness.mjs';
import {venueFamily} from '../lib/venue-family.mjs';
import {marketTime} from './market-arrivals';

type Row=Record<string,any>;
export type Diagnosis={code:string,detail:string};
type SummaryProps={observations:Row|null,snapshot:Row|null,waiting:boolean,now:number,budget:number,family:string,own:boolean,
  address:string,balances?:Row,verified:Row[],busy:boolean,error:string};
const amount=(v:number)=>v.toLocaleString('ko-KR',{maximumFractionDigits:2});

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

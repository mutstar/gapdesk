'use client';
import {useState} from 'react';
import {ContractCopy,type Contract} from './contract-copy';
import {MarketTabs} from './market-tabs';
import {MarketSort,compareMarkets,useMarketOrder} from './market-sort';
import {MarketArrivals} from './market-arrivals';
import {TransferBadges,type TransferStatus} from './trade-leg';
import {strictContractKey} from '../lib/contract-identity.mjs';
import {displayedObservations} from '../lib/observation-window.mjs';
import {isFreshQualified} from '../lib/quote-freshness.mjs';
import {venueFamily} from '../lib/venue-family.mjs';

type Data=Record<string,any>;
type Leg={kind:string,name:string,contract?:string,fundingRate?:number|null,intervalHours?:number|null,transfer?:TransferStatus|null};
type Quote={displayKey:string,previous:boolean,match:Contract,id:string,symbol:string,kind:string,buy:Leg,sell:Leg,ask:number,bid:number,gap:number,time:number};
type Props={snapshot:Data|null,observations:Data|null,waiting:boolean,now:number,budget:number,busy:boolean,error:string,verified:Data[],onOpen:(row:Data)=>void};
const prices=new Intl.NumberFormat('en-US',{maximumSignificantDigits:7});
const percentages=new Intl.NumberFormat('en-US',{maximumFractionDigits:3});
const dateFormat=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit'});
const timeFormat=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',second:'2-digit'});
function QuoteLeg({leg,price,side,now}:{leg:Leg,price:number,side:'buy'|'sell',now:number}){
  const perp=leg.kind==='PERP',buy=side==='buy';
  const action=perp?(buy?'롱':'숏'):(buy?'매수':'매도');
  return <td className={buy?'gapQuoteBuy':'gapQuoteSell'}>
    <div className="gapVenue"><span className={'gapLegLabel'+(perp?' gapPerp':'')}>{action}</span><strong title={leg.contract}>{leg.name}</strong></div>
    <div className="gapLegPrice">{prices.format(price)} <small>USDC</small></div>
    <TransferBadges kind={leg.kind} status={leg.transfer} side={side} now={now}/>
    {perp&&leg.fundingRate!=null&&<small className="gapFunding">펀딩 {(leg.fundingRate*100).toFixed(4)}%{leg.intervalHours?' / '+leg.intervalHours+'h':''}</small>}
  </td>;
}
export function GapExplorer({snapshot,observations,waiting,now,budget,busy,error,verified,onOpen}:Props){
  const [family,setFamily]=useState('전체'),[type,setType]=useState('all');
  const [search,setSearch]=useState(''),[min,setMin]=useState('0'),[limit,setLimit]=useState(10);
  const [order,setOrder]=useMarketOrder('explorer');
  const query=search.trim(),floor=Math.max(0,Number(min)||0);
  const state=observations?.frame?.budget===budget?observations:snapshot?.budget===budget?{frame:{...snapshot,complete:true}}:null;
  const observed=displayedObservations(state,now,waiting) as Quote[];
  const rows=observed.filter(row=>{
    const familyMatches=family==='전체'||venueFamily(row.buy.kind,row.sell.kind)===family;
    const productMatches=type==='all'||row.kind===type;
    const queryMatches=!query||row.symbol.toUpperCase().includes(query.toUpperCase())||
      strictContractKey({chain:row.match.chain,token:query})===strictContractKey(row.match);
    return familyMatches&&productMatches&&row.gap>=floor&&queryMatches;
  }).sort(compareMarkets(order));
  const exactRoutes=new Map<string,Data>();
  for(const route of verified){
    const ca=strictContractKey(route.match);
    if(ca&&route.budget===budget&&isFreshQualified(route,now))exactRoutes.set(ca+'|'+route.id,route);
  }
  const today=dateFormat.format(now);
  return <>
    <div className="panelHead"><h2>갭 탐색</h2><span className="count">관찰 {rows.length.toLocaleString()}건</span></div>
    <MarketTabs family={family} product={type} onChange={(f,t)=>{setFamily(f);setType(t);setLimit(10)}}/>
    <div className="basisFilters gapSearch"><label>토큰 또는 CA<input type="search" placeholder="심볼 또는 주소" value={search} onChange={e=>{setSearch(e.target.value);setLimit(10)}}/></label>
      <label>최소 갭 (%)<input type="number" min="0" step="0.1" value={min} onChange={e=>{setMin(e.target.value);setLimit(10)}}/></label>
      <MarketSort value={order} onChange={next=>{setOrder(next);setLimit(10)}}/></div>
    {rows.length>0?<div className="gapQuoteList"><table aria-label="거래소별 관찰 갭">
      <thead><tr><th scope="col">토큰 · CA</th><th scope="col">매수처</th><th scope="col">매도처</th><th scope="col">가격 차이</th><th scope="col">관찰 시각 <small>KST</small></th></tr></thead>
      <tbody>{rows.slice(0,limit).map(row=>{
        const ca=strictContractKey(row.match),spot=row.kind==='spot_spot';
        const exact=spot&&!row.previous?exactRoutes.get(ca+'|'+row.id):undefined;
        const date=dateFormat.format(row.time);
        return <tr className="gapQuoteRow" key={row.displayKey} data-state={row.previous?'previous':'current'}>
          <th scope="row" className="gapAsset"><strong>{row.symbol}</strong><ContractCopy item={row.match}/></th>
          <QuoteLeg leg={row.buy} price={row.ask} side="buy" now={now}/><QuoteLeg leg={row.sell} price={row.bid} side="sell" now={now}/>
          <td className="gapQuoteValue"><b>{row.gap<0.001?'<0.001%':'+'+percentages.format(row.gap)+'%'}</b>
            {exact&&<button type="button" className="gapRouteAction" onClick={()=>{if(isFreshQualified(exact,Date.now()))onOpen(exact)}} aria-label={row.symbol+' 검증 경로 보기'}>
              {exact.bridge?exact.bridge+' · ':''}순차익 +{prices.format(exact.profit)} USDC <span aria-hidden="true">›</span>
            </button>}</td>
          <td className="gapQuoteTime"><time dateTime={new Date(row.time).toISOString()} title={date+' '+timeFormat.format(row.time)+' KST'}>
            {date!==today&&<span>{date} </span>}{timeFormat.format(row.time)}<small> KST</small></time>{row.previous&&<span className="gapPrevious">직전</span>}</td>
        </tr>;
      })}</tbody></table></div>:<div className="signalEmpty" role="status">{error||((!observed.length&&(busy||state?.frame?.complete===false))?'첫 호가를 기다리는 중이에요.':'조건에 맞는 관찰 갭이 없어요.')}</div>}
    {rows.length>limit&&<div className="pageBar"><button type="button" onClick={()=>setLimit(n=>n+10)}>10건 더 보기</button></div>}
    {state?.frame?.marketCount!=null&&<MarketArrivals frame={state.frame}/>}
  </>;
}

'use client';
import {useState} from 'react';
import {ContractCopy,type Contract} from './contract-copy';
import {MarketTabs,products} from './market-tabs';
import {MarketSort,compareMarkets,useMarketOrder} from './market-sort';
import {DexEmptySummary} from './gap-diagnostics';
import {MarketArrivals} from './market-arrivals';
import {MarketChain,venueLabel} from './market-chain';
import {TransferBadges,type TransferStatus} from './trade-leg';
import {strictContractKey} from '../lib/contract-identity.mjs';
import {displayedObservations,includeVerifiedDexRoutes} from '../lib/observation-window.mjs';
import {isFreshQualified} from '../lib/quote-freshness.mjs';
import {venueFamily} from '../lib/venue-family.mjs';

type Data=Record<string,any>;
type Leg={kind:string,name:string,chain?:number|string,contract?:string,fundingRate?:number|null,intervalHours?:number|null,transfer?:TransferStatus|null};
type Quote={displayKey:string,previous:boolean,match:Contract,id:string,symbol:string,kind:string,buy:Leg,sell:Leg,ask:number,bid:number,gap:number,time:number};
type Props={snapshot:Data|null,observations:Data|null,waiting:boolean,now:number,budget:number,profitFloor:number,maxImpact:number,busy:boolean,error:string,verified:Data[],onOpen:(row:Data)=>void};
const prices=new Intl.NumberFormat('en-US',{maximumSignificantDigits:7});
const percentages=new Intl.NumberFormat('en-US',{maximumFractionDigits:3});
const dateFormat=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit'});
const timeFormat=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',second:'2-digit'});
function QuoteLeg({leg,price,side,now,assetChain}:{leg:Leg,price:number,side:'buy'|'sell',now:number,assetChain:Contract['chain']}){
  const perp=leg.kind==='PERP',buy=side==='buy';
  const action=perp?(buy?'매수 · 롱 진입':'매도 · 숏 진입'):(buy?'매수처':'매도처');
  const chain=leg.kind==='DEX'?(leg.chain??assetChain):assetChain;
  const venue=venueLabel(leg.name,chain);
  return <section className={buy?'gapQuoteBuy':'gapQuoteSell'} aria-label={action+' '+venue}>
    <div className="gapLegTop"><span className="gapLegLabel">{action}</span><span className="gapVenueKind">{perp?'선물':leg.kind}</span></div>
    <div className="gapVenue"><strong title={leg.contract}>{venue}</strong></div>
    <div className="gapLegPrice">{prices.format(price)} <small>USDC</small></div>
    <MarketChain chain={chain} kind={leg.kind} perp={perp}/>
    <TransferBadges kind={leg.kind} status={leg.transfer} side={side} now={now}/>
    {perp&&leg.fundingRate!=null&&<small className="gapFunding">펀딩 {(leg.fundingRate*100).toFixed(4)}%{leg.intervalHours?' / '+leg.intervalHours+'h':''}</small>}
  </section>;
}
export function GapExplorer({snapshot,observations,waiting,now,budget,profitFloor,maxImpact,busy,error,verified,onOpen}:Props){
  const [family,setFamily]=useState('전체'),[type,setType]=useState('all');
  const [search,setSearch]=useState(''),[min,setMin]=useState('0'),[limit,setLimit]=useState(10);
  const [order,setOrder]=useMarketOrder('explorer');
  const query=search.trim(),floor=Math.max(0,Number(min)||0);
  const state=observations?.frame?.budget===budget?observations:snapshot?.budget===budget?{frame:{...snapshot,complete:true}}:null;
  const observed=includeVerifiedDexRoutes(displayedObservations(state,now,waiting),verified,
    [...(snapshot?.routeChecks||[]),...(state?.frame?.routeChecks||[])],now,budget) as Quote[];
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
    <div className="panelHead"><h2>거래 경로</h2><span className="count">관찰 {rows.length.toLocaleString()}건</span></div>
    <MarketTabs family={family} product={type} onChange={(f,t)=>{setFamily(f);setType(t);setLimit(10)}}/>
    <div className="basisFilters gapSearch"><label>토큰 또는 CA<input type="search" placeholder="심볼 또는 주소" value={search} onChange={e=>{setSearch(e.target.value);setLimit(10)}}/></label>
      <label>최소 갭 (%)<input type="number" min="0" step="0.1" value={min} onChange={e=>{setMin(e.target.value);setLimit(10)}}/></label>
      <MarketSort value={order} onChange={next=>{setOrder(next);setLimit(10)}}/></div>
    {rows.length>0?<ul className="gapQuoteList" aria-label="거래소별 관찰 갭">{rows.slice(0,limit).map(row=>{
        const ca=strictContractKey(row.match),spot=row.kind==='spot_spot';
        const exact=spot&&!row.previous?exactRoutes.get(ca+'|'+row.id):undefined;
        const date=dateFormat.format(row.time);
        return <li className="gapQuoteRow" key={row.displayKey} data-state={row.previous?'previous':'current'}>
          <div className="gapQuoteTop"><div className="gapAsset"><strong>{row.symbol}</strong>
            <span className="gapMarketFamily">{venueFamily(row.buy.kind,row.sell.kind)} · {products[row.kind]}</span></div>
            <div className="gapQuoteValue"><span>{spot?'관찰 갭':'진입 갭'}</span><b>{row.gap<0.001?'<0.001%':'+'+percentages.format(row.gap)+'%'}</b></div></div>
          <div className="gapQuoteLegs"><QuoteLeg leg={row.buy} price={row.ask} side="buy" now={now} assetChain={row.match.chain}/>
            <QuoteLeg leg={row.sell} price={row.bid} side="sell" now={now} assetChain={row.match.chain}/></div>
          <div className="gapQuoteFooter"><ContractCopy item={row.match} compact/>
            {exact&&<button type="button" className="gapRouteAction" onClick={()=>{if(isFreshQualified(exact,Date.now()))onOpen(exact)}} aria-label={row.symbol+' 검증 경로 보기'}>
              {exact.bridge?exact.bridge+' · ':''}순차익 +{prices.format(exact.profit)} USDC <span aria-hidden="true">›</span>
            </button>}
            <span className="gapQuoteTime">{row.previous&&<span className="gapPrevious">직전</span>}<time dateTime={new Date(row.time).toISOString()} title={'관찰 시각 '+date+' '+timeFormat.format(row.time)+' KST'}>
              {date!==today&&<span>{date} </span>}{timeFormat.format(row.time)} <small>KST</small></time></span></div>
        </li>;
      })}</ul>:family==='DEX–DEX'&&!query&&floor===0&&!error?<DexEmptySummary observations={observations} snapshot={snapshot} budget={budget} floor={profitFloor} maxImpact={maxImpact} now={now}/>:<div className="signalEmpty" role="status">{error||((!observed.length&&(busy||state?.frame?.complete===false))?'첫 호가를 기다리는 중이에요.':'조건에 맞는 관찰 갭이 없어요.')}</div>}
    {rows.length>limit&&<div className="pageBar"><button type="button" onClick={()=>setLimit(n=>n+10)}>10건 더 보기</button></div>}
    {state?.frame?.marketCount!=null&&<MarketArrivals frame={state.frame}/>}
  </>;
}

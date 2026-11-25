'use client';
import {formatPercentValue} from '../lib/format-percent.mjs';
import {useState,useMemo} from 'react';
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
import {dexPriceRoutes,qualifiedDexRoutes,visibleDexPrices} from '../lib/dex-price-routes.mjs';
import {TokenBridge} from './token-bridge';
import {bridgeDestinations,contractKey} from '../lib/token-contracts.mjs';
import {routePath} from '../lib/execution-status.mjs';
import {venueFamily} from '../lib/venue-family.mjs';

type Data=Record<string,any>;
type Leg={id?:string,kind:string,name:string,chain?:number|string,contract?:string,pool?:string,fundingRate?:number|null,intervalHours?:number|null,transfer?:TransferStatus|null};
type Quote={displayKey:string,previous:boolean,match:Contract,targetMatch?:Contract,identitySource?:string,id:string,symbol:string,kind:string,buy:Leg,sell:Leg,ask:number,bid:number,gap:number,time:number};
type Props={address:string,snapshot:Data|null,observations:Data|null,waiting:boolean,now:number,budget:number,profitFloor:number,maxImpact:number,busy:boolean,error:string,verified:Data[],onOpen:(row:Data)=>void};
const prices=new Intl.NumberFormat('en-US',{maximumSignificantDigits:7});
const dateFormat=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit'});
const timeFormat=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',second:'2-digit'});
function QuoteLeg({leg,price,side,now,assetChain}:{leg:Leg,price:number,side:'buy'|'sell',now:number,assetChain:Contract['chain']}){
  const perp=leg.kind==='PERP',buy=side==='buy';
  const action=perp?(buy?'매수 · 롱 진입':'매도 · 숏 진입'):(buy?'매수처':'매도처');
  const chain=leg.chain??assetChain;
  const venue=venueLabel(leg.name,chain);
  return <section className={buy?'gapQuoteBuy':'gapQuoteSell'} aria-label={action+' '+venue}>
    <div className="gapLegTop"><span className="gapLegLabel">{action}</span><span className="gapVenueKind">{perp?'선물':leg.kind}</span></div>
    <div className="gapVenue"><strong title={leg.contract}>{venue}</strong></div>
    <div className="gapLegPrice">{prices.format(price)} <small>USDC</small></div>
    {leg.pool&&<small className="gapPoolId" title={leg.pool}>풀 {leg.pool.slice(0,6)}…{leg.pool.slice(-4)}</small>}
    <MarketChain chain={chain} kind={leg.kind} perp={perp}/>
    <TransferBadges kind={leg.kind} status={leg.transfer} side={side} now={now}/>
    {perp&&leg.fundingRate!=null&&<small className="gapFunding">펀딩 {(leg.fundingRate*100).toFixed(4)}%{leg.intervalHours?' / '+leg.intervalHours+'h':''}</small>}
  </section>;
}
export function GapExplorer({address,snapshot,observations,waiting,now,budget,profitFloor,maxImpact,busy,error,verified,onOpen}:Props){
  const [family,setFamily]=useState('전체'),[type,setType]=useState('all');
  const [search,setSearch]=useState(''),[min,setMin]=useState('0'),[limit,setLimit]=useState(10);
  const [dexMode,setDexMode]=useState<'prices'|'qualified'>('prices');
  const [scope,setScope]=useState('all');
  const [order,setOrder]=useMarketOrder('explorer');
  const query=search.trim(),floor=Math.max(0,Number(min)||0);
  const state=observations?.frame?.budget===budget?observations:snapshot?.budget===budget?{frame:{...snapshot,complete:true}}:null;
  const observed=includeVerifiedDexRoutes(displayedObservations(state,now,waiting),verified,
    [...(snapshot?.routeChecks||[]),...(state?.frame?.routeChecks||[])],now,budget) as Quote[];
  const dexTab=family==='DEX–DEX';
  const searchDex=family==='전체'&&!!query&&(type==='all'||type==='spot_spot');
  const showPools=dexTab||searchDex,priceScope=dexTab?scope:'all';
  const liveFrame=state?.frame;
  const rawFrame=[liveFrame,snapshot].filter(f=>Array.isArray(f?.dexPoolGroups)).sort((a,b)=>b.startedAt-a.startedAt||b.at-a.at)[0];
  const currentPrices=useMemo(()=>showPools?dexPriceRoutes(rawFrame,priceScope):[],[showPools,priceScope,rawFrame?.dexPoolGroups]);
  const priorFrame=liveFrame?.complete?null:[snapshot,state?.previous].filter(f=>f?.dexPoolGroups&&f.startedAt<liveFrame?.startedAt).sort((a,b)=>b.startedAt-a.startedAt)[0];
  const olderPrices=useMemo(()=>showPools?dexPriceRoutes(priorFrame,priceScope):[],[showPools,priceScope,priorFrame?.dexPoolGroups]);
  const allPrices:Quote[]=showPools?visibleDexPrices(currentPrices,now,waiting||rawFrame?.startedAt<liveFrame?.startedAt):[];
  if(showPools&&olderPrices.length){
    const latestPools=new Set<string>((rawFrame?.dexPoolGroups||[]).flatMap((g:Data)=>g.pools.map((p:Data)=>p.id)));
    const ids=new Set(allPrices.map(r=>r.id));
    allPrices.push(...visibleDexPrices(olderPrices,now,true).filter((r:Quote)=>!ids.has(r.id)&&!(latestPools.has(r.buy.id||'')&&latestPools.has(r.sell.id||''))));
  }
  const passed:Quote[]=dexTab?qualifiedDexRoutes(verified,budget,profitFloor,maxImpact,now):[];
  function matches(row:Quote){
    const familyMatches=family==='전체'||venueFamily(row.buy.kind,row.sell.kind)===family;
    const productMatches=type==='all'||row.kind===type;
    const queryMatches=!query||row.symbol.toUpperCase().includes(query.toUpperCase())||
      [row.match,row.targetMatch].some(c=>c&&strictContractKey({chain:c.chain,token:query})===strictContractKey(c));
    return (!dexTab||scope==='all'||(scope==='cross')===!!row.targetMatch)&&familyMatches&&productMatches&&row.gap>=floor&&queryMatches;
  }
  const priceRows=allPrices.filter(matches),passedRows=passed.filter(matches);
  const observedRows=observed.filter(matches);
  const observedIds=new Set(observedRows.map(r=>r.id));
  const rows=(dexTab?(dexMode==='prices'?priceRows:passedRows):searchDex?
    observedRows.concat(priceRows.filter(r=>!observedIds.has(r.id))):observedRows).sort(compareMarkets(order));
  const exactRoutes=new Map<string,Data>();
  for(const route of verified){
    const ca=strictContractKey(route.match);
    if(ca&&route.budget===budget&&isFreshQualified(route,now))exactRoutes.set(ca+'|'+route.id,route);
  }
  const [bridgeFor,setBridgeFor]=useState('');
  const tokensByCA=useMemo(()=>new Map<string,Data>((snapshot?.tokens||[]).map((t:Data)=>[t.asset,t])),[snapshot?.tokens]);
  const today=dateFormat.format(now);
  return <>
    <div className="panelHead"><h2>거래 경로</h2><span className="count">{dexTab&&dexMode==='qualified'?'조건 충족':'관찰'} {rows.length.toLocaleString()}건</span></div>
    <MarketTabs family={family} product={type} onChange={(f,t)=>{setFamily(f);setType(t);setLimit(10)}}/>
    {dexTab&&<><div className="executionTabs" role="group" aria-label="DEX–DEX 조건 적용">
      <button type="button" aria-pressed={dexMode==='prices'} onClick={()=>{setDexMode('prices');setLimit(10)}}>전체 관찰 갭 <b>{priceRows.length}</b></button>
      <button type="button" aria-pressed={dexMode==='qualified'} onClick={()=>{setDexMode('qualified');setLimit(10)}}>내 조건 충족 <b>{passedRows.length}</b></button>
    </div><div className="executionTabs" role="group" aria-label="체인 범위">{Object.entries({all:'전체 체인 경로',same:'동일 체인',cross:'크로스체인'}).map(([key,label])=><button type="button" key={key} aria-pressed={scope===key} onClick={()=>{setScope(key);setLimit(10)}}>{label}</button>)}</div>
    <p className="dexBasis">{dexMode==='prices'?'같은 자산으로 확인된 풀의 가격차예요. 크로스체인 순차익은 브릿지 견적까지 반영해요.':budget.toLocaleString()+' USDC 기준 · 최소 순차익 '+profitFloor.toLocaleString()+' USDC · 최대 체결가 차이 '+maxImpact+'%'}</p></>}
    <div className="basisFilters gapSearch"><label>토큰 또는 CA<input type="search" placeholder="심볼 또는 주소" value={search} onChange={e=>{setSearch(e.target.value);setLimit(10)}}/></label>
      <label>최소 갭 (%)<input type="number" min="0" step="0.1" value={min} onChange={e=>{setMin(e.target.value);setLimit(10)}}/></label>
      <MarketSort value={order} onChange={next=>{setOrder(next);setLimit(10)}}/></div>
    {rows.length>0?<ul className="gapQuoteList" aria-label="거래소별 관찰 갭">{rows.slice(0,limit).map(row=>{
        const ca=strictContractKey(row.match),spot=row.kind==='spot_spot';
        const exact=spot&&!row.previous?exactRoutes.get(ca+'|'+row.id):undefined;
        const contracts:Contract[]=row.targetMatch?[{...row.match,group:0},{...row.targetMatch,group:0}]:tokensByCA.get(ca||'')?.contracts||[];
        const source=contracts.find(c=>strictContractKey(c)===ca);
        const canLookUp=spot&&source&&bridgeDestinations(source,contracts).length>0;
        const date=dateFormat.format(row.time);
        return <li className="gapQuoteRow" key={row.displayKey} data-state={row.previous?'previous':'current'}>
          <div className="gapQuoteTop"><div className="gapAsset"><strong>{row.symbol}</strong>
            <span className="gapMarketFamily">{venueFamily(row.buy.kind,row.sell.kind)} · {products[row.kind]}</span></div>
            <div className="gapQuoteValue"><span>{dexTab?(dexMode==='prices'?'풀 가격차':'금액별 체결가 차이'):spot?'관찰 갭':'진입 갭'}</span><b>{row.gap<0.001?'<0.001%':'+'+formatPercentValue(row.gap,3)+'%'}</b></div></div>
          <div className="gapQuoteLegs"><QuoteLeg leg={row.buy} price={row.ask} side="buy" now={now} assetChain={row.match.chain}/>
            <QuoteLeg leg={row.sell} price={row.bid} side="sell" now={now} assetChain={row.match.chain}/></div>
          {spot&&<div className="routePath">이동 경로 · {routePath(exact?.from??row.buy.chain??row.match.chain,exact?.to??row.sell.chain??row.match.chain,exact?.bridge,exact?.duration)}</div>}
          {canLookUp&&<div><button type="button" className="bridgeAction" aria-expanded={bridgeFor===row.displayKey} onClick={()=>setBridgeFor(bridgeFor===row.displayKey?'':row.displayKey)}>다른 체인 브릿지 조회</button>
            {bridgeFor===row.displayKey&&<TokenBridge symbol={row.symbol} contracts={contracts} budget={budget} floor={profitFloor} address={address} now={now} lookup initialFrom={contractKey(source)} initialTo={row.targetMatch?contractKey(row.targetMatch):undefined}/>}</div>}
          <div className="gapQuoteFooter"><ContractCopy item={row.match} compact={!row.targetMatch}/>
            {row.targetMatch&&<><span aria-hidden="true">→</span><ContractCopy item={row.targetMatch}/><small>자산 확인 · {row.identitySource}</small></>}
            {exact&&<button type="button" className="gapRouteAction" onClick={()=>{if(isFreshQualified(exact,Date.now()))onOpen(exact)}} aria-label={row.symbol+' 검증 경로 보기'}>
              {exact.bridge?exact.bridge+' · ':''}순차익 +{prices.format(exact.profit)} USDC <span aria-hidden="true">›</span>
            </button>}
            <span className="gapQuoteTime">{row.previous&&<span className="gapPrevious">직전</span>}<time dateTime={new Date(row.time).toISOString()} title={'관찰 시각 '+date+' '+timeFormat.format(row.time)+' KST'}>
              {date!==today&&<span>{date} </span>}{timeFormat.format(row.time)} <small>KST</small></time></span></div>
        </li>;
      })}</ul>:dexTab&&dexMode==='qualified'&&!query&&floor===0&&!error?<DexEmptySummary observations={observations} snapshot={snapshot} budget={budget} floor={profitFloor} maxImpact={maxImpact} now={now}/>:<div className="signalEmpty" role="status">{error||((!observed.length&&(busy||state?.frame?.complete===false))?'첫 호가를 기다리는 중이에요.':dexTab&&dexMode==='prices'?'수신된 풀에서 검색 조건에 맞는 양의 가격차가 없어요.':'조건에 맞는 관찰 갭이 없어요.')}</div>}
    {rows.length>limit&&<div className="pageBar"><button type="button" onClick={()=>setLimit(n=>n+10)}>10건 더 보기</button></div>}
    {state?.frame?.marketCount!=null&&<MarketArrivals frame={state.frame}/>}
  </>;
}

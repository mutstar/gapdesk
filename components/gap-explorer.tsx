'use client';
import {useState} from 'react';
import {MarketTabs,products} from './market-tabs';
import {venueFamily} from '../lib/venue-family.mjs';
import {strictContractKey} from '../lib/contract-identity.mjs';
import {TradeLeg} from './trade-leg';
import {ContractCopy,type Contract} from './contract-copy';

type Leg={kind:string,name:string,contract?:string,chain?:number,token?:string,fundingRate?:number|null,intervalHours?:number|null,nextFundingAt?:number|null,openInterestUsdt?:number|null};
type Quote={match:Contract,id:string,symbol:string,kind:string,buy:Leg,sell:Leg,qty?:number,notional?:number,ask:number,bid:number,gap:number,time:number};
export type FuturesBook={rows:Quote[],priced:number,matched:number,compared:number,thin:number};
const fmt=(n:number)=>n.toLocaleString('en-US',{maximumSignificantDigits:7});
function countdown(next:number,now:number){
  const seconds=Math.ceil((next-now)/1000);
  if(seconds<=0)return '정산 갱신 대기';
  return [Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(n=>String(n).padStart(2,'0')).join(':');
}
function MarketLeg({leg,buy,price,now}:{leg:Leg,buy:boolean,price:number,now:number}){
  const perp=leg.kind==='PERP',rate=leg.fundingRate;
  return <TradeLeg side={buy?'buy':'sell'} perp={perp} venue={leg.name} price={price} caption={leg.contract}>
    {perp&&<><small>펀딩 {rate==null?'미확인':(rate>0?'+':'')+(rate*100).toFixed(4)+'%'}{leg.intervalHours?' / '+leg.intervalHours+'시간':''}</small>
      <small>다음 정산 {leg.nextFundingAt?countdown(leg.nextFundingAt,now):'미확인'}</small>
      <small>미결제약정 {leg.openInterestUsdt==null?'미확인':new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:2}).format(leg.openInterestUsdt)+' USDT'}</small></>}
  </TradeLeg>
}
type Props={spots?:Quote[],book?:FuturesBook,now:number,budget:number,busy:boolean,error:string,verified:Record<string,any>[],onOpen:(row:Record<string,any>)=>void};

export function GapExplorer({spots,book,now,budget,busy,error,verified,onOpen}:Props){
 const [family,setFamily]=useState('전체'),[type,setType]=useState('all'),[search,setSearch]=useState(''),[min,setMin]=useState('0'),[limit,setLimit]=useState(10);
 const query=search.trim(),floor=Math.max(0,Number(min)||0);
 const checked=new Map(verified.map(r=>[r.id,r]));
 const live=[...(spots||[]),...(book?.rows||[])].filter(r=>{
   const ca=strictContractKey(r.match);
   if(!ca||!venueFamily(r.buy.kind,r.sell.kind)||r.gap<=0||r.gap<floor||r.time>now+5000||now-r.time>=45000)return false;
   return !query||r.symbol.toUpperCase().includes(query.toUpperCase())||strictContractKey({chain:r.match.chain,token:query})===ca;
 });
 const rows=live.filter(r=>(family==='전체'||venueFamily(r.buy.kind,r.sell.kind)===family)&&(type==='all'||r.kind===type)).sort((a,b)=>b.gap-a.gap||a.id.localeCompare(b.id));
 return <><div className="panelHead"><h2>거래소 조합</h2><span className="count">{rows.length.toLocaleString()}건</span></div>
   <MarketTabs family={family} product={type} onChange={(f,t)=>{setFamily(f);setType(t);setLimit(10)}}/>
   <div className="basisFilters"><label>토큰 또는 CA<input type="search" placeholder="심볼 또는 주소" value={search} onChange={e=>{setSearch(e.target.value);setLimit(10)}}/></label><label>최소 갭 (%)<input type="number" min="0" step="0.1" value={min} onChange={e=>{setMin(e.target.value);setLimit(10)}}/></label></div>
   {rows.slice(0,limit).map(r=>{
     const spot=r.kind==='spot_spot',result=checked.get(r.id);
     const exact=spot&&result&&result.budget===budget&&strictContractKey(r.match)===strictContractKey(result.match)?result:null;
     return <article key={r.id+'~'+strictContractKey(r.match)} className="signalCard basisCard">
       <header><strong>{r.symbol}</strong><span>{venueFamily(r.buy.kind,r.sell.kind)} · {products[r.kind]}</span><b><small>{spot?'관찰 갭':'진입 갭'}</small> +{r.gap.toFixed(3)}%</b></header>
       <div className="tradePair"><MarketLeg leg={r.buy} buy price={r.ask} now={now}/><MarketLeg leg={r.sell} buy={false} price={r.bid} now={now}/></div>
       <div className="marketTools"><div className="marketActions"><ContractCopy item={r.match}/><span className="marketState">{spot?'입출금 경로 확인':'기초자산 CA 일치'}</span></div>
       {exact&&<button className="bridgeAction" onClick={()=>onOpen(exact)}>예상 순차익 +{fmt(exact.profit)} USDC · 경로 확인</button>}</div>
       {!spot&&r.qty!=null&&r.notional!=null&&<p>비교 수량 {fmt(r.qty)} {r.symbol} · 매수 기준 {fmt(r.notional)} USDC{r.sell.kind!=='PERP'?' · 현물 보유 또는 차입 필요':''}</p>}
     </article>;
   })}
   {!rows.length&&<div className="signalEmpty" role="status">{error||(!spots&&busy?'최신 호가를 조회하고 있어요.':'선택한 조합과 조건에 맞는 최신 갭이 없어요.')}</div>}
   {rows.length>limit&&<div className="pageBar"><button onClick={()=>setLimit(limit+10)}>10건 더 보기</button></div>}
   <p className="basisNote">{fmt(budget)} USDC 기준 · 현물은 체인·CA별로 각 조합의 가장 큰 관찰 갭을 표시해요. 선물 진입 갭은 수수료·펀딩 전 가격 차이예요.</p>
 </>;
}

'use client';
import {useState} from 'react';
import {TradeLeg} from './trade-leg';
import {ContractCopy} from './contract-copy';

type Leg={kind:string,name:string,contract?:string,chain?:number,token?:string,fundingRate?:number|null,intervalHours?:number|null,nextFundingAt?:number|null,openInterestUsdt?:number|null};
type Quote={id:string,symbol:string,kind:string,buy:Leg,sell:Leg,qty:number,notional:number,ask:number,bid:number,gap:number,time:number};
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
    {leg.chain&&leg.token&&<ContractCopy item={{chain:leg.chain,token:leg.token}}/>}
  </TradeLeg>
}
export function FuturesBoard({book,now,budget,busy}:{book?:FuturesBook,now:number,budget:number,busy:boolean}){
  const [type,setType]=useState('all'),[search,setSearch]=useState(''),[min,setMin]=useState('0.1'),[limit,setLimit]=useState(10);
  const rows=(book?.rows||[]).filter(r=>now-r.time<45000&&r.gap>=Number(min)&&(type==='all'||r.kind===type)&&r.symbol.includes(search.trim().toUpperCase()));
  return <><div className="panelHead"><div><h2>무기한 선물 진입 갭</h2><p className="hint">{fmt(budget)} USDC 기준 · 수수료·펀딩 전 가격 차이</p></div><span className="count">{rows.length}건</span></div>
    <div className="tabs" aria-label="선물 조합">{[['all','전체'],['perp_spot','현물–선물'],['perp_perp','선물–선물']].map(([v,l])=><button key={v} aria-pressed={v===type} className={v===type?'selected':''} onClick={()=>{setType(v);setLimit(10)}}>{l}</button>)}</div>
    <div className="basisFilters"><label>토큰 검색<input type="search" placeholder="ACE, BTC…" value={search} onChange={e=>{setSearch(e.target.value);setLimit(10)}}/></label><label>최소 진입 갭 (%)<input type="number" min="0" step="0.1" value={min} onChange={e=>{setMin(e.target.value);setLimit(10)}}/></label></div>
    {rows.slice(0,limit).map(r=><article key={r.id} className="signalCard basisCard"><header><strong>{r.symbol}</strong><span>{r.kind==='perp_perp'?'선물–선물':'현물–선물'}</span><b>+{r.gap.toFixed(3)}%</b></header>
      <div className="tradePair"><MarketLeg leg={r.buy} buy price={r.ask} now={now}/><MarketLeg leg={r.sell} buy={false} price={r.bid} now={now}/></div>
      <p>비교 수량 {fmt(r.qty)} {r.symbol} · 매수 기준 {fmt(r.notional)} USDC{r.sell.kind!=='PERP'?' · 현물 보유 또는 차입 필요':''}</p></article>)}
    {!rows.length&&<div className="signalEmpty" role="status">{!book||!book.priced?busy?'선물 호가를 조회하고 있어요.':'최신 선물 호가를 기다리고 있어요.':'현재 금액과 필터를 충족하는 최신 선물 갭이 없어요.'}</div>}
    {rows.length>limit&&<div className="pageBar"><button onClick={()=>setLimit(limit+10)}>10건 더 보기</button></div>}
    <p className="basisNote">양쪽에 같은 수량을 잡을 때의 진입 가격을 비교해요. 손익은 청산 가격과 보유 중 펀딩비에 따라 달라집니다. 펀딩이 양수면 롱이 숏에 지급해요. 계정별 증거금·차입 가능 여부는 별도 확인이 필요합니다.</p></>;
}

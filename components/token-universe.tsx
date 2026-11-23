'use client';
import {useEffect,useMemo,useState} from 'react';
import {ChevronDown,Route} from 'lucide-react';
import {ContractCopy,type Contract} from './contract-copy';
import {DISPLAY_RETENTION_MS} from '../lib/observation-window.mjs';
import {isFreshQualified} from '../lib/quote-freshness.mjs';
import {TradeLeg} from './trade-leg';
import {TokenBridge} from './token-bridge';
import {bridgeDestinations} from '../lib/token-contracts.mjs';
import {strictContractKey} from '../lib/contract-identity.mjs';
type R=Record<string,any>;
const num=(n:number)=>n>=1e9?n.toExponential(2):n.toLocaleString('ko-KR',{maximumFractionDigits:2});
type Props={tokens:R[],busy:boolean,at:number,budget:number,floor:number,address:string,now:number,verified:R[]};
export function TokenUniverse({tokens,busy,at,budget,floor,address,now,verified}:Props){
 const [open,setOpen]=useState<{asset:string,lookup:boolean}|null>(null);
 function toggle(asset:string,lookup:boolean){setOpen(v=>v?.asset===asset&&v.lookup===lookup?null:{asset,lookup})}
 const [query,setQuery]=useState(''),[page,setPage]=useState(0),[events,setEvents]=useState<R[]>([]),[historyOK,setHistoryOK]=useState(true);
 const key=query.trim().toUpperCase();
 const quotes=new Map<string,R>();
 for(const r of verified){
   const asset=strictContractKey({chain:r.from,token:r.fromToken});
   if(!asset||asset!==strictContractKey({chain:r.to,token:r.toToken})||asset!==strictContractKey(r.match)||r.budget!==budget||!(isFreshQualified(r,now)&&r.profit>0&&r.qty>0&&r.arrival>0&&r.proceeds>0))continue;
   const ask=r.budget/r.qty,bid=r.proceeds/r.arrival,gap=(bid/ask-1)*100;
   if(gap>0&&gap>(quotes.get(asset)?.gap??0))quotes.set(asset,{gap,ask,bid,buy:r.buy,sell:r.sell,buyImpact:null,sellImpact:null,
     time:Math.min(r.buyQuoteAt,r.sellQuoteAt),previous:false,quote:r});
 }
 const matching=useMemo(()=>tokens.filter(t=>!key||(t.aliases||[t.symbol]).some((name:string)=>name.includes(key))||(t.match&&strictContractKey({chain:t.match.chain,token:query.trim()})===t.asset)),[tokens,key,query]);
 const filtered=matching.map(t=>{
   const live=t.gap!=null&&t.time>0&&now-t.time<45000,quote=quotes.get(t.asset);
   if(quote&&(!live||quote.gap>t.gap))return {...t,...quote};
   if(!live&&t.gap!=null){
     if(t.time>0&&now-t.time<DISPLAY_RETENTION_MS)return {...t,previous:true,quote:null};
     return {...t,gap:null,quote:null};
   }
   return t;
 }).sort((a,b)=>(b.gap??-1)-(a.gap??-1));
 const size=35,last=Math.max(0,Math.ceil(filtered.length/size)-1),index=Math.min(page,last);
 useEffect(()=>{let active=true;const controller=new AbortController();const t=setTimeout(async()=>{
 try{const r=await fetch('/api/events?'+new URLSearchParams({symbol:key,screened:'1'}),{signal:controller.signal,cache:'no-store'});if(!r.ok)throw Error();
 const j=await r.json();if(active){setEvents(j as R[]);setHistoryOK(true)}}catch{if(active){setEvents([]);setHistoryOK(false)}}},250);
 return()=>{active=false;clearTimeout(t);controller.abort()}},[at,key]);
 return <><div className="panelHead"><div><h2>전체 토큰</h2><p className="hint">같은 체인의 같은 CA끼리 비교해요. 매수처 출금과 매도처 입금이 확인된 경로만 갭을 표시합니다.</p></div><span className="count">{num(tokens.length)}개</span></div>
 <div className="coinTools"><input type="search" aria-label="토큰 심볼 또는 CA 검색" placeholder="심볼 또는 컨트랙트 주소 검색" value={query} onChange={e=>{setQuery(e.target.value);setPage(0)}}/><span>{num(filtered.length)}개</span></div>
 <div className="tokenBook">
 {filtered.slice(index*size,(index+1)*size).map(t=>{
   const contracts:Contract[]=t.contracts||[];
   const primary=t.match;
   const cross=contracts.some(c=>bridgeDestinations(c,contracts).length>0);
   const row=t.quote?.bridge?t.quote:null;
   const expanded=!!open&&open.asset===t.asset;
   
   return <article className={'marketCard'+(t.previous?' tokenPrevious':'')} key={t.asset}>
     <header className="marketCardHead"><h3>{t.symbol}</h3><div className="gapValue"><span>관찰 갭</span><strong>{t.gap==null?'—':num(t.gap)+'%'}</strong></div></header>
     {t.gap!=null&&<div className="tradePair">
       <TradeLeg side="buy" venue={t.buy} price={t.ask??null} caption={t.buyImpact!=null?'풀 기준가 대비 '+Number(t.buyImpact).toFixed(2)+'% 불리':undefined}/>
       <TradeLeg side="sell" venue={t.sell} price={t.bid??null} caption={t.sellImpact!=null?'풀 기준가 대비 '+Number(t.sellImpact).toFixed(2)+'% 불리':undefined}/>
     </div>}
     <div className="marketTools"><span className="marketState">{t.gap!=null&&t.time>0?(t.previous?'직전 ':'')+new Date(t.time).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour12:false})+' KST':''}</span><div className="marketActions">
     {primary?<ContractCopy item={primary}/>:<small>CA 미확인</small>}
     {contracts.length>1&&<button type="button" className="moreCA" aria-label={t.symbol+' 체인별 주소 펼치기'} aria-expanded={expanded&&!open?.lookup} onClick={()=>toggle(t.asset,false)}>+{contracts.length-1}<ChevronDown size={11}/></button>}
     {cross?<button type="button" className="bridgeAction" aria-label={t.symbol+' 브리지 조회'} aria-expanded={expanded&&!!open?.lookup} onClick={()=>toggle(t.asset,true)}><Route size={14}/>{row?.bridge||'브리지 조회'}</button>:null}
     </div></div>
     {expanded&&open&&<div className="marketDetail"><TokenBridge key={t.asset+String(open.lookup)} symbol={t.symbol} contracts={contracts} budget={budget} floor={floor} address={address} now={now} lookup={open.lookup}
     initialFrom={row?row.from+':'+row.fromToken:t.asset} initialTo={row?row.to+':'+row.toToken:undefined}/></div>}</article>
 })}
 </div>{!filtered.length&&<p className="coinEmpty">{busy?'토큰 목록을 불러오고 있어요.':'검색 결과가 없습니다.'}</p>}
 <div className="pageBar"><button disabled={index===0} onClick={()=>setPage(index-1)}>이전</button><span>{index+1} / {last+1}</span><button disabled={index===last} onClick={()=>setPage(index+1)}>다음</button></div>
 <details className="observations"><summary>최근 24시간 감지 기록 {key&&'· '+key}</summary><p className="hint">이동 경로를 확인한 관찰 시세차 5% 이상 또는 금액별 견적을 통과한 경로의 시간대별 최고값입니다. 시각은 KST입니다.</p>
 {events.length?events.map((e,i)=><div className="logRow" key={i}><b>{e.symbol}</b><span>사는 곳 {e.buy} · 파는 곳 {e.sell}</span><span>{num(e.gap)}% · {e.kind}</span>{e.token&&<ContractCopy item={{chain:e.chain,token:e.token}}/>}<time>{new Date(e.seen).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false,month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</time></div>):<p className="hint">{historyOK?'저장된 기록이 없습니다.':'이력 저장소 연결을 확인하고 있어요.'}</p>}</details></>
}
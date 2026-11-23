'use client';
import {Fragment,useEffect,useMemo,useState} from 'react';
import {ChevronDown,Route} from 'lucide-react';
import {ContractCopy,type Contract} from './contract-copy';
import {TokenBridge} from './token-bridge';
import {bridgeDestinations} from '../lib/token-contracts.mjs';
import {NATIVE} from '../lib/assets.js';
type R=Record<string,any>;
const num=(n:number)=>n>=1e9?n.toExponential(2):n.toLocaleString('ko-KR',{maximumFractionDigits:2});
const price=(n:number|null)=>n===null?'—':n<.0001?n.toExponential(3):n.toLocaleString('en-US',{maximumSignificantDigits:7});
type Props={tokens:R[],busy:boolean,at:number,budget:number,floor:number,address:string,now:number,verified:R[]};
export function TokenUniverse({tokens,busy,at,budget,floor,address,now,verified}:Props){
 const [open,setOpen]=useState<{symbol:string,lookup:boolean}|null>(null);
 function toggle(symbol:string,lookup:boolean){setOpen(v=>v?.symbol===symbol&&v.lookup===lookup?null:{symbol,lookup})}
 const [query,setQuery]=useState(''),[page,setPage]=useState(0),[events,setEvents]=useState<R[]>([]),[historyOK,setHistoryOK]=useState(true);
 const key=query.trim().toUpperCase();const filtered=useMemo(()=>tokens.filter(t=>!key||t.symbol.includes(key)||t.contracts?.some((c:Contract)=>c.token!==NATIVE&&c.token.toUpperCase()===key)),[tokens,key]);
 const size=35,last=Math.max(0,Math.ceil(filtered.length/size)-1),index=Math.min(page,last);
 useEffect(()=>{let active=true;const controller=new AbortController();const t=setTimeout(async()=>{
 try{const r=await fetch('/api/events?'+new URLSearchParams({symbol:key}),{signal:controller.signal,cache:'no-store'});if(!r.ok)throw Error();
 const j=await r.json();if(active){setEvents(j as R[]);setHistoryOK(true)}}catch{if(active){setEvents([]);setHistoryOK(false)}}},250);
 return()=>{active=false;clearTimeout(t);controller.abort()}},[at,key]);
 return <><div className="panelHead"><div><h2>전체 토큰</h2><p className="hint">가격은 USDC 기준입니다. 기준가 시차가 있거나 심볼만 같은 토큰은 표에 따로 표시합니다.</p></div><span className="count">{num(tokens.length)}개</span></div>
 <div className="coinTools"><input type="search" aria-label="토큰 심볼 또는 CA 검색" placeholder="심볼 또는 컨트랙트 주소 검색" value={query} onChange={e=>{setQuery(e.target.value);setPage(0)}}/><span>{num(filtered.length)}개</span></div>
 <div className="coinScroll"><table className="coinTable"><thead><tr><th>토큰 / CA</th><th>최저 매수</th><th>최고 매도</th><th>관찰 시세차</th><th>브리지</th></tr></thead><tbody>
 {filtered.slice(index*size,(index+1)*size).map(t=>{
   const contracts:Contract[]=t.contracts||[];
   const primary=contracts.find(c=>c.token!==NATIVE)||contracts[0];
   const cross=contracts.some(c=>bridgeDestinations(c,contracts).length>0);
   const row=verified.find(r=>r.symbol===t.symbol&&r.bridge&&r.from!==r.to&&r.expires>now);
   const expanded=!!open&&open.symbol===t.symbol;
   const ambiguous=new Set(contracts.map(c=>c.group)).size>1;
   return <Fragment key={t.symbol}><tr><td><b>{t.symbol}</b><div className="inlineCA">
     {ambiguous?<button type="button" className="bridgeAction" onClick={()=>toggle(t.symbol,false)}>CA 선택 · {contracts.length}</button>:primary?<ContractCopy item={primary}/>:<small>CA 미확인</small>}
     {!ambiguous&&contracts.length>1&&<button type="button" className="moreCA" aria-label={t.symbol+' 체인별 주소 펼치기'} aria-expanded={expanded} onClick={()=>toggle(t.symbol,false)}>+{contracts.length-1}<ChevronDown size={11}/></button>}
   </div></td><td data-label="최저 매수">{price(t.ask)}<small>{t.buy||'시세 대기'}</small></td><td data-label="최고 매도">{price(t.bid)}<small>{t.sell||'시세 대기'}</small></td>
   <td data-label="관찰 시세차">{t.gap===null?'—':num(t.gap)+'%'}<small title={t.time?'비교 시세 기준 '+new Date(t.time).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul'})+' KST':undefined}>{t.status||'견적 전'}</small></td>
   <td>{cross?<button type="button" className="bridgeAction" aria-label={t.symbol+' 브리지 조회'} aria-expanded={expanded} onClick={()=>toggle(t.symbol,true)}><Route size={14}/>{row?.bridge||'조회'}</button>:<small>연결 체인 없음</small>}</td></tr>
   {expanded&&open&&<tr className="detailRow"><td colSpan={5} className="assetDetailCell"><TokenBridge key={t.symbol+String(open.lookup)} symbol={t.symbol} contracts={contracts} budget={budget} floor={floor} address={address} now={now} lookup={open.lookup}
     initialFrom={row?row.from+':'+row.fromToken:undefined} initialTo={row?row.to+':'+row.toToken:undefined}/></td></tr>}</Fragment>
 })}
 </tbody></table></div>{!filtered.length&&<p className="coinEmpty">{busy?'토큰 목록을 불러오고 있어요.':'검색 결과가 없습니다.'}</p>}
 <div className="pageBar"><button disabled={index===0} onClick={()=>setPage(index-1)}>이전</button><span>{index+1} / {last+1}</span><button disabled={index===last} onClick={()=>setPage(index+1)}>다음</button></div>
 <details className="observations"><summary>최근 24시간 감지 기록 {key&&'· '+key}</summary><p className="hint">관찰 시세차 5% 이상 또는 금액별 견적을 통과한 경로의 시간대별 최고값입니다. 시각은 KST입니다.</p>
 {events.length?events.map((e,i)=><div className="logRow" key={i}><b>{e.symbol}</b><span>{e.buy} › {e.sell}</span><span>{num(e.gap)}% · {e.kind}</span><time>{new Date(e.seen).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false,month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</time></div>):<p className="hint">{historyOK?'저장된 기록이 없습니다.':'이력 저장소 연결을 확인하고 있어요.'}</p>}</details></>
}
'use client';
import {useEffect,useMemo,useState} from 'react';
type R=Record<string,any>;
const num=(n:number)=>n>=1e9?n.toExponential(2):n.toLocaleString('ko-KR',{maximumFractionDigits:2});
const price=(n:number|null)=>n===null?'—':n<.0001?n.toExponential(3):n.toLocaleString('en-US',{maximumSignificantDigits:7});
export function TokenUniverse({tokens,busy,at}:{tokens:R[],busy:boolean,at:number}){
 const [query,setQuery]=useState(''),[page,setPage]=useState(0),[events,setEvents]=useState<R[]>([]),[historyOK,setHistoryOK]=useState(true);
 const key=query.trim().toUpperCase();const filtered=useMemo(()=>tokens.filter(t=>!key||t.symbol.includes(key)),[tokens,key]);
 const size=35,last=Math.max(0,Math.ceil(filtered.length/size)-1),index=Math.min(page,last);
 useEffect(()=>{let active=true;const controller=new AbortController();const t=setTimeout(async()=>{
 try{const r=await fetch('/api/events?'+new URLSearchParams({symbol:key}),{signal:controller.signal,cache:'no-store'});if(!r.ok)throw Error();
 const j=await r.json();if(active){setEvents(j as R[]);setHistoryOK(true)}}catch{if(active){setEvents([]);setHistoryOK(false)}}},250);
 return()=>{active=false;clearTimeout(t);controller.abort()}},[at,key]);
 return <><div className="panelHead"><div><h2>전체 토큰</h2><p className="hint">가격은 USDC 기준입니다. 기준가 시차가 있거나 심볼만 같은 토큰은 표에 따로 표시합니다.</p></div><span className="count">{num(tokens.length)}개</span></div>
 <div className="coinTools"><input type="search" aria-label="토큰 심볼 검색" placeholder="토큰 심볼 검색 (예: ACE)" value={query} onChange={e=>{setQuery(e.target.value);setPage(0)}}/><span>{num(filtered.length)}개</span></div>
 <div className="coinScroll"><table className="coinTable"><thead><tr><th>토큰</th><th>최저 매수</th><th>최고 매도</th><th>관찰 시세차</th></tr></thead><tbody>
 {filtered.slice(index*size,(index+1)*size).map(t=><tr key={t.symbol}><td><b>{t.symbol}</b><small>{t.markets}개 마켓</small></td><td>{price(t.ask)}<small>{t.buy||'시세 대기'}</small></td><td>{price(t.bid)}<small>{t.sell||'시세 대기'}</small></td><td>{t.gap===null?'—':num(t.gap)+'%'}<small title={t.time?'비교 시세 기준 '+new Date(t.time).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul'})+' KST':undefined}>{t.status||'견적 전'}</small></td></tr>)}
 </tbody></table></div>{!filtered.length&&<p className="coinEmpty">{busy?'토큰 목록을 불러오고 있어요.':'검색 결과가 없습니다.'}</p>}
 <div className="pageBar"><button disabled={index===0} onClick={()=>setPage(index-1)}>이전</button><span>{index+1} / {last+1}</span><button disabled={index===last} onClick={()=>setPage(index+1)}>다음</button></div>
 <details className="observations"><summary>최근 24시간 감지 기록 {key&&'· '+key}</summary><p className="hint">관찰 시세차 5% 이상 또는 금액별 견적을 통과한 경로의 시간대별 최고값입니다. 시각은 KST입니다.</p>
 {events.length?events.map((e,i)=><div className="logRow" key={i}><b>{e.symbol}</b><span>{e.buy} › {e.sell}</span><span>{num(e.gap)}% · {e.kind}</span><time>{new Date(e.seen).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false,month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</time></div>):<p className="hint">{historyOK?'저장된 기록이 없습니다.':'이력 저장소 연결을 확인하고 있어요.'}</p>}</details></>
}
'use client';
type Mark=Record<string,any>;
export const marketTime=(time:number)=>new Date(time).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour12:false});
export function MarketArrivals({frame}:{frame:Mark}){
  const marks:Mark[]=frame.recentMarkets||[];
  return <details className="marketArrivals"><summary><span className="arrivalLight"/>{frame.complete?'최근 수집':'수집 중'} · 수집 마켓 {Number(frame.marketCount||0).toLocaleString()}개</summary>
    {marks.length?<ul>{marks.map(m=><li key={m.id}><strong>{m.name} · {m.symbol}</strong>{m.pool&&<span title={m.pool}>풀 {m.pool.slice(0,6)}…{m.pool.slice(-4)}</span>}<small>매수 {Number(m.ask).toLocaleString('en-US',{maximumSignificantDigits:7})} · 매도 {Number(m.bid).toLocaleString('en-US',{maximumSignificantDigits:7})}</small><time>{marketTime(m.time)} KST</time></li>)}</ul>:<p>첫 호가 대기 중</p>}
  </details>;
}

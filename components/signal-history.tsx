'use client';
import {useEffect,useState} from 'react';
import {TradeLeg} from './trade-leg';
import {ArrowDownRight,ArrowUpRight,Clock3,Search} from 'lucide-react';

type Row=Record<string,any>;
type Page={items:Row[],nextCursor:string|null,asOf:number|null,historyStartedAt:number|null};
type Props={kind:'gaps'|'spikes',revision:string|number};
const display=(n:number,places=2)=>Number(n).toLocaleString('ko-KR',{maximumFractionDigits:places});
const price=(n:number)=>Number(n).toLocaleString('en-US',{maximumSignificantDigits:8});
const kst=(n:number)=>new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(n);
const windowText=(sec:number)=>sec<60?sec+'초':sec<3600?(sec/60)+'분':(sec/3600)+'시간';
const verdict:Record<string,string>={perp_spot:'현물–선물 진입 갭',perp_perp:'선물–선물 진입 갭',passed:'당시 견적 통과',below_floor:'당시 순차익 미달',blocked:'당시 이동 불가',unconfirmed:'실행 견적 미확정',unchecked:'당시 정밀 견적 없음'};
function GapRow({r}:{r:Row}){
  const active=r.state==='active';
  return <article className="signalCard">
    <div className="signalHead"><strong>{r.symbol}</strong><span className={'verdict '+r.status}>{verdict[r.status]||'미확인'}</span><time>{kst(r.openedAt)} KST 최초 감지</time></div>
    <div className="tradePair">
      <TradeLeg side="buy" venue={r.buy} perp={r.status.startsWith('perp_')&&r.buy.endsWith(' 선물')} price={r.entryAsk} caption="최초 감지 가격"/>
      <TradeLeg side="sell" venue={r.sell} perp={r.status.startsWith('perp_')&&r.sell.endsWith(' 선물')} price={r.entryBid} caption="최초 감지 가격"/>
    </div>
    <div className="signalNumbers"><span>최초 갭 <b>+{display(r.entryGap)}%</b></span><span>{active?'최근 갭':'마지막 관측 갭'} <b>+{display(r.latestGap)}%</b></span>
    {r.status==='passed'&&<span>당시 예상 순차익 <b>+{display(r.profit,4)} USDC</b></span>}</div>
    <p>당시 {display(r.budget)} USDC {r.status.startsWith('perp_')?'· 수수료·펀딩 전':'· 최소 순차익 '+display(r.floor)+' USDC'} · DEX 허용 차이 {display(r.maxImpact)}%</p>
    {r.reason&&<p>{r.reason}</p>}
    <details><summary>가격과 관측 시각</summary><p>매수 {price(r.entryAsk)} → {price(r.latestAsk)} USDC · 매도 {price(r.entryBid)} → {price(r.latestBid)} USDC</p>
    <p>마지막 관측 {kst(r.lastSeen)} KST · {active?'관측 중':r.state==='closed'?'관측 종료':'수집 또는 조건 변경으로 관측 중단'}{r.checkedAt?' · 견적 확인 '+kst(r.checkedAt)+' KST':''}</p></details>
  </article>
}
function SpikeRow({r}:{r:Row}){
  const up=r.side==='up';
  return <article className="signalCard"><div className="signalHead"><strong>{r.symbol}</strong><span className={'spikeMove '+(up?'rise':'drop')}>{up?<ArrowUpRight size={15}/>:<ArrowDownRight size={15}/>} {up?'매도가 급등':'매수가 급락'} {up?'+':''}{display(r.changePct)}%</span><time>{kst(r.at)} KST</time></div>
    <div className="signalRoute">{r.venue} · {windowText(r.windowSec)} 구간</div>
    <div className="signalNumbers"><span>{up?'기준 매수가':'기준 매도가'} <b>{price(r.baselinePrice)}</b></span><span>{up?'감지 매도가':'감지 매수가'} <b>{price(r.price)} USDC</b></span></div>
    <p>기준 {kst(r.baselineAt)} KST · {r.corroborated?'타 거래소 시세 대조됨':'단일 거래소 관측'}</p></article>
}
function Earlier({symbol,before}:{symbol:string,before:number}){
  const [rows,setRows]=useState<Row[]>([]),[error,setError]=useState(false),[busy,setBusy]=useState(true);
  useEffect(()=>{const c=new AbortController();setBusy(true);setRows([]);setError(false);
    fetch('/api/events?'+new URLSearchParams({symbol}),{cache:'no-store',signal:c.signal}).then(async r=>{
      if(!r.ok)throw Error();const data=await r.json() as Row[];
      if(!c.signal.aborted)setRows(data.filter(x=>x.seen<before));
    }).catch(()=>{if(!c.signal.aborted)setError(true)}).finally(()=>{if(!c.signal.aborted)setBusy(false)});return()=>c.abort();
  },[symbol,before]);
  return <details className="pastSignals"><summary>기존 24시간 기록 · {symbol}</summary><p>기존 수집기는 시간대별 최고 갭을 저장했어요. 최초 시각과 당시 설정 금액은 기록 전입니다.</p>
    {rows.map(r=><p key={r.id||[r.seen,r.kind,r.buy,r.sell].join('|')}>{kst(r.seen)} KST · 사는 곳 {r.buy} · 파는 곳 {r.sell} · {display(r.gap)}% · {r.kind}</p>)}
    {!rows.length&&<p>{busy?'조회 중…':error?'기존 기록을 불러오지 못했어요.':'이 심볼의 이전 기록이 없어요.'}</p>}</details>
}
export function SignalHistory({kind,revision}:Props){
  const gaps=kind==='gaps';
  const [market,setMarket]=useState('all');
  const [symbol,setSymbol]=useState(''),[venue,setVenue]=useState(''),[hours,setHours]=useState(24);
  const [pages,setPages]=useState<string[]>(['']),[idx,setIdx]=useState(0),[data,setData]=useState<Page|null>(null),[error,setError]=useState(false),[retry,setRetry]=useState(0);
  const cursor=pages[idx]||'',key=symbol.trim().toUpperCase(),place=venue.trim();
  const refresh=idx===0?revision:0;
  function first(){setPages(['']);setIdx(0);setData(null)}
  useEffect(()=>{const c=new AbortController();
    const t=setTimeout(async()=>{
      try{const q=new URLSearchParams({kind,market,symbol:key,venue:place,hours:String(hours),cursor});
        const r=await fetch('/api/signals?'+q,{cache:'no-store',signal:c.signal});if(!r.ok)throw Error();
        const page=await r.json() as Page;if(!c.signal.aborted){setData(page);setError(false)}
      }catch{if(!c.signal.aborted)setError(true)}
    },200);return()=>{clearTimeout(t);c.abort()}
  },[kind,market,key,place,hours,cursor,refresh,retry]);
  return <><div className="panelHead"><div><h2>{gaps?'신규 갭 기록':'거래소별 급등락 기록'}</h2><p className="hint">{gaps?'최초 감지 시점의 금액·견적을 저장합니다. 견적 통과는 예상 체결 기준입니다.':'동일 마켓의 30초~1시간 구간에서 10% 이상 움직인 시점을 표시합니다.'}</p></div></div>
    {gaps&&<div className="tabs" aria-label="신규 갭 유형">{[['all','전체'],['spot','현물'],['perp_spot','현물–선물'],['perp_perp','선물–선물']].map(([value,label])=><button key={value} aria-pressed={market===value} className={market===value?'selected':''} onClick={()=>{setMarket(value);first()}}>{label}</button>)}</div>}
    <div className="signalFilters"><label><Search size={14}/> 토큰<input type="search" placeholder="예: ACE" value={symbol} onChange={e=>{setSymbol(e.target.value);first()}}/></label>
    <label>기간<select value={hours} onChange={e=>{setHours(Number(e.target.value));first()}}>{[[1,'1시간'],[6,'6시간'],[24,'24시간'],[168,'7일']].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
    <label>거래소<input list="signal-venues" placeholder="전체 · 이름 입력" value={venue} onChange={e=>{setVenue(e.target.value);first()}}/><datalist id="signal-venues">{['빗썸','KuCoin','Bitget','Binance 선물','KuCoin 선물','Bitget 선물','uniswap · Ethereum','pancakeswap · BNB Chain','uniswap · Base','uniswap · Arbitrum'].map(v=><option key={v} value={v}/>)}</datalist></label></div>
    {error&&<div role="alert" className="signalEmpty">기록을 불러오지 못했어요. <button onClick={()=>setRetry(n=>n+1)}>다시 조회</button></div>}
    {data?.items.map(r=>gaps?<GapRow key={r.id} r={r}/>:<SpikeRow key={r.id} r={r}/>)}
    {!error&&!data?.items.length&&<p className="signalEmpty">{!data?'감지 기록을 조회하고 있어요.':'이 조건에서 감지된 기록이 없어요.'}</p>}
    <div className="pageBar"><button disabled={!idx} onClick={()=>{setIdx(idx-1);setData(null)}}>이전</button><span>{idx+1}페이지</span><button disabled={!data?.nextCursor} onClick={()=>{setPages([...pages.slice(0,idx+1),data!.nextCursor!]);setIdx(idx+1);setData(null)}}>다음</button></div>
    {gaps&&(market==='all'||market==='spot')&&key&&!!data?.historyStartedAt&&Date.now()-data.historyStartedAt<86400000&&<Earlier key={key} symbol={key} before={data.historyStartedAt}/>}
    <div className="panelFoot"><span><Clock3 size={14}/>{data?.asOf?'마지막 수집 '+kst(data.asOf)+' KST':'첫 수집 대기'}</span></div></>
}

'use client';
import {useState} from 'react';
import {dexSwapCoverage} from '../lib/dex-swap-coverage.mjs';

type Stream={chain:string;venue?:string;head?:number;processed?:number;at?:number;error?:string;backlog?:boolean;subscribed?:number;available?:number;unpriced?:number;lastQuoteAt?:number;disconnectedAt?:number};
type Receipt={venue:string;chain:string;at:number;protocol:string;pool:string};
const modes=[['all','전체'],['received','스왑 수신'],['pending','직접 감시 대기'],['ledger','원장 API'],['archive','지연 아카이브'],['export','DEX 체결 API'],['orderbook','주문장 체결'],['aggregate','원장 종가'],['index','인덱스 순회']];
function stamp(at:number){
  return new Date(at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
}
export function DexStreamCoverage({receipts,streams,now,at}:{receipts?:Receipt[];streams?:Stream[];now:number;at?:number}){
  const [filter,setFilter]=useState('all');
  const rows=dexSwapCoverage(receipts,streams).map(r=>({...r,group:r.mode==='direct'?(r.evidence.length?'received':'pending'):r.mode}));
  return <details id="dex-streams" className="feeds dexStream"><summary>DEX 스왑 감시 · {rows.length}곳{receipts&&' · 직접 수신 '+rows.filter(r=>r.group==='received').length+'곳'}</summary>
    <p>{receipts?(at?'집계 '+stamp(at)+' KST · ':'')+'DEX별로 마지막 체결 시각과 수신한 풀 버전을 확인할 수 있습니다.':'운영 수집기의 체결 기록을 불러오는 중입니다.'}</p>
    <nav aria-label="DEX 수집 방식">{modes.map(([key,label])=><button type="button" key={key} aria-pressed={filter===key} onClick={()=>setFilter(key)}>{label} {rows.filter(r=>key==='all'||r.group===key).length}</button>)}</nav>
    <ul>{rows.filter(r=>filter==='all'||r.group===filter).map(r=>{
      const last=r.evidence[0],bad=r.feeds.filter((s:Stream)=>s.error||!s.at||now-s.at>120000||s.backlog);
      return <li key={r.id}><div><strong>{r.name}</strong> <span>{modes.find(([key])=>key===r.group)?.[1]}</span></div>
        <div>{r.scope}<small>{r.chains.join(' · ')}</small>{r.transport&&<small>{r.transport}</small>}</div>
        <div>{last?<><time dateTime={new Date(last.at).toISOString()}>{stamp(last.at)}</time><small>{last.chain} · {last.protocol}</small>{r.evidence.length>1&&<details><summary>체인·버전 {r.evidence.length}개</summary>{r.evidence.map(e=><small key={e.chain+e.protocol}>{e.chain} · {e.protocol} · {stamp(e.at)}</small>)}</details>}</>:r.mode==='aggregate'?(r.feeds[0]?.lastQuoteAt?stamp(r.feeds[0].lastQuoteAt):'종가 수신 대기'):['direct','ledger','archive','export','orderbook'].includes(r.mode)?'체결 확인 대기':'순회 조회'}
        {r.feeds.map((s:Stream)=>s.available!=null?<small key={s.chain}>현물 구독 {s.subscribed} / {s.available}{s.disconnectedAt?' · 최근 재연결 '+stamp(s.disconnectedAt):''}</small>:s.unpriced?<small key={s.chain}>가격 미확정 체결 {s.unpriced}건</small>:null)}
        {bad.length>0&&<small>수집 지연 · {bad.map((s:Stream)=>s.chain).join(', ')}</small>}
        {r.feeds.some((s:Stream)=>typeof s.head==='number'&&typeof s.processed==='number'&&s.head>s.processed)&&<details><summary>처리 위치</summary>{r.feeds.filter((s:Stream)=>typeof s.processed==='number'&&typeof s.head==='number').map((s:Stream)=><small key={s.chain}>{s.chain} · {s.processed?.toLocaleString()} / {s.head?.toLocaleString()}</small>)}</details>}
        </div></li>;
    })}</ul></details>;
}

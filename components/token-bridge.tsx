'use client';
import {useEffect,useState} from 'react';
import {ArrowRight,RefreshCw} from 'lucide-react';
import {bridgeDestinations,chainTitle,contractKey,shortCA} from '../lib/token-contracts.mjs';
import {ContractCopy,type Contract} from './contract-copy';

type Props={symbol:string,contracts:Contract[],budget:number,floor:number,address:string,now:number,lookup:boolean,initialFrom?:string,initialTo?:string};
type Result={status:string,reason?:string,provider?:string,minReceive?:string,duration?:number,gasUSD?:number,expires?:number};
const label=(c:Contract)=>chainTitle(c.chain)+' · '+shortCA(c.token);
export function TokenBridge({symbol,contracts,budget,floor,address,now,lookup,initialFrom,initialTo}:Props){
  const [source,chooseSource]=useState(initialFrom||''),[dest,chooseDest]=useState(initialTo||'');
  const [request,setRequest]=useState(lookup?1:0),[result,setResult]=useState<Result|null>(null);
  const sources=contracts.filter(c=>bridgeDestinations(c,contracts).length>0);
  const src=sources.find(c=>contractKey(c)===source)||sources[0];
  const targets:Contract[]=bridgeDestinations(src,contracts);
  const dst=targets.find(c=>contractKey(c)===dest)||targets[0];
  const from=src?.chain,to=dst?.chain,fromToken=src?.token,toToken=dst?.token;
  const key=JSON.stringify([symbol,from,to,fromToken,toToken,budget,floor,address,request]);
  const [resultKey,setResultKey]=useState('');
  useEffect(()=>{
    if(!request||!from||!to)return;
    const controller=new AbortController();
    async function run(){
      let next:Result;
      try{
        const r=await fetch('/api/bridges',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},signal:controller.signal,
          body:JSON.stringify({symbol,from,to,fromToken,toToken,budget,floor,address})});
        const data=await r.json() as Result;next=data.status?data:{status:'unknown',reason:data.reason};
      }catch{next={status:'unknown',reason:'견적 서버에 연결하지 못했어요.'}}
      if(!controller.signal.aborted){setResult(next);setResultKey(key)}
    }
    void run();return()=>controller.abort();
  },[request,key,symbol,from,to,fromToken,toToken,budget,floor,address]);
  const shown=resultKey===key?result:null,expired=shown?.status==='available'&&(shown.expires||0)<=now;
  const busy=!!request&&!shown&&!!src&&!!dst;
  return <div className="assetDetail">
    <div><strong>{symbol} 체인별 주소</strong><div className="addressList">{contracts.map(c=><span className="contractOption" key={contractKey(c)}><ContractCopy item={c}/>{!!c.venues?.length&&<small>{c.venues.join(" · ")}</small>}</span>)}</div></div>
    {src&&dst?<div className="bridgeBox"><strong>브리지 견적 <small>{budget.toLocaleString('ko-KR')} USDC 기준</small></strong>
      <div className="bridgeFields">
        <label>출발<select aria-label="출발 체인 및 토큰" value={contractKey(src)} onChange={e=>{chooseSource(e.target.value);chooseDest('')}}>{sources.map(c=><option key={contractKey(c)} value={contractKey(c)}>{label(c)}</option>)}</select></label>
        <ArrowRight size={16} aria-hidden="true"/>
        <label>도착<select aria-label="도착 체인 및 토큰" value={contractKey(dst)} onChange={e=>chooseDest(e.target.value)}>{targets.map(c=><option key={contractKey(c)} value={contractKey(c)}>{label(c)}</option>)}</select></label>
        <button type="button" disabled={busy} className="bridgeAction" onClick={()=>setRequest(v=>v+1)}><RefreshCw size={14}/>{busy?'조회 중':request?'다시 조회':'견적 조회'}</button>
      </div>
      <div className="bridgeResult" aria-live="polite">{busy?'현재 금액으로 이용할 수 있는 경로를 확인하고 있어요.':expired?'견적 시간이 지났어요. 다시 조회해 주세요.':shown?.status==='available'?<>
        <b>{shown.provider}</b> · 최소 수령 {shown.minReceive} {symbol}{Number(shown.duration)>0?' · 약 '+(Number(shown.duration)<60?Math.ceil(Number(shown.duration))+'초':Math.ceil(Number(shown.duration)/60)+'분'):''}
        {shown.gasUSD!=null?' · 예상 가스비 $'+Number(shown.gasUSD).toLocaleString('en-US',Number(shown.gasUSD)<0.01?{maximumSignificantDigits:3}:{maximumFractionDigits:2}):''}
      </>:shown?.reason||(shown?'이 조건의 견적을 확인할 수 없어요.':'출발·도착 체인을 선택해 현재 견적을 조회하세요.')}</div>
    </div>:<p>동일 자산으로 확인된 다른 지원 체인이 없어요.</p>}
  </div>
}

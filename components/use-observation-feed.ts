'use client';
import {useCallback,useEffect,useMemo,useState} from 'react';
import {combineObservationBooks,mergeFrame,observationCache,restoreObservationCache,sameSettings,OBSERVATION_LIVE_MS} from '../lib/observation-window.mjs';
type Book=Record<string,any>;
type Config={amount:number,min:number,maxImpact:number};

export function useObservationFeed(settings:Config,auto:boolean,tick:number,now:number){
  const {amount,min,maxImpact}=settings;
  const [relay,setRelay]=useState<Book|null>(null),[cloud,setCloud]=useState<Book|null>(null);
  const config=useMemo(()=>({budget:amount,floor:min,maxImpact}),[amount,min,maxImpact]);
  const storageKey='gapdesk:observation-display:v1:'+JSON.stringify([amount,min,maxImpact]);
  useEffect(()=>{
    try{
      const saved=sessionStorage.getItem(storageKey);
      if(!saved)return;
      const restored=restoreObservationCache(JSON.parse(saved),config,Date.now());
      if(restored)setRelay(book=>sameSettings(book?.frame,config)?book:restored);
    }catch{/* The live feed also works with browser storage disabled. */}
  },[config,storageKey]);
  const accept=useCallback((frame:Book,pc:boolean)=>{
    if(!sameSettings(frame,{budget:amount,floor:min,maxImpact}))return;
    (pc?setRelay:setCloud)(state=>mergeFrame(state,frame));
  },[amount,min,maxImpact]);
  useEffect(()=>{
    let active=true,revision='',timer:ReturnType<typeof setTimeout>;
    const abort=new AbortController();
    async function poll(){
      try{
        const q=new URLSearchParams({amount:String(amount),floor:String(min),impact:String(maxImpact),revision});
        const r=await fetch('/api/observations?'+q,{cache:'no-store',signal:abort.signal});
        if(r.ok && r.status!==204){
          const frame=await r.json() as Book;
          if(active){accept(frame,true);revision=r.headers.get('X-Observation-Revision')||''}
        }
      }catch{/* Keep the last source-stamped observation until its display limit. */}
      finally{if(active&&auto)timer=setTimeout(poll,1800)}
    }
    void poll();
    return ()=>{active=false;abort.abort();clearTimeout(timer)};
  },[amount,min,maxImpact,accept,auto,tick]);
  const pc=sameSettings(relay?.frame,config)?relay:null,other=sameSettings(cloud?.frame,config)?cloud:null;
  const usePC=!!pc&&!pc.cacheOnly&&(!other||now-pc.frame.at<OBSERVATION_LIVE_MS||pc.frame.at>=other.frame.at);
  const book=useMemo(()=>combineObservationBooks(usePC?pc:other,usePC?other:pc),[usePC,pc,other]);
  useEffect(()=>{
    if(!book||book.cacheOnly)return;
    try{
      const cache=observationCache(book,Date.now());
      if(cache?.rows.length)sessionStorage.setItem(storageKey,JSON.stringify(cache));
      else sessionStorage.removeItem(storageKey);
    }catch{/* A quota error must not interrupt price updates. */}
  },[book,storageKey]);
  return {book,pc:usePC,accept};
}

import {CHAINS} from './assets.js';

// Each instance owns exactly one scan. Reports are cumulative within that scan
// so a client can miss an intermediate update and still recover the live board.
export function createObservationProgress({startedAt,budget,floor,maxImpact,onProgress,observe,delayMs=350}){
  const spots=new Map(), feeds=new Map(), sources=new Map(), poolIds=new Map(), samples=new Map();
  let timer=null, active=true;

  function recent(at=Date.now()){
    const groups=[...samples.values()].map(list=>list.filter(m=>at-m.time<45000&&m.time<=at+5000));
    const recentMarkets=[];
    for(let i=0;i<12&&recentMarkets.length<12;i++){
      for(const group of groups)if(group[i]&&recentMarkets.length<12)recentMarkets.push(group[i]);
    }
    return recentMarkets;
  }
  function emit(){
    timer=null;
    if(!active)return;
    const at=Date.now(),recentMarkets=recent(at);
    const {spotGaps,futures}=observe([...spots.values()],[...feeds.values()]);
    onProgress({startedAt,at,budget,floor,maxImpact,complete:false,spotGaps,futures,recentMarkets,
      sources:[...sources.values()],marketCount:spots.size});
  }
  function schedule(){
    if(active&&timer===null)timer=setTimeout(emit,delayMs);
  }
  function addMarkets(batch,source){
    if(!active)return;
    if(source)sources.set(source.id,{...source,time:source.at||source.time||0});
    const newSamples=new Map(), touched=new Map(), now=Date.now();
    for(const m of batch){
      const isDex=m.kind==='DEX';
      if(isDex&&(!m.pool||m.referenceOnly))continue;
      const prior=spots.get(m.id);
      if(prior && (prior.depth&&!m.depth&&now-prior.time<45000 || Boolean(prior.depth)===Boolean(m.depth)&&prior.time>m.time))continue;
      spots.set(m.id,m);
      if(!(m.ask>0&&m.bid>0&&m.time>0&&m.time<=now+5000&&now-m.time<45000)||m.quoteReady===false)continue;
      const key=isDex?'pools-'+m.chain:source?.id||m.venue;
      if(isDex){
        if(!poolIds.has(key))poolIds.set(key,new Set());
        poolIds.get(key).add(m.pool);
        touched.set(key,{chain:m.chain,time:Math.max(touched.get(key)?.time||0,m.time)});
      }
      if(!newSamples.has(key))newSamples.set(key,[]);
      const group=newSamples.get(key);
      if(group.length<12)group.push({id:m.id,name:m.name,symbol:m.symbol,kind:m.kind,
        chain:m.chain??null,pool:m.pool??null,ask:m.ask,bid:m.bid,time:m.time});
    }
    for(const [key,group] of newSamples){
      const ids=new Set(group.map(m=>m.id));
      samples.set(key,[...group,...(samples.get(key)||[]).filter(m=>!ids.has(m.id))].slice(0,12));
    }
    for(const [id,{chain,time}] of touched){
      sources.set(id,{id,name:(CHAINS[chain]?.name||String(chain))+' DEX 풀',count:poolIds.get(id).size,
        ok:true,time:Math.max(time,sources.get(id)?.time||0)});
    }
    schedule();
  }
  function addFeed(feed){
    if(!active)return;
    feeds.set(feed.source.id,feed);
    sources.set(feed.source.id,{...feed.source,time:feed.source.at||feed.source.time||0});
    schedule();
  }
  function close(){
    clearTimeout(timer);
    if(timer!==null)emit();
    active=false;
    timer=null;
  }
  return {addMarkets,addFeed,close,recent,marketCount:()=>spots.size};
}

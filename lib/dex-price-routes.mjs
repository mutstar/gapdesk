import {spotRouteId,strictContractKey} from './contract-identity.mjs';
import {matchesQualifiedSettings} from './quote-freshness.mjs';
import {DISPLAY_RETENTION_MS,OBSERVATION_LIVE_MS} from './observation-window.mjs';

// Transport each source price once, even if it participates in many spreads.
const positive=n=>Number.isFinite(n)&&n>0;
export function dexPoolGroups(buckets,now,links=new Map()) {
  const groups=[];
  for(const {match,markets} of buckets){
    const pools=new Map();
    for(const m of markets){
      if(m.kind!=='DEX'||!m.pool||m.referenceOnly||m.quoteReady===false||
         (!positive(m.ask)&&!positive(m.bid))||
         !Number.isFinite(m.time)||m.time>now+5000||now-m.time>=OBSERVATION_LIVE_MS)continue;
      const key=/^0x/i.test(m.pool)?m.pool.toLowerCase():m.pool;
      if((pools.get(key)?.time??0)>=m.time)continue;
      pools.set(key,{id:m.id,name:m.name,symbol:m.symbol,pool:m.pool,ask:m.ask,bid:m.bid,time:m.time});
    }
    if(pools.size)groups.push({match,pools:[...pools.values()]});
  }
  const active=new Set(groups.map(g=>strictContractKey(g.match)));
  return groups.flatMap(g=>{
    const peers=[...(links.get(strictContractKey(g.match))||[])].filter(([key])=>active.has(key)).map(([key,source])=>({key,source}));
    return peers.length?[{...g,peers}]:g.pools.length>=2?[g]:[];
  });
}

export function* dexPairs(groups,scope='all'){
  const index=new Map(groups.map(g=>[strictContractKey(g.match),g]));
  for(const [key,g] of index){
    if(!key)continue;
    const targets=scope==='same'?[]:(g.peers||[]);
    for(const peer of [...(scope==='cross'?[]:[{key,source:null}]),...targets]){
      const other=index.get(peer.key);
      if(!other||peer.source&&String(other.match.chain)===String(g.match.chain))continue;
      for(const b of g.pools)for(const s of other.pools){
        if(b.id===s.id||(!peer.source&&b.pool===s.pool)||!positive(b.ask)||!positive(s.bid)||s.bid<=b.ask)continue;
        yield {b,s,match:g.match,...(peer.source?{targetMatch:other.match,identitySource:peer.source}:{})};
      }
    }
  }
}
export function dexPriceRoutes(frame,scope='all') {
  const routes=[];
  for(const {b,s,match,targetMatch,identitySource} of dexPairs(frame?.dexPoolGroups||[],scope)){
    const id=spotRouteId(b.id,s.id,match,targetMatch);
    routes.push({id,displayKey:id,symbol:b.symbol,kind:'spot_spot',match,targetMatch,identitySource,ask:b.ask,bid:s.bid,gap:(s.bid/b.ask-1)*100,
      time:Math.min(b.time,s.time),buy:{id:b.id,kind:'DEX',name:b.name,chain:match.chain,pool:b.pool},
      sell:{id:s.id,kind:'DEX',name:s.name,chain:targetMatch?.chain??match.chain,pool:s.pool}});
  }
  return routes;
}

export function qualifiedDexRoutes(verified,budget,floor,impact,now){
  return verified.filter(r=>r.buyKind==='DEX'&&r.sellKind==='DEX'&&strictContractKey(r.match)&&
    matchesQualifiedSettings(r,budget,floor,impact,now)&&r.qty>0&&r.arrival>0&&r.proceeds>0).map(r=>{
    const ask=r.budget/r.qty,bid=r.proceeds/r.arrival;
    return {id:r.id,displayKey:r.id,symbol:r.symbol,kind:'spot_spot',match:r.match,targetMatch:r.targetMatch,identitySource:r.identitySource,ask,bid,gap:(bid/ask-1)*100,
      previous:false,time:Math.min(r.buyQuoteAt,r.sellQuoteAt),buy:{kind:'DEX',name:r.buy,chain:r.from,pool:r.depthChecks?.find(d=>d.side==='buy')?.pool},
      sell:{kind:'DEX',name:r.sell,chain:r.to,pool:r.depthChecks?.find(d=>d.side==='sell')?.pool}};
  });
}

export function visibleDexPrices(routes,now,rolling){
  return routes.filter(r=>now-r.time<DISPLAY_RETENTION_MS&&r.time<=now+5000)
    .map(r=>({...r,previous:rolling||now-r.time>=OBSERVATION_LIVE_MS}));
}

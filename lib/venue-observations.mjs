import {comparablePoolSide,reportedEmptyPool} from './pool-anchors.mjs';
import {strictContractKey} from './contract-identity.mjs';
import {dexVenues, networks, geckoNetworks} from './dex-venues.mjs';
import {nativeVenueReaders} from './venue-native.mjs';
import {refreshIndexedTrades} from './indexed-swaps.mjs';
import {updateSolanaDirectory} from './solana-pool-directory.mjs';

const life=45_000;
const fresh=(time,now)=>Number.isFinite(time)&&time<=now+5000&&now-time<life;
const pos=n=>Number.isFinite(n)&&n>0;
const safe=s=>typeof s==='string'&&s.length>0&&s.length<=300&&!/[|~\x00-\x1f]/.test(s);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const paprikaDeployments={
  katana:['ronin','katana','katana_v3'], hyperion:['aptos','hyperion'], projectx:['hyperevm','project_x'],
  shadow:['sonic','shadow_exchange'], merchantmoe:['mantle','merchantmoe_v2_2'],
  fluid:['arbitrum','fluid'],maverick:['arbitrum','maverick_v2'],etherex:['linea','etherex'],
};

export function responseTime(headers,now){
  const date=Date.parse(headers.get('date')||''),age=Number(headers.get('age')||0);
  return Number.isFinite(date)&&Number.isFinite(age)&&age>=0?Math.min(now-age*1000,date):0;
}
export function indexedMarkets(venue,chainSlug,pool,token,symbol,buy,sell,time,fx,label,liquidityUSD){
  const chain=networks[chainSlug];
  if(!chain||!safe(pool)||!safe(symbol)||!safe(token)||!pos(buy)||!pos(sell)||buy<sell||!fx)return [];
  const key=strictContractKey({chain,token});
  if(!key)return [];
  token=key.slice(key.indexOf(':')+1);
  if(typeof chain==='number'&&/^0x[0-9a-f]+$/i.test(pool))pool=pool.toLowerCase();
  const name=venue.name+(label?' '+label:'')+' · '+(chainSlug[0].toUpperCase()+chainSlug.slice(1));
  return [{id:'dex:'+chain+':'+token+':'+pool,kind:'DEX',venue:'dex',dexId:venue.id,
    chain,token,symbol,name,pool,observationOnly:true,reference:'venue-index',referenceOnly:false,
    ask:buy/fx.bid,bid:sell/fx.ask,time:Math.min(time,fx.time),liquidityUSD:pos(liquidityUSD)?liquidityUSD:null}];
}
function addressOn(chain,address){
  return typeof networks[chain]==='number'&&/^0x[0-9a-f]+$/i.test(address)?address.toLowerCase():address;
}
export function readScreener(venue,pairs,at,fx,known=new Map()){
  const markets=[];
  for(const p of pairs){
    if(!venue.chains.includes(p.chainId)||reportedEmptyPool(p.liquidity?.usd))continue;
    const hint=known.get(p.chainId+':'+addressOn(p.chainId,p.pairAddress));
    const sides=[p.baseToken?.address,p.quoteToken?.address].map(t=>addressOn(p.chainId,t));
    const samePool=hint?.tokens?.length===2&&sides[0]!==sides[1]&&sides.every(t=>hint.tokens.includes(t));
    if(!samePool&&!venue.ids.includes(String(p.dexId).toLowerCase()))continue;
    const usd=Number(p.priceUsd),ratio=Number(p.priceNative);
    for(const [t,mark] of [[p.baseToken,usd],[p.quoteToken,usd/ratio]]){
      if(!t||!pos(mark)||!comparablePoolSide(networks[p.chainId],addressOn(p.chainId,t.address),sides[t===p.baseToken?1:0]))continue;
      markets.push(...indexedMarkets(venue,p.chainId,p.pairAddress,t.address,t.symbol,mark,mark,at,fx,
        (p.labels||[]).slice(0,2).join(' '),Number(p.liquidity?.usd)));
    }
  }
  return markets;
}
export function readGecko(venue,deployment,data,at,fx,remember){
  const [chain,dex]=deployment.split('/'),network=geckoNetworks[chain]||chain;
  const tokens=new Map((data.included||[]).filter(t=>t.type==='token').map(t=>[t.id,t.attributes]));
  const rows=[];
  for(const p of data.data||[]){
    const a=p.attributes,rels=p.relationships;
    if(p.type!=='pool'||!a?.address||p.id!==network+'_'+a.address||rels?.dex?.data?.id!==dex)continue;
    const sides=[],symbols=[];
    for(const side of ['base','quote']){
      const id=rels[side+'_token']?.data?.id,t=tokens.get(id),mark=Number(a[side+'_token_price_usd']);
      if(!t||id!==network+'_'+t.address)continue;
      sides.push(addressOn(chain,t.address));symbols.push(t.symbol);
      const other=rels[(side==='base'?'quote':'base')+'_token']?.data?.id;
      if(reportedEmptyPool(a.reserve_in_usd)||!comparablePoolSide(networks[chain],addressOn(chain,t.address),addressOn(chain,tokens.get(other)?.address)))continue;
      rows.push(...indexedMarkets(venue,chain,a.address,t.address,t.symbol,mark,mark,at,fx,
        dex,Number(a.reserve_in_usd)));
    }
    if(sides.length===2&&sides[0]!==sides[1]&&safe(a.address))remember?.({chain,pool:addressOn(chain,a.address),tokens:sides,symbols});
  }
  return rows;
}

// Per-provider rate limits and failures are isolated. Pool discovery and live pool
// reads run outside the 30-second market clock.
export function createVenueMonitor({fetchImpl=fetch,now=Date.now,registry}={}){
  const tracked=new Map(dexVenues.map(v=>[v.id,{v,rows:new Map(),known:new Map(),lastLive:0,screenerAt:0,status:'첫 수집 대기',gecko:0}]));
  const backoff=new Map();
  const running=new Map();
  let cycle=0,geckoCursor=0,chainCursor=0;
  function start(id,job){
    if(!running.has(id))running.set(id,Promise.resolve().then(job).finally(()=>running.delete(id)));
    return running.get(id);
  }
  async function get(url,options={}){
    const host=new URL(url).host;
    if(now()<(backoff.get(host)||0))throw Error('API 재시도 대기');
    const res=await fetchImpl(url,{...options,headers:{accept:'application/json',...options.headers},signal:AbortSignal.timeout(6500)});
    if(!res.ok){
      if(res.status===429){
        const retry=res.headers.get('retry-after'),wait=Number(retry)*1000||Date.parse(retry)-now()||30000;
        backoff.set(host,now()+Math.max(1000,wait));
      }
      throw Error('HTTP '+res.status);
    }
    return {data:await res.json(),time:responseTime(res.headers,now())};
  }
  async function getFx(){
    for(const [url,decode] of [
      ['https://api.kraken.com/0/public/Ticker?pair=USDCUSD',j=>[j.result?.USDCUSD?.a?.[0],j.result?.USDCUSD?.b?.[0]]],
      ['https://api.exchange.coinbase.com/products/USDC-USD/ticker',j=>[j.ask,j.bid]],
    ]){
      try{
        const {data,time}=await get(url),[ask,bid]=decode(data).map(Number);
        if(pos(bid)&&pos(ask)&&ask>=bid&&fresh(time,now()))return {ask,bid,time};
      }catch{ /* Try the other independent USD book. */ }
    }
    return null;
  }
  function save(state,markets){
    let count=0;
    for(const m of markets){
      if(!fresh(m.time,now()))continue;
      if((state.rows.get(m.id)?.time||0)<=m.time)state.rows.set(m.id,m);
      count++;
    }
    if(count)state.lastLive=now();
    state.status=count?'갱신 대기':markets.length?'시세 유효 시간 경과':'일치하는 풀 시세 없음';
    return count;
  }
  async function search(state,fx){
    const {data,time}=await get('https://api.dexscreener.com/latest/dex/search?q='+encodeURIComponent(state.v.id));
    if(!Array.isArray(data.pairs))throw Error('풀 검색 응답 미확인');
    const pairs=data.pairs.filter(p=>state.v.chains.includes(p.chainId)&&state.v.ids.includes(String(p.dexId).toLowerCase())&&safe(p.pairAddress));
    registry?.commit(pairs.map(p=>({chain:p.chainId,pool:addressOn(p.chainId,p.pairAddress),venue:state.v.id})));
    for(const p of pairs){
      const pool=addressOn(p.chainId,p.pairAddress),key=p.chainId+':'+pool;
      state.known.set(key,{...state.known.get(key),chain:p.chainId,pool,seen:now()});
    }
    for(const [k,p] of state.known)if(now()-p.seen>1800000)state.known.delete(k);
    if(save(state,readScreener(state.v,pairs,time,fx)))state.screenerAt=now();
  }
  async function run(){
    const turn=cycle++;
    if(registry)void start('solana-directory',()=>updateSolanaDirectory(registry,get)).catch(()=>{});
    if(registry)void start('pool-trades',()=>refreshIndexedTrades(registry,get)).catch(()=>{});
    const fx=await start('fx',getFx);
    const states=[...tracked.values()];
    for(const s of states)for(const [id,m] of s.rows)if(!fresh(m.time,now()))s.rows.delete(id);
    const native=Object.entries(nativeVenueReaders).map(([id,read])=>start('native-'+id,async()=>{
      const s=tracked.get(id);
      try{
        const rows=await read(get);
        save(s,rows.flatMap(r=>indexedMarkets(s.v,r.chain,r.pool,r.token,r.symbol,r.ask,r.bid,r.time,
          r.usdc?{ask:1,bid:1,time:r.time}:fx,r.label,null).map(m=>r.onlySide?
            {...m,[r.onlySide==='buy'?'bid':'ask']:null,onlySide:r.onlySide}:m)));
      }catch(e){s.status=e.message}
    }));
    const jobs=[];
    // Refresh known pairs by chain, sharing a request across venues. Re-run
    // discovery on a fair rotation so newly listed pools enter the watchlist.
    const byChain=new Map();
    for(const [i,s] of states.entries()){
      if(!s.known.size||i%6===turn%6)jobs.push(()=>search(s,fx).catch(e=>{s.status=e.message}));
      for(const p of s.known.values()){
        if(!byChain.has(p.chain))byChain.set(p.chain,new Map());
        byChain.get(p.chain).set(p.pool,s);
      }
    }
    for(const [chain,pools] of byChain){
      const ids=[...pools.keys()];
      for(let i=0;i<ids.length;i+=30){
        const batch=ids.slice(i,i+30),requested=new Set(batch);
        jobs.unshift(async()=>{
          const u='https://api.dexscreener.com/latest/dex/pairs/'+chain+'/'+batch.map(encodeURIComponent).join(',');
          const {data,time}=await get(u);
          const pairs=(data.pairs||[]).filter(p=>p.chainId===chain&&requested.has(addressOn(chain,p.pairAddress)));
          for(const s of new Set(batch.map(id=>pools.get(id)))){
            const matches=pairs.filter(p=>pools.get(addressOn(chain,p.pairAddress))===s);
            if(save(s,readScreener(s.v,matches,time,fx,s.known)))s.screenerAt=now();
          }
        });
      }
    }
    // Active pools and long-tail pools share each batch. A failed HTTP request
    // leaves the queue intact. Chain rotation continues independently of listings.
    async function refreshRegistry(){
      const chains=registry.chains().sort();
      if(!chains.length)return;
      for(let i=0;i<24;i++){
        const chain=chains[chainCursor++%chains.length],batch=registry.batch(chain,now());
        if(!batch.length)continue;
        const byPool=new Map(batch.map(p=>[p.pool,p]));
        const {data,time}=await get('https://api.dexscreener.com/latest/dex/pairs/'+chain+'/'+batch.map(p=>encodeURIComponent(p.pool)).join(','));
        if(data.pairs!==null&&!Array.isArray(data.pairs))throw Error('Invalid pool batch');
        const learned=[];
        for(const pair of data.pairs??[]){
          if(pair.chainId!==chain||!safe(pair.pairAddress))continue;
          const pool=addressOn(chain,pair.pairAddress),entry=byPool.get(pool);
          if(!entry)continue;
          const s=entry.venue?tracked.get(entry.venue):states.find(s=>s.v.chains.includes(chain)&&s.v.ids.includes(String(pair.dexId).toLowerCase()));
          if(!s)continue;
          const sides=[pair.baseToken?.address,pair.quoteToken?.address].map(a=>addressOn(chain,a));
          if(!sides.every(safe)||sides[0]===sides[1])continue;
          const hints=new Map();
          if(entry.token0&&entry.token1){
            if(!sides.every(a=>a===entry.token0||a===entry.token1))continue;
            hints.set(chain+':'+pool,{tokens:sides});
          }
          if(!hints.size&&!s.v.ids.includes(String(pair.dexId).toLowerCase()))continue;
          save(s,readScreener(s.v,[pair],time,fx,hints));
          learned.push({chain,pool,venue:s.v.id,tokens:sides,symbols:[pair.baseToken?.symbol,pair.quoteToken?.symbol]});
        }
        registry.commit(learned);
        registry.attempted(chain,batch,now());
        await sleep(410);
      }
    }
    const indexed=states.filter(s=>s.v.deployments.length);
    const pending=indexed.filter(s=>now()-s.screenerAt>180000),others=indexed.filter(s=>!pending.includes(s));
    const rotate=(a,offset)=>a.length?a.slice(offset%a.length).concat(a.slice(0,offset%a.length)):[];
    const selected=rotate(pending,geckoCursor).slice(0,6);
    selected.push(...rotate(others,turn*2).slice(0,8-selected.length));
    async function runGecko(){
      geckoCursor+=Math.min(6,pending.length);
      for(const s of selected){
        const started=now();
        const dep=s.v.deployments[s.gecko++%s.v.deployments.length];
        const [chain,dex]=dep.split('/');
        try{
          const pageKey='gecko/'+dep,page=registry?.cursor(pageKey)||1;
          const {data,time}=await get('https://api.geckoterminal.com/api/v2/networks/'+(geckoNetworks[chain]||chain)+'/dexes/'+dex+'/pools?include=base_token,quote_token&page='+page);
          if(!Array.isArray(data.data))throw Error('Invalid Gecko page');
          const discovered=[];
          save(s,readGecko(s.v,dep,data,time,fx,p=>{
            discovered.push({...p,venue:s.v.id});
            if(page===1)s.known.set(p.chain+':'+p.pool,{...p,seen:now()});
          }));
          registry?.commit(discovered,pageKey,page>=10||data.data.length<20?1:page+1);
        }catch(e){s.status=e.message}
        if(s!==selected.at(-1))await sleep(Math.max(0,2150-(now()-started)));
      }
    }
    async function runScreener(){
      const inflight=new Set();
      for(const job of jobs){
        if(inflight.size>=4)await Promise.race(inflight);
        const p=job().catch(()=>{}).finally(()=>inflight.delete(p));inflight.add(p);
        await sleep(330);
      }
      await Promise.all(inflight);
    }
    // A second index can supply a trade timestamp and token identities even if
    // another directory has no pool for the venue or is rate-limited.
    const paprika=Object.entries(paprikaDeployments);
    async function runPaprika(){
      const directories=new Map();
      for(const [id,[chain,...dexes]] of rotate(paprika,turn*4).slice(0,4)){
        const s=tracked.get(id),base='https://api.dexpaprika.com/networks/'+chain+'/pools';
        try{
          if(!directories.has(chain))directories.set(chain,(await get(base+'/search?limit=100')).data.results||[]);
          const pool=directories.get(chain).find(p=>p.chain===chain&&dexes.includes(p.dex_id)&&safe(p.id));
          if(!pool)continue;
          const {data:p,time}=await get(base+'/'+encodeURIComponent(pool.id));
          if(p.chain!==chain||p.id!==pool.id||p.dex_id!==pool.dex_id)continue;
          const tokens=(p.tokens||[]).filter(t=>t.chain===chain),tokensById=new Map(tokens.map(t=>[t.id,t]));
          const baseToken=tokensById.get(p.base_token_id),quote=tokensById.get(p.quote_token_id);
          if(!baseToken||!quote||baseToken.id===quote.id)continue;
          const key=addressOn(chain,p.id);
          s.known.set(chain+':'+key,{chain,pool:key,tokens:tokens.map(t=>addressOn(chain,t.id)),seen:now()});
          const at=Math.min(time,Date.parse(p.price_time)),price=Number(p.last_price_usd),ratio=Number(p.last_price);
          save(s,[[baseToken,price],[quote,price/ratio]].flatMap(([t,mark])=>
            indexedMarkets(s.v,chain,p.id,t.id,t.symbol,mark,mark,at,fx,p.dex_id,null)));
        }catch(e){s.status=e.message}
      }
    }
    await Promise.all([...native,registry&&start('watch-prices',refreshRegistry).catch(()=>{}),start('gecko',runGecko),start('screener',runScreener),start('paprika',runPaprika)]);
  }
  function snapshot(){
    const markets=[],sources=[];
    for(const s of tracked.values()){
      const rows=[...s.rows.values()].filter(m=>fresh(m.time,now()));
      markets.push(...rows);
      sources.push({id:'venue-dex-'+s.v.id,name:s.v.name,ok:rows.length>0,
        count:new Set(rows.map(r=>r.chain+':'+r.pool)).size,time:rows.reduce((n,m)=>Math.max(n,m.time),0),lastLive:s.lastLive,status:s.status});
    }
    return {markets,sources,watchPools:registry?.size()??0};
  }
  return {snapshot,refresh(){
    return run().catch(e=>{for(const s of tracked.values())s.status=e.message});
  }};
}

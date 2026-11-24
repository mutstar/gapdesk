const key='hypercore/trades/';
const cap=1000;
export function spotPairs(meta){
  const pairs=new Map(),tokens=new Map(meta.tokens.map(t=>[t.index,t]));
  for(const m of meta.universe){
    const [a,b]=m.tokens.map(i=>tokens.get(i));
    if(!a||!b||a.tokenId===b.tokenId||![a,b].every(t=>/^0x[\da-f]{32}$/i.test(t.tokenId)))continue;
    pairs.set(m.name,{chain:'hyperliquid',venue:'hyperliquid',pool:'spot/'+m.index,tokens:[a.tokenId,b.tokenId],symbols:[a.name,b.name]});
  }
  return pairs;
}
export function ingestSpotTrades(registry,pair,trades){
  let cursor=registry.cursor(key+pair.pool)??{at:0,ids:[]};
  let ids=new Set(cursor.ids),seq=ids.size;
  const ticks=[];
  for(const t of trades){
    if(!Number.isSafeInteger(t.time)||!Number.isSafeInteger(t.tid)||t.time<cursor.at||!(Number(t.sz)>0)||!(Number(t.px)>0&&Number.isFinite(Number(t.px))))continue;
    if(t.time!==cursor.at){cursor={at:t.time,ids:[]};ids=new Set();seq=0}
    if(ids.has(t.tid))continue;
    ids.add(t.tid);
    ticks.push({...pair,protocol:'spot trades',time:t.time,block:t.time,seq:seq++,hash:String(t.tid),rawRatio:Number(t.px),humanUnits:true});
  }
  if(ticks.length)registry.commit([{...pair,activity:cursor.at}],key+pair.pool,{at:cursor.at,ids:[...ids]},ticks);
}
export function createHypercoreTrades(registry,request=fetch,now=Date.now){
  let pairs=new Map(),socket=null,inFlight=false,retry=0,metaAt=0,lastMessage=0,lastPing=0;
  let sent=new Set(),ack=new Set(),error=null,disconnectedAt=null;
  function connect(){
    const ws=new WebSocket('wss://api.hyperliquid.xyz/ws');
    socket=ws;sent=new Set();ack=new Set();lastMessage=now();
    ws.onmessage=({data})=>{
      if(ws!==socket)return;
      lastMessage=now();
      try{
        const m=JSON.parse(data);
        if(m.channel==='subscriptionResponse'&&m.data?.method==='subscribe'&&m.data?.subscription?.type==='trades')ack.add(m.data.subscription.coin);
        if(m.channel==='error')throw Error('HyperCore subscription rejected');
        if(m.channel!=='trades'||!Array.isArray(m.data))return;
        const groups=new Map();
        for(const t of m.data)if(pairs.has(t.coin)){
          if(!groups.has(t.coin))groups.set(t.coin,[]);
          groups.get(t.coin).push(t);
        }
        for(const [coin,rows] of groups)ingestSpotTrades(registry,pairs.get(coin),rows.sort((a,b)=>a.time-b.time));
      }catch(e){error=e.message;ws.close()}
    };
    ws.onopen=()=>{error=null};
    ws.onerror=()=>{error='HyperCore WebSocket 연결 지연'};
    ws.onclose=()=>{if(socket===ws){socket=null;ack.clear();retry=now()+10000;disconnectedAt=now()}};
  }
  return {
    async refresh(){
      if(inFlight||now()<retry)return;
      inFlight=true;
      try{
        if(!metaAt||now()-metaAt>600000){
          const r=await request('https://api.hyperliquid.xyz/info',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'spotMeta'}),signal:AbortSignal.timeout(6000)});
          if(!r.ok)throw Error('HyperCore HTTP '+r.status);
          const next=spotPairs(await r.json());
          if(!next.size||next.size>cap)throw Error('HyperCore spot subscription capacity');
          if(socket&&[...pairs.keys()].some(c=>!next.has(c)))socket.close();
          pairs=next;metaAt=now();
        }
        if(!socket)connect();
        if(now()-lastMessage>60000){socket.close();return}
        if(socket.readyState!==WebSocket.OPEN)return;
        if(now()-lastPing>25000){socket.send(JSON.stringify({method:'ping'}));lastPing=now()}
        // Spread subscription acknowledgements over several clock ticks.
        for(const coin of [...pairs.keys()].filter(c=>!sent.has(c)).slice(0,64)){
          socket.send(JSON.stringify({method:'subscribe',subscription:{type:'trades',coin}}));sent.add(coin);
        }
      }catch(e){error=e.message;retry=now()+10000}finally{inFlight=false}
    },
    coverage:()=>({chain:'hyperliquid',venue:'hyperliquid',at:lastMessage,subscribed:ack.size,available:pairs.size,disconnectedAt,error}),
  };
}

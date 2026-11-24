// Committed per-block swap events, independent of token and pool discovery indexes.
const sources = [
  {chain:'osmosis', venue:'osmosis', network:'osmosis-1', urls:['https://rpc.osmosis.zone','https://osmosis-rpc.polkachu.com']},
  {chain:'neutron', venue:'duality', network:'neutron-1', urls:['https://neutron-rpc.polkachu.com','https://rpc.lavenderfive.com/neutron']},
  {chain:'starknet', venue:'ekubo', network:'0x534e5f4d41494e', urls:['https://starknet-rpc.publicnode.com','https://starknet.api.onfinality.io/public']},
];
const core = '0x5dd3d2f4429af886cd1a3b08289dbcea99a294197e9eb43b0e0325b4b';
const swapped = '0x157717768aca88da4ac4279765f09f4d0151823d573537fbbeb950cdbd9a870';
const heights = (first,last) => Array.from({length:last-first+1},(_,i)=>first+i);

async function rpc(request,url,calls) {
  const response = await request(url,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify(calls.map(([method,params],id)=>({jsonrpc:'2.0',id,method,params}))),
    signal:AbortSignal.timeout(8000)});
  if (!response.ok) throw Error('RPC HTTP '+response.status);
  const json=await response.json();
  const body=calls.length===1&&!Array.isArray(json)?[json]:json;
  if (!Array.isArray(body)||body.length!==calls.length) throw Error('Incomplete RPC batch');
  const results=new Map(body.map(row=>[row.id,row]));
  return calls.map((_,i)=>{
    const row=results.get(i);
    if (!row||row.error||row.result==null) throw Error(row?.error?.message??'Missing RPC result');
    return row.result;
  });
}

function osmosisFill(event,attrs) {
  if (event.type!=='token_swapped'||!/^\d+$/.test(attrs.pool_id)) return;
  const coins=[attrs.tokens_in,attrs.tokens_out].map(s=>/^(\d+)([a-zA-Z][a-zA-Z0-9/.:_-]*)$/.exec(s));
  if (!coins.every(Boolean)||coins[0][2]===coins[1][2]) return;
  coins.sort((a,b)=>a[2]<b[2]?-1:1);
  const tokens=coins.map(c=>c[2]);
  return {pool:attrs.pool_id,series:JSON.stringify(tokens),tokens,rawRatio:Number(coins[1][1])/Number(coins[0][1])};
}

function dualityFill(event,attrs) {
  if (event.type!=='TickUpdate'||attrs.module!=='dex'||attrs.TrancheKey!=null||!/^\d+$/.test(attrs.Fee)) return;
  const tokens=[attrs.TokenZero,attrs.TokenOne], maker=tokens.indexOf(attrs.TokenIn);
  if (maker<0||!tokens.every(Boolean)||tokens[0]===tokens[1]||!/^-?\d+$/.test(attrs.TickIndex)) return;
  // In the Neutron TickUpdate ABI TokenIn identifies the maker reserve (the taker's output).
  const input=Number(attrs.SwapAmountInDec??attrs.SwapAmountIn),output=Number(attrs.SwapAmountOutDec??attrs.SwapAmountOut);
  if (!(input>0&&output>0)) return;
  const center=(BigInt(attrs.TickIndex)-BigInt(attrs.Fee))*(maker===1?1n:-1n);
  return {pool:JSON.stringify([...tokens,attrs.Fee,String(center)]),tokens,rawRatio:maker===1?output/input:input/output};
}

function cosmosTicks(source,meta,result) {
  const height=Number(meta.header.height), time=Date.parse(meta.header.time), transactions=result.txs_results??[];
  if (meta.header.chain_id!==source.network||!meta.block_id?.hash||!Number.isSafeInteger(time)||
    Number(result.height)!==height||!Array.isArray(transactions)||transactions.length!==Number(meta.num_txs)) throw Error('Incomplete CometBFT block');
  const ticks=[];
  const decode=source.chain==='osmosis'?osmosisFill:dualityFill;
  function consume(events) {
    for (const event of events??[]) {
      if (event.type!=='token_swapped'&&event.type!=='TickUpdate') continue;
      const attrs=Object.fromEntries(event.attributes.map(a=>[a.key,a.value]));
      const fill=decode(event,attrs);
      if (!fill||!Number.isFinite(fill.rawRatio)||fill.rawRatio<=0) continue;
      ticks.push({...fill,chain:source.chain,venue:source.venue,protocol:source.chain,block:height,
        seq:ticks.length,time,hash:meta.block_id.hash});
    }
  }
  const final=result.finalize_block_events??[];
  const begin=event=>event.attributes?.some(a=>a.key==='mode'&&a.value==='BeginBlock');
  consume(result.begin_block_events);
  consume(final.filter(begin));
  for (const tx of transactions) {
    if (!Number.isInteger(tx?.code)) throw Error('Missing transaction execution status');
    if (tx.code===0) {
      if (!Array.isArray(tx.events)) throw Error('Missing transaction events');
      consume(tx.events);
    }
  }
  consume(final.filter(e=>!begin(e)));
  consume(result.end_block_events);
  return ticks;
}

async function cosmosPage(call,source,first,last) {
  const blocks=heights(first,last);
  const [directory,...results]=await call([
    ['blockchain',{minHeight:String(first),maxHeight:String(last)}],
    ...blocks.map(height=>['block_results',{height:String(height)}]),
  ]);
  const headers=new Map(directory.block_metas.map(meta=>[Number(meta.header.height),meta]));
  return blocks.flatMap((height,i)=>{
    const header=headers.get(height);
    if (!header) throw Error('Missing CometBFT block header');
    return cosmosTicks(source,header,results[i]);
  });
}

function ekuboTick(event,header,seq) {
  const words=event.data;
  if (event.from_address!==core||event.keys?.[0]!==swapped||words?.length!==21) throw Error('Unexpected Ekubo event ABI');
  const f=words.map(BigInt);
  if (f[1]<=0n||f[1]>=f[2]||f[13]>1n||f[15]>1n||f[16]>=1n<<128n||f[17]>=1n<<128n) throw Error('Invalid Ekubo event');
  if (!f[12]||!f[14]||f[13]===f[15]) return;
  // Starknet PoolKey = (token0, token1, fee, tick spacing, extension); sqrtRatioAfter is Q128.
  const key=f.slice(1,6).map(x=>'0x'+x.toString(16)), price=Number((f[17]<<128n)+f[16])/2**128;
  if (!(price>0)) throw Error('Invalid Ekubo pool price');
  return {chain:'starknet',venue:'ekubo',protocol:'starknet',pool:key.join('-'),tokens:key.slice(0,2),
    rawRatio:price**2,time:header.timestamp*1000,hash:header.block_hash,block:header.block_number,seq};
}

async function ekuboPage(call,first,last) {
  const filter={from_block:{block_number:first},to_block:{block_number:last},address:core,keys:[[swapped]],chunk_size:256};
  const events=[],pages=new Set();
  do {
    const [page]=await call([['starknet_getEvents',[filter]]]);
    if (!Array.isArray(page.events)) throw Error('Missing Starknet events');
    events.push(...page.events);
    if (!page.continuation_token) break;
    if (pages.has(page.continuation_token)||pages.size>=128) throw Error('Incomplete Starknet pagination');
    pages.add(page.continuation_token);
    filter.continuation_token=page.continuation_token;
  } while (true);
  const blocks=[...new Set(events.map(e=>e.block_number))];
  if (!blocks.length) return [];
  if (blocks.some(n=>!Number.isSafeInteger(n)||n<first||n>last)) throw Error('Starknet event outside requested range');
  const headers=await call(blocks.map(n=>['starknet_getBlockWithTxHashes',[{block_number:n}]]));
  const byHeight=new Map(headers.map(h=>[h.block_number,h]));
  let lastBlock=-1,seq=0,prevTx=-1,prevIndex=-1;
  const ticks=[];
  for (const e of events) {
    const h=byHeight.get(e.block_number);
    if (!h||!['ACCEPTED_ON_L1','ACCEPTED_ON_L2'].includes(h.status)||!Number.isSafeInteger(h.timestamp)||
      !e.block_hash||e.block_hash!==h.block_hash||e.block_number<lastBlock) throw Error('Starknet block changed during replay');
    const tx=e.transaction_index??h.transactions.indexOf(e.transaction_hash);
    if (tx<0||!e.transaction_hash||h.transactions[tx]!==e.transaction_hash) throw Error('Starknet transaction mismatch');
    if (e.block_number!==lastBlock) { lastBlock=e.block_number;seq=0;prevTx=-1;prevIndex=-1 }
    if (tx<prevTx||tx===prevTx&&e.event_index!=null&&e.event_index<=prevIndex) throw Error('Starknet events out of order');
    prevTx=tx;prevIndex=e.event_index??-1;
    const tick=ekuboTick(e,h,seq++);
    if (tick) ticks.push(tick);
  }
  return ticks;
}

export function createCosmosStarkStreams(registry,request=fetch,now=Date.now) {
  const states=new Map(),busy=new Set(),preferred=new Map();
  async function refreshSource(source) {
    const {chain,venue}=source, key='native-swaps-v1/'+chain;
    if (busy.has(chain)) return;
    busy.add(chain);
    let cursor=registry.cursor(key),head;
    try {
      const stark=chain==='starknet';
      let lastError;
      for (let attempt=0;attempt<source.urls.length;attempt++) {
        const idx=((preferred.get(chain)??0)+attempt)%source.urls.length;
        const call=calls=>rpc(request,source.urls[idx],calls);
        try {
          if (stark) {
            const [network,tip]=await call([['starknet_chainId',[]],['starknet_blockNumber',[]]]);
            if (network!==source.network) throw Error('Wrong Starknet network');
            head=tip-2;
          } else {
            const [status]=await call([['status',{}]]);
            if (status.node_info?.network!==source.network||status.sync_info?.catching_up!==false) throw Error('CometBFT node out of sync');
            head=Number(status.sync_info.latest_block_height);
          }
          if (!Number.isSafeInteger(head)||head<1||cursor&&head<cursor.height) throw Error('Invalid chain head');
          if (!cursor) {
            cursor={height:Math.max(0,head-8),observed:0,lastSwapAt:null};
            registry.commit([],key,cursor);
          }
          // A page and its detector windows are durable together. Every replay starts at the first uncommitted block.
          for (let i=0;i<8&&cursor.height<head;i++) {
            const first=cursor.height+1,last=Math.min(head,first+7);
            const ticks=stark?await ekuboPage(call,first,last):await cosmosPage(call,source,first,last);
            const pools=new Map(ticks.map(tick=>[tick.pool,{chain,venue,pool:tick.pool,tokens:tick.tokens,activity:tick.time}]));
            const next={height:last,observed:cursor.observed+ticks.length,lastSwapAt:ticks.at(-1)?.time??cursor.lastSwapAt};
            registry.commit([...pools.values()],key,next,ticks);
            cursor=next;
          }
          preferred.set(chain,idx);
          states.set(chain,{chain,venue,head,processed:cursor.height,at:now(),observed:cursor.observed,lastSwapAt:cursor.lastSwapAt});
          return;
        } catch(error) { lastError=error }
      }
      throw lastError;
    } catch(error) {
      states.set(chain,{...states.get(chain),chain,venue,head,processed:cursor?.height,observed:cursor?.observed??0,
        lastSwapAt:cursor?.lastSwapAt??null,error:error.message});
    } finally { busy.delete(chain) }
  }
  return {refresh:()=>Promise.all(sources.map(refreshSource)),coverage:()=>sources.map(({chain,venue})=>states.get(chain)??{chain,venue})};
}

import {consumeBlocks} from './pool-event-stream.mjs';

const archive='https://portal.sqd.dev/datasets/hydradx';
const node='https://rpc.hydradx.cloud';
const genesis='0xafdc188f45c71dacbaa0b62e16a91f726c7b8699a9748cdf715459de6b7f366d';
const key='archive-swaps-v1/hydration';
const families=['Omnipool','Stableswap','XYK','LBP'];
const tradeNames=families.flatMap(name=>[name+'.BuyExecuted',name+'.SellExecuted']);
const hash=value=>typeof value==='string'&&/^0x[0-9a-f]{64}$/i.test(value);
function post(body) {
  return {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)};
}
async function rpc(request,method,params) {
  const response=await request(node,post({jsonrpc:'2.0',id:1,method,params}));
  if (!response.ok) throw Error('Hydration RPC HTTP '+response.status);
  const json=await response.json();
  if (json.error||json.result==null) throw Error('Hydration finality RPC unavailable');
  return json.result;
}

function decode(blocks,previous) {
  const pools=new Map(),ticks=[];
  for (const {header,events=[]} of blocks) {
    if (header.number!==previous.height+1||!hash(header.hash)||!hash(header.parentHash)||
      previous.hash&&header.parentHash!==previous.hash||!Number.isSafeInteger(header.timestamp)||header.timestamp<=0) throw Error('Hydration archive block discontinuity');
    previous={height:header.number,hash:header.hash};
    const failed=new Set(events.filter(e=>e.name==='System.ExtrinsicFailed').map(e=>e.extrinsicIndex));
    let last=-1;
    for (const event of events) {
      if (!Number.isSafeInteger(event.index)||event.index<=last) throw Error('Unordered Hydration events');
      last=event.index;
      if (!tradeNames.includes(event.name)) continue;
      if (event.phase==='ApplyExtrinsic') {
        if (!Number.isSafeInteger(event.extrinsicIndex)) throw Error('Missing Hydration extrinsic index');
        if (failed.has(event.extrinsicIndex)) continue;
      }
      const [protocol,method]=event.name.split('.'), a=event.args;
      if (!Number.isSafeInteger(a?.assetIn)||!Number.isSafeInteger(a.assetOut)||a.assetIn===a.assetOut) throw Error('Unknown Hydration trade assets');
      const tokens=[a.assetIn,a.assetOut].sort((x,y)=>x-y).map(String);
      let pool=protocol.toLowerCase(),input=a.amountIn,output=a.amountOut;
      if (protocol==='Stableswap') {
        if (!Number.isSafeInteger(a.poolId)) throw Error('Missing stable pool ID');
        pool+='-'+a.poolId;
      }
      if (protocol==='XYK'||protocol==='LBP') {
        if (method==='BuyExecuted') { input=a.buyPrice;output=a.amount }
        else { input=a.amount;output=a.salePrice }
        // Both pallets derive the liquidity account deterministically from the asset pair.
        pool+='-'+tokens.join('-');
      }
      if (!/^\d+$/.test(input)||!/^\d+$/.test(output)) throw Error('Unknown Hydration trade amounts');
      if (!(Number(input)>0&&Number(output)>0)) continue;
      const ratio=Number(output)/Number(input),rawRatio=a.assetIn<a.assetOut?ratio:1/ratio;
      const row={chain:'hydration',venue:'hydration',pool,tokens,activity:header.timestamp};
      pools.set(pool,row);
      ticks.push({...row,protocol,series:tokens.join('-'),rawRatio,time:header.timestamp,block:header.number,hash:header.hash,seq:event.index});
    }
  }
  return {pools:[...pools.values()],ticks,hash:previous.hash};
}

// SQD classifies hydradx as a non-real-time archive. Compare it to independent
// finalized node headers and retain the chain timestamp on every delayed alert.
export function createHydrationArchive(registry,request=fetch,now=Date.now) {
  const base={chain:'hydration',venue:'hydration',mode:'archive'};
  let state={...base},busy=false;
  async function refresh() {
    if (busy) return;
    busy=true;
    let cursor=registry.cursor(key),head=state.head,archiveHead=state.archiveHead;
    try {
      const [final,network,response]=await Promise.all([rpc(request,'chain_getFinalizedHead',[]),
        rpc(request,'chain_getBlockHash',[0]),request(archive+'/finalized-head',{signal:AbortSignal.timeout(6000)})]);
      if (!hash(final)||network!==genesis||!response.ok) throw Error('Hydration heads unavailable');
      const [finalHeader,index]=await Promise.all([rpc(request,'chain_getHeader',[final]),response.json()]);
      head=Number(finalHeader.number); archiveHead=index.number;
      if (!hash(index.hash)||!Number.isSafeInteger(head)||head<1||!Number.isSafeInteger(archiveHead)||archiveHead<1||archiveHead>head) throw Error('Invalid Hydration head');
      if (!cursor) {
        cursor={height:Math.max(0,archiveHead-16),observed:0,lastSwapAt:null};
        registry.commit([],key,cursor);
      }
      if (cursor.height>archiveHead) throw Error('Hydration archive behind saved cursor');
      for (let i=0;i<4&&cursor.height<archiveHead;i++) {
        const first=cursor.height+1,last=Math.min(first+59,archiveHead);
        const stream=await request(archive+'/stream',post({type:'substrate',fromBlock:first,toBlock:last,includeAllBlocks:true,
          fields:{block:{number:true,hash:true,parentHash:true,timestamp:true},event:{name:true,args:true,index:true,phase:true,extrinsicIndex:true}},
          events:[{name:[...tradeNames,'System.ExtrinsicFailed']}]}));
        const page=await consumeBlocks(stream,first,last,blocks=>decode(blocks,cursor));
        const verified=await rpc(request,'chain_getBlockHash',[page.last]);
        if (!hash(verified)||verified!==page.hash) throw Error('Hydration archive hash mismatch');
        const next={height:page.last,hash:page.hash,observed:cursor.observed+page.ticks.length,lastSwapAt:page.ticks.at(-1)?.time??cursor.lastSwapAt};
        registry.commit(page.pools,key,next,page.ticks);
        cursor=next;
      }
      state={...base,head,archiveHead,processed:cursor.height,observed:cursor.observed,lastSwapAt:cursor.lastSwapAt,at:now()};
    } catch(error) {
      state={...state,...base,head,archiveHead,processed:cursor?.height,observed:cursor?.observed??0,lastSwapAt:cursor?.lastSwapAt??null,error:error.message};
    } finally { busy=false }
  }
  return {refresh,coverage:()=>[state]};
}

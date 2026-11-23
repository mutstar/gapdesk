import {CHAINS,NATIVE} from './assets.js';
import {depthFactory} from './pool-depth.mjs';
import {readPools} from './pool-reader.mjs';

const slugToChain={ethereum:1,bsc:56,base:8453,arbitrum:42161};
const hexAddress=/^0x[0-9a-f]{40}$/;
const multicall='0xca11bde05977b3631167028862be2a173976ca11';
const lower=v=>String(v||'').toLowerCase();
const poolKey=m=>m.chain+':'+m.pool;
const valid=a=>hexAddress.test(a)&&a!==NATIVE;
const word=n=>BigInt(n).toString(16).padStart(64,'0');
const addressWord=a=>a.slice(2).padStart(64,'0');
const sampleSize=8;

// Only the identity of a previously checked leg is retained. Fresh RPC results supply all prices.
export function depthRecheckEntries(market,fill) {
  const state=[market?.depth,...(market?.depthBridges||[])].filter(Boolean);
  const evidence=fill?.evidence??state.filter(d=>fill?.pools?.includes(d.pool));
  return evidence.map(d=>({chain:d.chain,pool:d.pool,base:d.token0,quote:d.token1,
    dexId:d.dexId,protocol:d.protocol,feePpm:d.feePpm}));
}

function indexedEntry(pair) {
  const chain=slugToChain[pair?.chainId],pool=lower(pair?.pairAddress);
  const base=lower(pair?.baseToken?.address),quote=lower(pair?.quoteToken?.address);
  const dex=lower(pair?.dexId);
  if(!chain||!valid(pool)||!valid(base)||!valid(quote)||base===quote||
     !/^(uniswap|pancakeswap)([-_]?v[23])?$/.test(dex))return null;
  return {chain,pool,base,quote};
}
function targetEntry(id) {
  const parts=String(id).split(':');
  if(parts.length!==4||parts[0]!=='dex')return null;
  const chain=Number(parts[1]),token=lower(parts[2]),pool=lower(parts[3]);
  return Object.hasOwn(CHAINS,chain)&&valid(token)&&valid(pool)?{chain,pool,token}:null;
}

// aggregate3 with allowFailure. Every requested field (address or uint24) has a single ABI word.
async function readWords(chain,calls,signal) {
  const offsets=[],tails=[];let offset=calls.length*32;
  for(const c of calls) {
    const bytes=c.data.length/2, padded=c.data.padEnd(Math.ceil(bytes/32)*64,'0');
    const tail=addressWord(c.to)+word(1)+word(96)+word(bytes)+padded;
    offsets.push(word(offset));tails.push(tail);offset+=tail.length/2;
  }
  const data='0x82ad56cb'+word(32)+word(calls.length)+offsets.join('')+tails.join('');
  const response=await fetch(CHAINS[chain].rpc,{method:'POST',headers:{'content-type':'application/json'},signal,
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{to:multicall,data},'latest']})});
  if(!response.ok)throw Error('Factory RPC HTTP '+response.status);
  const hex=(await response.json()).result;
  if(typeof hex!=='string'||!/^0x[0-9a-f]+$/i.test(hex))throw Error('Invalid factory response');
  const bytes=hex.slice(2);
  function num(at){
    const raw=bytes.slice(at,at+64);
    if(raw.length!==64)throw Error('Incomplete factory response');
    const value=Number(BigInt('0x'+raw));
    if(!Number.isSafeInteger(value))throw Error('Invalid factory response offset');
    return value;
  }
  const array=num(0)*2,start=array+64;
  if(num(array)!==calls.length)throw Error('Incomplete factory results');
  return calls.map((_,i)=>{
    const tuple=start+2*num(start+i*64);
    if(num(tuple)!==1)return null;
    const out=tuple+2*num(tuple+64);
    if(num(out)!==32)return null;
    const raw=bytes.slice(out+64,out+128);
    return raw.length===64?raw.toLowerCase():null;
  });
}

const asAddress=raw=>typeof raw==='string'&&/^0{24}[0-9a-f]{40}$/.test(raw)?'0x'+raw.slice(24):null;
async function resolveTargets(chain, entries, read, signal){
  const missing=entries.filter(c=>!c.base);
  if(!missing.length)return entries;
  const calls=missing.flatMap(e=>['0dfe1681','d21220a7','ddca3f43'].map(data=>({to:e.pool,data})));
  const results=await read(chain,calls,signal);
  for(const [i,e] of missing.entries()){
    const a=asAddress(results[i*3]),b=asAddress(results[i*3+1]);
    if(!valid(a)||!valid(b)||a===b||(a!==e.token&&b!==e.token))continue;
    e.base=e.token;e.quote=e.token===a?b:a;
    const fee=results[i*3+2];
    if(fee&&/^0{58}[0-9a-f]{6}$/.test(fee))e.feePpm=Number.parseInt(fee.slice(-6),16);
  }
  return entries.filter(e=>e.base&&e.quote);
}

// A label, a pool's self-reported factory, or a client-supplied hint cannot prove provenance.
// The canonical factory must return this address for the exact token pair and fee.
async function verifiedChain(chain,seeds,hints,read,signal){
  const entries=await resolveTargets(chain,seeds,read,signal);
  if(!entries.length)return [];
  const usdc=CHAINS[chain].usdc,plans=new Map();
  const anchors=new Set(), markets=new Map(entries.map(e=>[e.pool,e]));
  for(const e of entries)if(e.base!==usdc&&e.quote!==usdc){
    if(e.token)anchors.add(e.token===e.base?e.quote:e.base);
    else {anchors.add(e.base);anchors.add(e.quote);}
  }
  function addPair(a,b,extraFees=[]){
    const [base,quote]=[a,b].sort();
    for(const dexId of ['uniswap','pancakeswap']){
      const fees=dexId==='uniswap'?[100,500,3000,10000]:[100,500,2500,10000];
      for(const fee of [null,...new Set([...fees,...extraFees.filter(f=>Number.isInteger(f)&&f>=0&&f<1000000)])]){
        const protocol=fee==null?'v2':'v3',to=depthFactory(chain,dexId,protocol);
        if(!to)continue;
        const data=(fee==null?'e6a43905':'1698ee82')+addressWord(base)+addressWord(quote)+(fee==null?'':word(fee));
        plans.set(to+data,{to,data,base,quote,dexId,protocol});
      }
    }
  }
  for(const e of entries)addPair(e.base,e.quote,[e.feePpm]);
  for(const anchor of anchors){
    const hinted=hints.filter(h=>h.chain===chain&&[h.base,h.quote].includes(anchor)&&[h.base,h.quote].includes(usdc));
    addPair(anchor,usdc,hinted.map(h=>h.feePpm));
  }
  const calls=[...plans.values()];
  if(!calls.length)return [];
  const results=await read(chain,calls,signal),verified=new Map();
  calls.forEach((plan,i)=>{
    const pool=asAddress(results[i]);
    if(!valid(pool))return;
    const primary=markets.get(pool),isAnchor=[plan.base,plan.quote].includes(usdc)&&
      [plan.base,plan.quote].some(a=>anchors.has(a));
    if(!primary&&!isAnchor)return;
    const {dexId,protocol}=plan;
    // Preserve the PC reader's target-side market ID for non-anchor pairs.
    const base=primary?.token||primary?.base||plan.base;
    const quote=base===plan.base?plan.quote:plan.base;
    if(primary&&![plan.base,plan.quote].includes(base))return;
    verified.set(pool,{chain,pool,base,quote,dexId,protocol});
  });
  return entries.some(e=>verified.has(e.pool))?[...verified.values()]:[];
}

export async function readCloudDepth({pairs=[],assets,targets=[],savedEntries=[],cursor=0},io={}){
  const read=io.readWords||readWords, reader=io.readPools||readPools;
  const empty={markets:[],coverage:[],at:Date.now()};
  const indexed=new Map();
  for(const pair of pairs){const e=indexedEntry(pair);if(e)indexed.set(poolKey(e),e);}
  let selected;
  const hints=savedEntries.slice(0,8).filter(h=>h&&valid(h.pool)&&valid(h.base)&&valid(h.quote)&&h.base!==h.quote);
  if(targets.length){
    selected=targets.slice(0,2).map(targetEntry).filter(Boolean).map(t=>{
      const metadata=hints.find(h=>poolKey(h)===poolKey(t))||indexed.get(poolKey(t));
      return metadata&&[metadata.base,metadata.quote].includes(t.token)?{...metadata,...t}:t;
    });
  }else{
    const entries=[...indexed.values()].sort((a,b)=>poolKey(a).localeCompare(poolKey(b)));
    const start=Math.trunc(Math.max(0,Number(cursor)||0))%Math.max(1,entries.length);
    selected=Array.from({length:Math.min(sampleSize,entries.length)},(_,i)=>entries[(start+i)%entries.length]);
  }
  if(!selected.length)return empty;
  const byChain=new Map();
  for(const e of selected){
    if(!byChain.has(e.chain))byChain.set(e.chain,[]);
    byChain.get(e.chain).push(e);
  }
  const signal=AbortSignal.timeout(6500);
  const verified=(await Promise.all([...byChain].map(async([chain,entries])=>{
    try{return await verifiedChain(chain,entries,hints,read,signal)}catch{return []}
  }))).flat();
  if(!verified.length||signal.aborted)return empty;
  return reader(verified,assets,{signal,timeoutMs:6500,intervalMs:0,concurrency:1,batchSize:128,anchorMaxAgeMs:45000});
}

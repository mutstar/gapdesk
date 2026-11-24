const nearBase='https://mainnet.neardata.xyz/v0';
const stonBase='https://api.ston.fi/export/dexscreener/v1';
const amm='v2.ref-finance.near', dcl='dclv2.ref-labs.near';
const venues={near:{venue:'rhea-finance',chain:'near',source:'chain-events'},ton:{venue:'stonfi',chain:'ton',source:'venue-export'}};
const account=/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const swapLog=/^Swapped (\d+) ([a-z0-9._-]+) for (\d+) ([a-z0-9._-]+)(?:,.*)?$/;

function integer(value) {
  if (!Number.isSafeInteger(value) || value<0) throw Error('Invalid block or event position');
  return value;
}
function receiptActions(receipt) {
  const calls=receipt?.receipt?.Action?.actions;
  if (!Array.isArray(calls)) return [];
  const actions=[];
  for (const action of calls) {
    const call=action.FunctionCall;
    if (!call || !['swap','ft_on_transfer'].includes(call.method_name)) continue;
    try {
      const args=JSON.parse(Buffer.from(call.args,'base64').toString('utf8'));
      const spec=call.method_name==='ft_on_transfer'?JSON.parse(args.msg):args;
      if (Array.isArray(spec?.actions)) actions.push(...spec.actions);
    } catch { return []; }
  }
  return actions;
}
function ammSwaps(receipt,logs) {
  const lines=logs.filter(l=>l.startsWith('Swapped '));
  if (!lines.length) return [];
  const actions=receiptActions(receipt);
  // Logs have no pool ID. All executed legs must match the receipt arguments in order.
  if (actions.length!==lines.length) return [];
  const rows=[];
  for (const [i,line] of lines.entries()) {
    const m=swapLog.exec(line), act=actions[i];
    if (!m || !Number.isSafeInteger(act?.pool_id) || act.pool_id<0 || act.token_in!==m[2] || act.token_out!==m[4]) return [];
    rows.push({pool_id:String(act.pool_id),token_in:m[2],token_out:m[4],amount_in:m[1],amount_out:m[3]});
  }
  return rows;
}
function dclSwaps(logs) {
  const rows=[];
  for (const log of logs) {
    if (!log.startsWith('EVENT_JSON:')) continue;
    const event=JSON.parse(log.slice(11));
    if (event.standard==='dcl.ref' && event.event==='swap') {
      if (!Array.isArray(event.data)) throw Error('Invalid Rhea DCL swap log');
      rows.push(...event.data);
    }
  }
  return rows;
}
function nearTrades(doc,block) {
  const header=doc?.block?.header;
  if (integer(header?.height)!==block || !Array.isArray(doc.shards) || !header.hash) throw Error('Invalid finalized NEAR block');
  const time=integer(Number(BigInt(header.timestamp_nanosec)/1000000n));
  const ticks=[];
  let unpriced=0;
  for (const shard of doc.shards) {
    if (!Array.isArray(shard.receipt_execution_outcomes)) throw Error('Missing NEAR receipt outcomes');
    for (const {execution_outcome:execution,receipt} of shard.receipt_execution_outcomes) {
      const result=execution?.outcome, contract=result?.executor_id;
      if (![dcl,amm].includes(contract) || !result?.status || !('SuccessValue' in result.status || 'SuccessReceiptId' in result.status)) continue;
      if (!Array.isArray(result.logs)) throw Error('Missing NEAR contract logs');
      const rows=contract===dcl?dclSwaps(result.logs):ammSwaps(receipt,result.logs);
      if (contract===amm && !rows.length) unpriced+=result.logs.filter(l=>l.startsWith('Swapped ')).length;
      for (const r of rows) {
        if (![r.token_in,r.token_out].every(id=>typeof id==='string' && account.test(id)) ||
            r.token_in===r.token_out || !r.pool_id) throw Error('Invalid Rhea pool identity');
        const tokens=[r.token_in,r.token_out].sort();
        if (contract===dcl) {
          const parts=r.pool_id.split('|');
          if (parts.length!==3 || !/^\d+$/.test(parts[2]) || !tokens.every(t=>parts.slice(0,2).includes(t))) throw Error('Rhea pool token mismatch');
        }
        const input=Number(r.amount_in),out=Number(r.amount_out);
        if (!input && !out) continue; // Zero-fill DCL limit order attempts are not price samples.
        if (!(input>0 && out>0)) {unpriced++;continue;}
        const rawRatio=tokens[0]===r.token_in?out/input:input/out;
        ticks.push({chain:'near',venue:'rhea-finance',protocol:contract===dcl?'dcl':'amm',pool:r.pool_id,
          time,block,seq:ticks.length,hash:execution.id,tokens,series:tokens.join('/'),rawRatio});
      }
    }
  }
  return {ticks,unpriced};
}
function stonTrades(rows,from,to) {
  if (!Array.isArray(rows)) throw Error('Missing STON.fi event list');
  const ticks=[], seen=new Set();
  const swaps=rows.filter(row=>row.eventType==='swap');
  swaps.sort((a,b)=>a.block.blockNumber-b.block.blockNumber || a.txnIndex-b.txnIndex || a.eventIndex-b.eventIndex);
  for (const row of swaps) {
    const block=integer(row.block?.blockNumber), time=integer(row.block?.blockTimestamp)*1000;
    const hash=row.txnId+'/'+integer(row.eventIndex);
    if (block<from || block>to || !/^[0-9a-f]{64}$/i.test(row.txnId) || !/^(EQ|UQ)[\w-]{46}$/.test(row.pairId)) throw Error('Invalid STON.fi swap identity');
    integer(row.txnIndex);
    if (seen.has(hash)) continue;
    seen.add(hash);
    const ratio=Number(row.amount1Out)/Number(row.amount0In) || Number(row.amount1In)/Number(row.amount0Out);
    if (!(ratio>0) || !Number.isFinite(ratio)) throw Error('Invalid STON.fi swap amounts');
    ticks.push({chain:'ton',venue:'stonfi',protocol:'event-api',pool:row.pairId,time,block,seq:ticks.length,
      hash,rawRatio:ratio,axis:'B/A',humanUnits:true});
  }
  return ticks;
}
function save(registry,key,checkpoint,ticks) {
  const pools=new Map();
  // Classic stable pools can contain more than two tokens. The individual ticks carry each traded pair.
  for (const t of ticks) pools.set(t.pool,{chain:t.chain,venue:t.venue,pool:t.pool,activity:t.time,
    tokens:t.protocol==='amm'?undefined:t.tokens});
  registry.commit([...pools.values()],key,checkpoint,ticks);
}

export function createVenueExportStream(registry,request=fetch,now=Date.now) {
  const states=new Map(Object.entries(venues)), tasks=new Map(), retry=new Map();
  async function read(url) {
    const r=await request(url,{signal:AbortSignal.timeout(9000)});
    if (!r.ok) {
      const error=Error('HTTP '+r.status);
      if (r.status===429) error.wait=Math.max(15000,(Number(r.headers?.get('retry-after'))||30)*1000);
      throw error;
    }
    return r.json();
  }
  function status(chain,patch) { states.set(chain,{...states.get(chain),...patch,at:now()}); }
  async function near() {
    const key='receipt-stream/near', latest=await read(nearBase+'/last_block/final');
    const head=integer(latest?.block?.header?.height);
    let saved=registry.cursor(key);
    let next=saved?saved.height+1:head;
    let unpriced=states.get('near').unpriced??0;
    status('near',{head,processed:saved?.height??null});
    const end=Math.min(head,next+31);
    while (next<=end) {
      const heights=Array.from({length:Math.min(3,end-next+1)},(_,i)=>next+i);
      const blocks=await Promise.all(heights.map(h=>h===head?latest:read(nearBase+'/block/'+h)));
      for (const [i,doc] of blocks.entries()) {
        if (doc===null) continue; // Validate skipped heights against the next finalized block's parent.
        const header=doc?.block?.header;
        if (saved && (header?.prev_height!==saved.height || header.prev_hash!==saved.hash)) throw Error('NEAR block ancestry gap');
        const {ticks,unpriced:skipped}=nearTrades(doc,heights[i]);
        saved={height:header.height,hash:header.hash};
        save(registry,key,saved,ticks);
        unpriced+=skipped;
        status('near',{processed:saved.height,unpriced});
      }
      next=heights.at(-1)+1;
    }
    if (head>saved?.height && saved.height+32<=end) throw Error('Missing NEAR finalized blocks');
  }
  async function ton() {
    const key='venue-export/stonfi', tip=await read(stonBase+'/latest-block');
    const head=integer(tip?.block?.blockNumber);
    let done=registry.cursor(key)??Math.max(0,head-100);
    status('ton',{head,processed:done});
    for (let n=0;n<6 && done<head;n++) {
      const end=Math.min(head,done+200);
      const data=await read(stonBase+'/events?fromBlock='+(done+1)+'&toBlock='+end);
      const ticks=stonTrades(data.events,done+1,end);
      save(registry,key,end,ticks);
      done=end;
      status('ton',{processed:done});
    }
  }
  function run(chain,work) {
    if (tasks.has(chain)) return tasks.get(chain);
    if (now()<(retry.get(chain)??0)) return;
    const task=work().then(()=>status(chain,{error:null})).catch(e=>{
      retry.set(chain,now()+(e.wait||4000));
      status(chain,{error:e.message});
    }).finally(()=>tasks.delete(chain));
    tasks.set(chain,task);
    return task;
  }
  return {refresh:()=>Promise.all([run('near',near),run('ton',ton)]),coverage:()=>[...states.values()].map(r=>({...r}))};
}

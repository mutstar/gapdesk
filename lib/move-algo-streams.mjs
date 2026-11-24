// Cursors and their decoded prices are committed in the same registry transaction.
const cetus = '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::pool::SwapEvent';
const momentum = '0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860::trade::SwapEvent';
const hyperion = '0x8b4a2c4bb53857c718a04c020b98f8c2e1f99a68b0f57389a8bf5434cd22e05c::pool_v3::';
const suiEvents = `query($lo:UInt53!,$end:UInt53!,$type:String!,$after:String){
  events(first:50,after:$after,filter:{afterCheckpoint:$lo,beforeCheckpoint:$end,type:$type}){
    pageInfo{hasNextPage endCursor}
    nodes{sequenceNumber timestamp transaction{digest effects{checkpoint{sequenceNumber}}} contents{json type{repr}}}
  }}`;
const moveId = /^0x[0-9a-f]{1,64}$/;
const algoId = /^[A-Z2-7]{58}$/;
const suiGenesis='4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S';
const algoGenesis='wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=';
const swap = Buffer.from('swap').toString('base64');
const flashSettle = Buffer.from('verify_flash_swap').toString('base64');

function height(value) {
  const n = Number(value);
  if (value == null || !Number.isSafeInteger(n) || n < 0) throw Error('Invalid chain position');
  return n;
}
function sqrtRatio(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw Error('Invalid on-chain sqrt price');
  return (n / 2 ** 64) ** 2;
}
function filled(a,b) {
  if (![a,b].every(value=>typeof value==='string' && /^\d+$/.test(value))) throw Error('Invalid swap quantities');
  return BigInt(a)>0n && BigInt(b)>0n;
}
function observations() {
  const rows = new Map(), ticks = [];
  return {
    add(tick) {
      rows.set(tick.pool, {chain:tick.chain, venue:tick.venue, pool:tick.pool, activity:tick.time});
      ticks.push(tick);
    },
    save(registry,key,cursor) { registry.commit([...rows.values()],key,cursor,ticks,'canonical'); },
  };
}

function suiPage(nodes, venue, type, state, batch) {
  for (const event of nodes) {
    const block = height(event.transaction?.effects?.checkpoint?.sequenceNumber);
    const time = Date.parse(event.timestamp), digest = event.transaction?.digest;
    const data = event.contents?.json, isCetus = venue === 'cetus';
    const pool = isCetus ? data?.pool : data?.pool_id;
    if (event.contents?.type?.repr !== type || !moveId.test(pool) || !digest ||
        !Number.isSafeInteger(time) || block <= state.done || block > state.until || block < state.block) {
      throw Error('Invalid Sui swap page');
    }
    if (block !== state.block) state.seq = 0;
    state.block = block;
    const identity = digest + ':' + height(event.sequenceNumber);
    if (!filled(isCetus?data.amount_in:data.amount_x,isCetus?data.amount_out:data.amount_y)) continue;
    const base = {chain:'sui', protocol:'clmm', venue, pool, time, block, hash:identity, axis:'B/A'};
    // Both sides of this swap are known even when the pool was idle for over a minute.
    const before = isCetus ? data.before_sqrt_price : data.sqrt_price_before;
    const after = isCetus ? data.after_sqrt_price : data.sqrt_price_after;
    batch.add({...base, seq:state.seq++, rawRatio:sqrtRatio(before), seed:true});
    batch.add({...base, seq:state.seq++, rawRatio:sqrtRatio(after)});
  }
}

function tinymanBlock(response, round, batch) {
  const block = response?.block;
  if (height(block?.rnd) !== round || block.gen!=='mainnet-v1.0' || block.gh!==algoGenesis ||
      !Array.isArray(block.txns ?? [])) throw Error('Invalid Algorand mainnet block');
  const time = height(block.ts) * 1000;
  let seq = 0, unpriced = 0;
  function visit(st, path) {
    const t = st.txn, delta = st.dt;
    if (!t) throw Error('Missing Algorand transaction');
    if (t.apid === 1002541853 && [swap,flashSettle].includes(t.apaa?.[0])) {
      const pool = t.apat?.[0], state = delta?.ld?.['1'];
      if (!algoId.test(pool)) throw Error('Invalid Tinyman pool address');
      const a = state?.asset_1_reserves?.ui, b = state?.asset_2_reserves?.ui;
      // Algod JSON logs may be lossy UTF-8. Only numeric post-swap reserve deltas price this sample.
      if (a > 0 && b > 0) {
        batch.add({chain:'algorand', venue:'tinyman', protocol:'v2', pool, time, block:round,
          seq:seq++, hash:round+'/'+path, axis:'B/A', rawRatio:b/a});
      } else unpriced++;
    }
    for (const [i, child] of (delta?.itx ?? []).entries()) visit(child, path+'.'+i);
  }
  for (const [i, st] of (block.txns ?? []).entries()) visit(st, String(i));
  return unpriced;
}

function hyperionPage(txs, first, batch) {
  if (!Array.isArray(txs) || !txs.length) throw Error('Empty Aptos transaction range');
  let next = first;
  for (const tx of txs) {
    const block = height(tx.version);
    if (block !== next++) throw Error('Noncontiguous Aptos transaction range');
    if (tx.type !== 'user_transaction' || !tx.success) continue;
    if (!Array.isArray(tx.events)) throw Error('Missing Aptos transaction events');
    const before = new Map();
    for (const [i,event] of tx.events.entries()) {
      if (event.type !== hyperion+'SwapBeforeEvent' && event.type !== hyperion+'SwapEventV3') continue;
      const pool = event.data?.pool_id;
      if (!moveId.test(pool)) throw Error('Invalid Hyperion pool ID');
      const rawRatio = sqrtRatio(event.data.sqrt_price);
      if (event.type === hyperion+'SwapBeforeEvent') {
        before.set(pool,rawRatio);
        continue;
      }
      if (!filled(event.data.amount_in,event.data.amount_out)) {
        before.delete(pool);
        continue;
      }
      const base = {chain:'aptos', venue:'hyperion', protocol:'v3-clmm', pool, time:Math.floor(height(tx.timestamp)/1000),
        block, hash:tx.hash, axis:'B/A'};
      if (before.has(pool)) batch.add({...base, seq:2*i, rawRatio:before.get(pool), seed:true});
      before.delete(pool);
      batch.add({...base, seq:2*i+1, rawRatio});
    }
  }
  return next-1;
}

export function createMoveAlgoStreams(registry, request=fetch, now=Date.now) {
  const sui = process.env.SUI_GRAPHQL_URL || 'https://graphql.mainnet.sui.io/graphql';
  const algo = (process.env.ALGORAND_ALGOD_URL || 'https://mainnet-api.4160.nodely.dev').replace(/\/$/,'');
  const apt = (process.env.APTOS_REST_URL || 'https://api.mainnet.aptoslabs.com/v1').replace(/\/$/,'');
  const aptosHosts=process.env.APTOS_REST_URL ? [apt] : [apt,'https://api.zan.top/aptos-mainnet/v1'];
  let aptosHost=0;
  const status = new Map(), tasks = new Map(), retryAfter = new Map();
  const keys = {cetus:'sui',momentum:'sui',tinyman:'algorand',hyperion:'aptos'};
  for (const [venue,chain] of Object.entries(keys)) status.set(venue,{venue,chain});
  async function json(url, options) {
    const r = await request(url, {signal:AbortSignal.timeout(9000),...options});
    if (!r.ok) {
      const error = Error('HTTP '+r.status);
      error.status=r.status;
      if (r.status === 429) error.backoff = Math.max(15000, 1000*(Number(r.headers?.get('retry-after')) || 30));
      throw error;
    }
    return r.json();
  }
  async function graphql(query,variables) {
    const result = await json(sui, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query,variables})});
    if (result.errors?.length) throw Error(String(result.errors[0].message).slice(0,220));
    if (!result.data) throw Error('Missing Sui GraphQL data');
    return result.data;
  }
  function report(venue,patch) {
    status.set(venue, {...status.get(venue), ...patch, at:now()});
  }
  async function scanSui(venue,type,getTip) {
    const key = 'move-algo/'+venue, tip=await getTip();
    if (tip.chainIdentifier!==suiGenesis) throw Error('Invalid Sui mainnet identity');
    const head=height(tip.checkpoint.sequenceNumber);
    let saved = registry.cursor(key) ?? {done:Math.max(0,head-48)};
    report(venue,{head,processed:saved.done});
    for (let page=0; page<10 && saved.done<head; page++) {
      const state = {...saved, until:saved.until ?? Math.min(head,saved.done+180),
        block:saved.block ?? saved.done, seq:saved.seq ?? 0};
      let result;
      try {
        result = await graphql(suiEvents,{lo:state.done,end:state.until+1,type,after:state.after ?? null});
      } catch (e) {
        // Replay the bounded range when a provider has expired an opaque cursor.
        if (state.after && /invalid.*cursor|cursor.*(?:invalid|expired)/i.test(e.message)) registry.commit([],key,{done:state.done});
        throw e;
      }
      const events = result.events, info = events?.pageInfo;
      if (!Array.isArray(events?.nodes) || typeof info?.hasNextPage !== 'boolean') throw Error('Incomplete Sui event page');
      if (info.hasNextPage && (!info.endCursor || info.endCursor===state.after || !events.nodes.length)) throw Error('Nonadvancing Sui cursor');
      const batch = observations();
      suiPage(events.nodes,venue,type,state,batch);
      saved = info.hasNextPage ? {...state,after:info.endCursor} : {done:state.until};
      batch.save(registry,key,saved);
      report(venue,{processed:saved.done});
    }
  }
  async function scanAlgo() {
    const key='move-algo/tinyman', head=height((await json(algo+'/v2/status'))['last-round']);
    let done=registry.cursor(key) ?? Math.max(0,head-8), unpriced=status.get('tinyman').unpriced ?? 0;
    report('tinyman',{head,processed:done});
    for (let i=0; i<24 && done<head; i++) {
      const round=done+1, batch=observations();
      const skipped=tinymanBlock(await json(algo+'/v2/blocks/'+round+'?format=json'),round,batch);
      batch.save(registry,key,round);
      done=round;
      unpriced+=skipped;
      report('tinyman',{processed:done,unpriced});
    }
  }
  async function scanAptos() {
    const endpoint=aptosHosts[aptosHost];
    try { await scanAptosAt(endpoint); }
    catch(e) {
      if (e.name==='TimeoutError' || e.name==='TypeError' || e.status===429 || e.status>=500) {
        aptosHost=(aptosHost+1)%aptosHosts.length;
      }
      throw e;
    }
  }
  async function scanAptosAt(endpoint) {
    const key='move-algo/hyperion', ledger=await json(endpoint);
    if (ledger.chain_id!==1) throw Error('Aptos endpoint is not mainnet');
    const head=height(ledger.ledger_version);
    let done=registry.cursor(key) ?? Math.max(0,head-100);
    report('hyperion',{head,processed:done});
    if (done+1<height(ledger.oldest_ledger_version)) throw Error('Aptos cursor predates available ledger history');
    // Limit peak memory and allow other readers to progress while catching up.
    for (let wave=0; wave<16 && done<head; wave++) {
      const starts=[done+1];
      if (done+51<=head) starts.push(done+51);
      const pages=await Promise.allSettled(starts.map(from=>{
        const limit=Math.min(50,head-from+1);
        return json(endpoint+'/transactions?start='+from+'&limit='+limit);
      }));
      for (const [i,page] of pages.entries()) {
        if (page.status==='rejected') throw page.reason;
        const limit=Math.min(50,head-starts[i]+1), txs=page.value;
        if (!Array.isArray(txs) || txs.length>limit) throw Error('Unexpected Aptos range size');
        const batch=observations(), next=hyperionPage(txs,done+1,batch);
        batch.save(registry,key,next);
        done=next;
        report('hyperion',{processed:done});
        if(txs.length<limit) break; // The node may cap a page by byte size.
      }
    }
  }
  function run(venue,work) {
    if (tasks.has(venue)) return tasks.get(venue);
    if (now()<(retryAfter.get(venue) ?? 0)) return;
    const task=work().then(()=>report(venue,{error:null})).catch(e=>{
      retryAfter.set(venue,now()+(e.backoff || 4000));
      report(venue,{error:e.message});
    }).finally(()=>tasks.delete(venue));
    tasks.set(venue,task);
    return task;
  }
  return {
    refresh() {
      let tip;
      const getTip=()=>tip ??= graphql('{chainIdentifier checkpoint{sequenceNumber}}');
      return Promise.all([run('cetus',()=>scanSui('cetus',cetus,getTip)),
        run('momentum',()=>scanSui('momentum',momentum,getTip)),run('tinyman',scanAlgo),run('hyperion',scanAptos)]);
    },
    coverage:()=>[...status.values()].map(row=>({...row})),
  };
}

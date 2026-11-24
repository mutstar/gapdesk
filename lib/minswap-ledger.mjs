// Minswap's V2 pool validator applies whole batches atomically. Emit a pool
// price only when its single authentic order was an exact-in or exact-out swap.
const api='https://api.koios.rest/api/v1/';
const poolScript='ea07b733d932129c378af627436e7cbc2ef0bf96e0036bb51b3bde6b';
const orderScript='c3e28c36c3447315ba5a56f33da6a6ddc1770a876a8d9f0cb3a97c4c';
const batchingScript='1eae96baf29e27682ea3f815aba361a0c6059d45e4bfbe95bbd2f44a';
const policy='f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c';
const key='native-swaps-v1/cardano-minswap';
const blockHash=s=>typeof s==='string'&&/^[0-9a-f]{64}$/.test(s);
const atScript=(rows,cred)=>rows.filter(o=>o.payment_addr?.cred===cred);
const fields=o=>o.inline_datum?.value?.fields;
const isAmount=s=>typeof s==='string'&&/^\d+$/.test(s);

function asset(datum) {
  const [policyId,name]=datum?.fields?.map(x=>x.bytes)??[];
  if (policyId===''&&name==='') return 'lovelace';
  if (/^[0-9a-f]{56}$/.test(policyId)&&typeof name==='string'&&/^(?:[a-f0-9]{2}){0,32}$/.test(name)) return policyId+'.'+name;
}
function authenticated(row,lpName) {
  return row.asset_list?.some(a=>a.policy_id===policy&&a.asset_name==='4d5350'&&a.quantity==='1')
    &&row.asset_list.some(a=>a.policy_id===policy&&a.asset_name===lpName&&BigInt(a.quantity)>0n);
}
function fill(tx) {
  if (!Array.isArray(tx.inputs)||!Array.isArray(tx.outputs)) throw Error('Incomplete Minswap UTxO response');
  const ins=atScript(tx.inputs,poolScript),outs=atScript(tx.outputs,poolScript),orders=atScript(tx.inputs,orderScript);
  if (ins.length!==1||outs.length!==1||orders.length!==1) return;
  const contracts=tx.plutus_contracts;
  if (!Array.isArray(contracts)) throw Error('Missing Cardano script results');
  if (contracts.some(c=>c.valid_contract!==true)) return;
  for (const [cred,utxo] of [[poolScript,ins[0]],[orderScript,orders[0]]]) {
    const spend=contracts.find(c=>c.script_hash===cred&&c.spends_input?.tx_hash===utxo.tx_hash&&c.spends_input.tx_index===utxo.tx_index);
    if (spend?.input?.redeemer?.datum?.value?.constructor!==0) return;
  }
  if (!contracts.some(c=>c.script_hash===batchingScript&&c.input?.redeemer?.datum?.value?.constructor===0)) return;
  const order=fields(orders[0]),before=fields(ins[0]),after=fields(outs[0]);
  if (![0,3].includes(order?.[6]?.constructor)||before?.length!==10||after?.length!==10) return;
  const lpName=order[5]?.fields?.[1]?.bytes;
  if (order[5]?.fields?.[0]?.bytes!==policy||!blockHash(lpName)||![ins[0],outs[0]].every(r=>authenticated(r,lpName))) return;
  const tokens=[asset(before[1]),asset(before[2])];
  if (!tokens.every(Boolean)||tokens[0]===tokens[1]||tokens[0]!==asset(after[1])||tokens[1]!==asset(after[2])) return;
  if (![...before.slice(3,6),...after.slice(3,6)].every(f=>isAmount(f.int))||before[3].int!==after[3].int) return;
  const [a,b]=[4,5].map(i=>BigInt(after[i].int)-BigInt(before[i].int));
  if (a*b>=0n) return;
  const tokensInPool=[BigInt(after[4].int),BigInt(after[5].int)];
  if (tokensInPool.some(x=>x<=0n)) return;
  return {chain:'cardano',venue:'minswap',protocol:'V2',pool:policy+'.'+lpName,tokens,
    rawRatio:Number(tokensInPool[1])/Number(tokensInPool[0]),block:tx.block_height,seq:tx.tx_block_index,
    hash:tx.block_hash,time:tx.tx_timestamp*1000};
}

async function query(request,path,params,payload) {
  const options={signal:AbortSignal.timeout(15000)};
  if (payload) Object.assign(options,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  const response=await request(api+path+'?'+new URLSearchParams(params),options);
  if (!response.ok) throw Error('Cardano Koios HTTP '+response.status);
  // Plutus Int is unbounded. Keep its exact source digits before JS number rounding.
  const data=JSON.parse(await response.text(),(name,value,ctx)=>name==='int'&&typeof value==='number'?ctx.source:value);
  if (!Array.isArray(data)) throw Error('Unexpected Cardano response');
  return data;
}

export function createMinswapLedger(registry,request=fetch,now=Date.now) {
  const base={chain:'cardano',venue:'minswap',scope:'V2 단일 주문 exact-in/out'};
  let busy=false,status={...base};
  async function refresh() {
    if (busy) return;
    busy=true;
    let cursor=registry.cursor(key),head=status.head;
    try {
      const [tip]=await query(request,'tip',[]);
      head=tip?.block_height;
      if (!Number.isSafeInteger(head)||!blockHash(tip.hash)||head<3) throw Error('Invalid Cardano tip');
      const safe=head-2;
      if (!cursor) {
        cursor={height:Math.max(0,safe-8),observed:0,lastSwapAt:null};
        registry.commit([],key,cursor);
      }
      if (safe<cursor.height) throw Error('Cardano peer behind cursor');
      for (let i=0;i<2&&cursor.height<safe;i++) {
        const first=cursor.height+1,last=Math.min(first+7,safe);
        const range=[['block_height','gte.'+first],['block_height','lte.'+last]];
        const headers=await query(request,'blocks',[...range,['order','block_height.asc']]);
        if (headers.length!==last-first+1) throw Error('Incomplete Cardano block range');
        for (const [n,h] of headers.entries()) {
          const parent=n?headers[n-1].hash:cursor.hash;
          if (h.block_height!==first+n||!blockHash(h.hash)||parent&&h.parent_hash!==parent) throw Error('Cardano block changed during replay');
        }
        const candidates=new Map();
        for (let offset=0;;offset+=100) {
          const list=await query(request,'credential_txs',[...range,['order','block_height.asc,tx_hash.asc'],['offset',offset],['limit',100]],
            {_payment_credentials:[poolScript],_after_block_height:first-1});
          for (const tx of list) {
            if (!blockHash(tx.tx_hash)||tx.block_height<first||tx.block_height>last||candidates.has(tx.tx_hash)) throw Error('Invalid Cardano transaction page');
            candidates.set(tx.tx_hash,tx.block_height);
          }
          if (list.length<100) break;
        }
        const ids=[...candidates.keys()],ticks=[];
        for (let k=0;k<ids.length;k+=4) {
          const wanted=new Set(ids.slice(k,k+4));
          const details=await query(request,'tx_info',[],{_tx_hashes:[...wanted],_inputs:true,_assets:true,_scripts:true});
          for (const tx of details) {
            const h=headers[tx.block_height-first];
            if (!wanted.delete(tx.tx_hash)||candidates.get(tx.tx_hash)!==tx.block_height||h?.hash!==tx.block_hash||
              h.block_time!==tx.tx_timestamp||!Number.isSafeInteger(tx.tx_block_index)) throw Error('Unverified Cardano transaction');
            const tick=fill(tx);
            if (tick) ticks.push(tick);
          }
          if (wanted.size) throw Error('Missing Cardano transaction');
        }
        ticks.sort((a,b)=>a.block-b.block||a.seq-b.seq);
        const pools=ticks.map(t=>({chain:t.chain,pool:t.pool,venue:t.venue,tokens:t.tokens,activity:t.time}));
        const next={height:last,hash:headers.at(-1).hash,observed:cursor.observed+ticks.length,lastSwapAt:ticks.at(-1)?.time??cursor.lastSwapAt};
        registry.commit(pools,key,next,ticks);
        cursor=next;
      }
      status={...base,head,processed:cursor.height,observed:cursor.observed,lastSwapAt:cursor.lastSwapAt,at:now()};
    } catch(error) {
      status={...status,...base,head,processed:cursor?.height,observed:cursor?.observed??0,lastSwapAt:cursor?.lastSwapAt??null,error:error.message};
    } finally {busy=false}
  }
  return {refresh,coverage:()=>[status]};
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {createMoveAlgoStreams} from '../lib/move-algo-streams.mjs';
import {openWatchRegistry} from '../lib/watch-registry.mjs';

const time='2026-11-24T03:20:00Z', q64=2n**64n;
const pool='0x925660b8618394809f89f8002e2926600c775221f43bf1919782b297a79400d8';
const algoPool='EGXXS23IL5H34OOVBIAU4OU73GF3U425SLVQ6A66DABPU2JG4MH7WGV374';
const hyperion='0x8b4a2c4bb53857c718a04c020b98f8c2e1f99a68b0f57389a8bf5434cd22e05c::pool_v3::';
const json=body=>({ok:true,json:async()=>body});
const graph=body=>json({data:{chainIdentifier:'4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S',...body}});
const emptySui=()=>graph({events:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}});

test('Sui resumes a checkpoint split across pages, including a drop and full recovery',async()=>{
  const registry=openWatchRegistry(':memory:');
  try {
    registry.commit([],'move-algo/cetus',{done:99});
    let now=0, fail=true, pages=0;
    function event(type,hash,from,to) {
      return {sequenceNumber:0,timestamp:time,transaction:{digest:hash,effects:{checkpoint:{sequenceNumber:100}}},
        contents:{type:{repr:type},json:{pool,amount_in:'10',amount_out:'12',before_sqrt_price:String(from),after_sqrt_price:String(to)}}};
    }
    async function request(url,opts) {
      if (url.includes('algod') || url.endsWith('/v2/status')) return json({'last-round':0});
      if (!opts.body) return json({chain_id:1,ledger_version:0,oldest_ledger_version:0});
      const {variables:v}=JSON.parse(opts.body);
      if (!v) return graph({checkpoint:{sequenceNumber:100}});
      if (!v.type.includes('::pool::')) return emptySui();
      pages++;
      if (v.after && fail) throw Error('connection lost');
      const node=v.after ? event(v.type,'second',q64/2n,q64) : event(v.type,'first',q64,q64/2n);
      return graph({events:{nodes:[node],pageInfo:{hasNextPage:!v.after,endCursor:v.after?null:'page-one'}}});
    }
    let reader=createMoveAlgoStreams(registry,request,()=>now);
    await Promise.all([reader.refresh(),reader.refresh()]);
    assert.equal(pages,2);
    assert.equal(registry.cursor('move-algo/cetus').after,'page-one');
    assert.match(reader.coverage().find(r=>r.venue==='cetus').error,/connection lost/);
    now+=5000;
    fail=false;
    reader=createMoveAlgoStreams(registry,request,()=>now);
    await reader.refresh();
    assert.deepEqual(registry.cursor('move-algo/cetus'),{done:100});
    assert.equal(pages,3);
    assert.deepEqual(registry.spikes.pending().map(a=>[a.side,a.changePct]),[['down',-75],['up',300]]);
  } finally {registry.close();}
});

test('Aptos ignores lookalike modules, rejects ledger gaps and reads multiple swaps per transaction',async()=>{
  const marks=[],cursors=new Map([['move-algo/hyperion',98]]);
  const registry={cursor:k=>cursors.get(k),commit:(p,k,v,t=[])=>{cursors.set(k,v);marks.push(...t)}};
  const txn={version:'99',type:'user_transaction',success:true,timestamp:String(Date.parse(time)*1000),hash:'tx',events:[
    {type:'0xbad::pool_v3::SwapEventV3',data:{pool_id:pool,sqrt_price:'9'}},
    {type:hyperion+'SwapBeforeEvent',data:{pool_id:pool,sqrt_price:String(q64)}},
    {type:hyperion+'SwapAfterEvent',data:{pool_id:pool,sqrt_price:String(q64/2n)}},
    {type:hyperion+'SwapEventV3',data:{pool_id:pool,amount_in:'1000',amount_out:'1',sqrt_price:String(q64/2n)}},
    {type:hyperion+'SwapEventV3',data:{pool_id:pool,amount_in:'1',amount_out:'5',sqrt_price:String(q64)}},
    {type:hyperion+'SwapEventV3',data:{pool_id:pool,amount_in:'0',amount_out:'0',sqrt_price:String(q64*4n)}},
  ]};
  let hole=true;
  async function request(url,opts) {
    if (opts.body) return graph({checkpoint:{sequenceNumber:0}});
    if (url.endsWith('/v2/status')) return json({'last-round':0});
    if (url.includes('/transactions?')) return json(hole?[txn,{type:'block_metadata_transaction',version:'101'}]:[txn,{type:'block_metadata_transaction',version:'100'}]);
    return json({chain_id:1,ledger_version:100,oldest_ledger_version:1});
  }
  let reader=createMoveAlgoStreams(registry,request);
  await reader.refresh();
  assert.equal(registry.cursor('move-algo/hyperion'),98);
  assert.equal(marks.length,0);
  hole=false;
  reader=createMoveAlgoStreams(registry,request);
  await reader.refresh();
  assert.equal(registry.cursor('move-algo/hyperion'),100);
  assert.deepEqual(marks.map(t=>[t.seq,t.rawRatio]),[[6,1],[7,0.25],[9,1]]);
});

test('Tinyman orders nested router swaps and flash settlement by execution and checks the validator app',async()=>{
  const marks=[],cursors=new Map([['move-algo/tinyman',4]]);
  const registry={cursor:k=>cursors.get(k),commit:(p,k,v,t=[])=>{cursors.set(k,v);marks.push(...t)}};
  const tx=(id,op,b)=>({txn:{type:'appl',apid:id,apaa:[Buffer.from(op).toString('base64')],apat:[algoPool]},
    dt:{ld:{'1':{asset_1_reserves:{ui:100},asset_2_reserves:{ui:b}}}}});
  const block={rnd:5,gen:'mainnet-v1.0',gh:'wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=',ts:Date.parse(time)/1000,txns:[{txn:{type:'appl',apid:222},
    dt:{itx:[tx(1002541853,'swap',25),tx(999,'swap',1),tx(1002541853,'flash_swap',1),tx(1002541853,'verify_flash_swap',100)]}}]};
  async function request(url,opts) {
    if (opts.body) return graph({checkpoint:{sequenceNumber:0}});
    if (url.endsWith('/v2/status')) return json({'last-round':5});
    if (url.includes('/blocks/')) return json({block});
    return json({chain_id:1,ledger_version:0,oldest_ledger_version:0});
  }
  await createMoveAlgoStreams(registry,request).refresh();
  assert.equal(registry.cursor('move-algo/tinyman'),5);
  assert.deepEqual(marks.map(t=>[t.hash,t.rawRatio]),[['5/0.0',0.25],['5/0.3',1]]);
});

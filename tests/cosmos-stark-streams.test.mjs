import test from 'node:test';
import assert from 'node:assert/strict';
import {createCosmosStarkStreams} from '../lib/cosmos-stark-streams.mjs';

const event=(type,attrs)=>({type,attributes:Object.entries(attrs).map(([key,value])=>({key,value}))});
const osmoSwap=event('token_swapped',{module:'gamm',pool_id:'8',tokens_in:'400ibc/USDC',tokens_out:'100uosmo'});
const neutronSwap={module:'dex',TokenZero:'a',TokenOne:'b',TokenIn:'b',TickIndex:'6',Fee:'2',SwapAmountInDec:'8.123',SwapAmountOutDec:'2'};
const ekuboFilter={address:'0x5dd3d2f4429af886cd1a3b08289dbcea99a294197e9eb43b0e0325b4b',key:'0x157717768aca88da4ac4279765f09f4d0151823d573537fbbeb950cdbd9a870'};
const ekuboEvent=index=>({from_address:ekuboFilter.address,keys:[ekuboFilter.key],block_number:40,block_hash:'star40',
  transaction_hash:'tx0',transaction_index:0,event_index:index,
  data:['0','2','4','5','6','0','1','0','0','0','1','0','10','0','4','1','0',String(index),'1','0','5']});

function fixture() {
  const saved=new Map(),ticks=[],calls=[],state={fail:false,head:40};
  const registry={cursor:key=>saved.get(key), commit(_p,key,next,swaps=[]){saved.set(key,next);ticks.push(...swaps)}};
  function result(chain,method,params) {
    const network=chain==='osmosis'?'osmosis-1':'neutron-1';
    if (method==='status') return {node_info:{network},sync_info:{latest_block_height:String(state.head),catching_up:false}};
    if (method==='blockchain') {
      const start=Number(params.minHeight),end=Number(params.maxHeight);
      return {block_metas:Array.from({length:end-start+1},(_,i)=>({
        header:{height:String(start+i),chain_id:network,time:'2026-11-24T00:00:00Z'},block_id:{hash:'hash'+(start+i)},
        num_txs:start+i===40?'2':'0'})).reverse()};
    }
    if (method==='block_results') {
      const n=Number(params.height);
      if (state.fail&&n===41&&chain==='neutron') return {height:'41',txs_results:[{}]};
      const events=chain==='osmosis'?[osmoSwap,osmoSwap]:[
        event('TickUpdate',neutronSwap),
        event('TickUpdate',{...neutronSwap,TokenIn:'a',TickIndex:'-2',SwapAmountInDec:'2',SwapAmountOutDec:'8.123'}),
        event('TickUpdate',{...neutronSwap,TrancheKey:'order'}),
        event('TickUpdate',{...neutronSwap,SwapAmountInDec:'0',SwapAmountOutDec:'0'}),
      ];
      return {height:params.height,txs_results:n===40?[{code:3,events},{code:0,events}]:null};
    }
    if (method==='starknet_chainId') return '0x534e5f4d41494e';
    if (method==='starknet_blockNumber') return state.head+2;
    if (method==='starknet_getEvents') {
      const [filter]=params;
      assert.equal(filter.address,ekuboFilter.address);
      assert.deepEqual(filter.keys,[[ekuboFilter.key]]);
      if (filter.from_block.block_number>40) return {events:[]};
      return filter.continuation_token?{events:[ekuboEvent(2)]}:{events:[ekuboEvent(1)],continuation_token:'next'};
    }
    if (method==='starknet_getBlockWithTxHashes') return {block_number:40,block_hash:'star40',status:'ACCEPTED_ON_L2',timestamp:1795478400,transactions:['tx0']};
    throw Error('unexpected method');
  }
  const request=async(url,options)=>{
    const list=JSON.parse(options.body),chain=url.includes('osmosis')?'osmosis':url.includes('neutron')?'neutron':'starknet';
    calls.push(list.map(c=>c.method));
    const data=list.map(c=>({id:c.id,result:result(chain,c.method,c.params)})).reverse();
    return {ok:true,json:async()=>data.length===1?data[0]:data};
  };
  return {registry,request,ticks,state,calls};
}

test('replays all pages and successful exchange fills, with stable pool identity in both directions',async()=>{
  const {registry,request,ticks,calls}=fixture();
  const streams=createCosmosStarkStreams(registry,request);
  await Promise.all([streams.refresh(),streams.refresh()]);
  assert.equal(calls.filter(ms=>ms.includes('starknet_blockNumber')).length,1);
  assert.deepEqual(streams.coverage().map(s=>[s.venue,s.processed,s.observed]),[['osmosis',40,2],['duality',40,2],['ekubo',40,2]]);
  const osmo=ticks.filter(t=>t.chain==='osmosis');
  assert.deepEqual(osmo.map(t=>t.seq),[0,1]);
  assert.deepEqual(osmo[0].tokens,['ibc/USDC','uosmo']);
  assert.equal(osmo[0].rawRatio,0.25);
  const [a,b]=ticks.filter(t=>t.chain==='neutron');
  assert.equal(a.pool,b.pool);
  assert.equal(a.rawRatio,b.rawRatio);
  assert.equal(a.rawRatio,2/8.123);
  assert.deepEqual(ticks.filter(t=>t.chain==='starknet').map(t=>[t.seq,t.rawRatio]),[[0,1],[1,4]]);
  await createCosmosStarkStreams(registry,request).refresh();
  assert.equal(ticks.length,6);
});

test('keeps the cursor at the last complete range when results are inconsistent and resumes on retry',async()=>{
  const {registry,request,state,ticks}=fixture();
  const streams=createCosmosStarkStreams(registry,request);
  await streams.refresh();
  state.head=41;state.fail=true;
  await streams.refresh();
  const failed=streams.coverage().find(r=>r.chain==='neutron');
  assert.equal(failed.processed,40);
  assert.match(failed.error,/Incomplete CometBFT block/);
  assert.equal(streams.coverage().find(r=>r.chain==='osmosis').processed,41);
  state.fail=false;
  await streams.refresh();
  assert.equal(streams.coverage().find(r=>r.chain==='neutron').processed,41);
  assert.equal(ticks.length,6);
});

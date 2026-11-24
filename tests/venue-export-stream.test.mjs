import test from 'node:test';
import assert from 'node:assert/strict';
import {createVenueExportStream} from '../lib/venue-export-stream.mjs';

const tokenIn='wrap.near', tokenOut='usdc.near';
const action={pool_id:90,token_in:tokenIn,token_out:tokenOut};
function receipt(logs,actions,success=true) {
  const call={method_name:'ft_on_transfer',args:Buffer.from(JSON.stringify({msg:JSON.stringify({actions})})).toString('base64')};
  return {receipt:{receipt:{Action:{actions:[{FunctionCall:call}]}}},execution_outcome:{id:'receipt',
    outcome:{executor_id:'v2.ref-finance.near',status:success?{SuccessValue:''}:{Failure:{}},logs}}};
}
const block=(height,previous,receipts)=>({block:{header:{height,prev_height:previous,hash:'h'+height,prev_hash:'h'+previous,
  timestamp_nanosec:'1795492449680170827'}},shards:[{receipt_execution_outcomes:receipts}]});
const response=data=>({ok:true,json:async()=>data});
const pool='EQCItmol3T2MxI476jbvQa01EDqmBRIZ3xP_FtGdQewuWVUk';
const swap=(id,i,amounts)=>({eventType:'swap',txnId:id.repeat(64),txnIndex:i,eventIndex:1,
  block:{blockNumber:2,blockTimestamp:1795492449},pairId:pool,...amounts});

test('Rhea verifies classic receipt legs, tracks unmatched swaps and checks skipped block ancestry',async()=>{
  const marks=[],keys=new Map([['receipt-stream/near',{height:1,hash:'h1'}]]);
  const registry={cursor:k=>keys.get(k),commit:(p,k,c,t)=>{keys.set(k,c);marks.push(...t)}};
  const logs=['Swapped 50 wrap.near for 100 usdc.near'];
  const doc=block(3,1,[receipt(logs,[action]),receipt(logs,[{...action,token_in:'other.near'}]),receipt(logs,[action],false)]);
  let invalid=true;
  async function request(url) {
    if(url.includes('latest-block'))return response({block:{blockNumber:0}});
    if(url.includes('/last_block/'))return response(invalid?block(3,2,[]):doc);
    return response(null);
  }
  let stream=createVenueExportStream(registry,request);
  await stream.refresh();
  assert.match(stream.coverage().find(x=>x.chain==='near').error,/ancestry/);
  assert.equal(keys.get('receipt-stream/near').height,1);
  invalid=false;
  stream=createVenueExportStream(registry,request);
  await stream.refresh();
  assert.equal(keys.get('receipt-stream/near').height,3);
  assert.deepEqual(marks.map(t=>[t.pool,t.rawRatio,t.series]),[['90',0.5,'usdc.near/wrap.near']]);
  assert.equal(stream.coverage().find(x=>x.chain==='near').unpriced,1);
});
test('STON official export processes both swap directions in transaction order and filters duplicates',async()=>{
  const keys=new Map(),marks=[];
  const registry={cursor:k=>keys.get(k),commit:(p,k,c,t)=>{keys.set(k,c);marks.push(...t)}};
  const first=swap('a',100,{amount1In:'2',amount0Out:'4'}), second=swap('b',102,{amount0In:'2',amount1Out:'4'});
  async function request(url) {
    if(url.includes('/last_block/'))return response(block(1,0,[]));
    if(url.endsWith('/latest-block'))return response({block:{blockNumber:2}});
    return response({events:[second,{eventType:'join'},first,second]});
  }
  const stream=createVenueExportStream(registry,request);
  await stream.refresh();
  await stream.refresh();
  assert.equal(keys.get('venue-export/stonfi'),2);
  assert.deepEqual(marks.map(t=>[t.seq,t.rawRatio]),[[0,0.5],[1,2]]);
  assert.equal(stream.coverage().find(x=>x.chain==='ton').source,'venue-export');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createHydrationArchive} from '../lib/hydration-swap-archive.mjs';

const genesis='0xafdc188f45c71dacbaa0b62e16a91f726c7b8699a9748cdf715459de6b7f366d';
const hash=n=>'0x'+n.toString(16).padStart(64,'0');
function fixture() {
  let saved=null;
  const samples=[],state={mismatch:false,height:80};
  const registry={cursor:()=>saved,commit(_rows,_key,next,ticks=[]){saved=next;samples.push(...ticks)}};
  async function request(url,init) {
    if (url.endsWith('/finalized-head')) return Response.json({number:state.height,hash:hash(state.height)});
    const query=JSON.parse(init.body);
    if (url.endsWith('/stream')) {
      const blocks=[];
      for (let n=query.fromBlock;n<=query.toBlock;n++) {
        const header={number:n,hash:hash(n),parentHash:hash(n-1),timestamp:1795478400000+n*1000};
        const trade={name:'Stableswap.SellExecuted',phase:'ApplyExtrinsic',extrinsicIndex:2,index:3,
          args:{assetIn:83,assetOut:1,amountIn:'100',amountOut:'12',poolId:9}};
        const events=n!==80?[]:[{...trade,extrinsicIndex:1,index:2},trade,
          {name:'System.ExtrinsicFailed',phase:'ApplyExtrinsic',extrinsicIndex:2,index:4},
          {name:'XYK.BuyExecuted',phase:'Finalization',index:5,args:{assetIn:0,assetOut:1,amount:'8',buyPrice:'16'}}];
        blocks.push(JSON.stringify({header,events}));
      }
      return new Response(blocks.join('\n')+'\n');
    }
    if (query.method==='chain_getFinalizedHead') return Response.json({result:hash(10000)});
    if (query.method==='chain_getHeader') return Response.json({result:{number:'0x2710'}});
    if (query.method==='chain_getBlockHash') return Response.json({result:query.params[0]===0?genesis:hash(state.mismatch?1:query.params[0])});
    throw Error('Unexpected call');
  }
  return {registry,request,samples,state};
}

test('reports archive and finalized head separately and feeds only committed per-pair runtime fills',async()=>{
  const {registry,request,samples}=fixture();
  const stream=createHydrationArchive(registry,request);
  await stream.refresh();
  const [coverage]=stream.coverage();
  assert.deepEqual([coverage.mode,coverage.head,coverage.archiveHead,coverage.processed,coverage.observed],['archive',10000,80,80,2]);
  assert.deepEqual(samples.map(e=>[e.pool,e.series,e.seq,e.rawRatio]),[['stableswap-9','1-83',2,100/12],['xyk-0-1','0-1',5,0.5]]);
  await createHydrationArchive(registry,request).refresh();
  assert.equal(samples.length,2);
});

test('mismatched canonical hash retains checkpoint for retry',async()=>{
  const {registry,request,samples,state}=fixture();
  state.mismatch=true;
  const stream=createHydrationArchive(registry,request);
  await stream.refresh();
  assert.equal(stream.coverage()[0].processed,64);
  assert.match(stream.coverage()[0].error,/hash mismatch/);
  assert.equal(samples.length,0);
  state.mismatch=false;
  await stream.refresh();
  assert.equal(stream.coverage()[0].processed,80);
  assert.equal(samples.length,2);
});

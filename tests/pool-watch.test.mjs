import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {events,initialize,v4Swap,consumeBlocks,v4Networks} from '../lib/pool-event-stream.mjs';
import {rpcNetworks,rpcRange} from '../lib/v4-public-rpc.mjs';
import {openWatchRegistry} from '../lib/watch-registry.mjs';
import {decodePoolKey} from '../lib/v4-pool-keys.mjs';
import {eventPrices} from '../lib/event-prices.mjs';
import {readSolanaDirectory} from '../lib/solana-pool-directory.mjs';
import {solanaActivities} from '../lib/solana-swaps.mjs';
import {CHAINS} from '../lib/assets.js';

const net=v4Networks.find(n=>n.chain==='bsc'),pool='0x'+'d'.repeat(64);
const t0='0x'+'1'.repeat(40),t1=CHAINS[56].usdc;
const word=n=>BigInt(n).toString(16).padStart(64,'0');
const stamp=1700000000;
test('an established V4 pool enters the queue on swap without an Initialize or token allowlist',()=>{
  const swap={address:net.manager,topics:[v4Swap,pool,'0x'+word(1)],data:'0x'+[0,0,2n**96n,4,0,0].map(word).join('')};
  const block={header:{timestamp:stamp},logs:[{...swap,address:t0},swap]};
  assert.deepEqual(events(net,[block]).swaps,[{chain:'bsc',pool,protocol:'v4',time:stamp*1000,rawRatio:1}]);
  assert.equal(events(net,[{...block,logs:[{...swap,address:t0}]}]).pools.length,0);
  const init={address:net.manager,topics:[initialize,pool,'0x'+word(t0),'0x'+word(t1)]};
  const r=openWatchRegistry(':memory:');
  const found=events(net,[{...block,logs:[init,swap]}]);r.commit(found.pools);
  const assets=[{chain:56,token:t0,decimals:18,id:'x'},{chain:56,token:t1,decimals:18}];
  assert.equal(eventPrices(found.swaps,r,assets,[],stamp*1000)[0].ask,1);
  assert.equal(eventPrices(found.swaps,r,assets,[],stamp*1000+45000).length,0);
  assert.equal(eventPrices([{...found.swaps[0],protocol:'v3'}],r,assets,[],stamp*1000).length,0);
  assert.equal(decodePoolKey('0x'+'0'.repeat(320)),null);
  assert.equal(new Set([...v4Networks,...rpcNetworks].map(n=>n.chain)).size,22);
  assert.ok(v4Networks.every(x=>/^0x[0-9a-f]{40}$/.test(x.manager)));
  r.close();
});
test('RPC history shrinks a rejected range and only acknowledges its successful prefix',async()=>{
  const network=rpcNetworks[0],request=async (_,o)=>{
    const {params}=JSON.parse(o.body);
    assert.equal(params[0].address,network.manager);
    const tooWide=Number(params[0].toBlock)-Number(params[0].fromBlock)>30;
    return Response.json(tooWide?{error:{code:-32005,message:'block range limit'}}:{result:[]});
  };
  const page=await rpcRange(network,100,199,[initialize],request,events);
  assert.equal(page.last,124);assert.deepEqual(page.pools,[]);
});
test('RPC logs with a zero timestamp use the timestamp of the corresponding block',async()=>{
  const network=rpcNetworks.find(n=>n.chain==='robinhood');
  const request=async (_,options)=>{
    const q=JSON.parse(options.body);
    const result=q.method==='eth_getLogs'?[{address:network.manager,blockNumber:'0x64',blockTimestamp:'0x0',
      topics:[initialize,pool,'0x'+word(t0),'0x'+word(t1)],logIndex:'0x0'}]:{timestamp:'0x'+stamp.toString(16)};
    return Response.json({result});
  };
  assert.equal((await rpcRange(network,100,100,[initialize],request,events)).pools[0].pool,pool);
});
test('partial streams commit only decoded blocks and reject missing or invalid boundaries',async()=>{
  const b=number=>JSON.stringify({header:{number}});
  const r=await consumeBlocks(new Response([b(20),b(23)].join('\n')),20,30,x=>({count:x.length}));
  assert.deepEqual(r,{last:23,count:2});
  await assert.rejects(consumeBlocks(new Response(b(21)),20,30,()=>({})));
  await assert.rejects(consumeBlocks(new Response(''),20,30,()=>({})));
});
test('checkpoints, verified keys and pricing order survive reopening the registry',()=>{
  const dir=mkdtempSync(join(tmpdir(),'gapdesk-watch-')),file=join(dir,'test.sqlite');
  let r=openWatchRegistry(file);
  try{
    r.commit(Array.from({length:65},(_,i)=>({chain:'bsc',pool:String(i).padStart(2,'0')})),'blocks/bsc',123);
    r.commit([{chain:'bsc',pool,tokens:[t0,t1],venue:'uniswap',initialized:true}]);
    const first=r.batch('bsc',100000);r.attempted('bsc',first,100000);r.close();r=openWatchRegistry(file);
    assert.equal(r.cursor('blocks/bsc'),123);assert.equal(r.identity('bsc',pool).token1,t1);
    assert.equal(r.batch('bsc',130000).some(x=>first.some(p=>p.pool===x.pool)),false);
    assert.equal(r.size(),66);
  }finally{r.close();rmSync(dir,{recursive:true,force:true})}
});
test('Solana directory and swap pool discovery preserve case and require successful instructions',async()=>{
  const mint='So11111111111111111111111111111111111111112',stable='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const id='Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';
  const {pools,next}=await readSolanaDirectory('orca','abc',async u=>{
    assert.ok(u.includes('next=abc'));return {data:{data:[{address:id,tokenMintA:mint,tokenMintB:stable}],meta:{cursor:{next:'def'}}}};
  });
  assert.equal(next,'def');assert.deepEqual(pools[0].tokens,[mint,stable]);
  const ix={programId:'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',d8:'0xf8c69e91e17587c8',
    isCommitted:true,transactionIndex:1,instructionAddress:[0],accounts:['','',id,'',mint,'',stable]};
  const result=solanaActivities([{header:{timestamp:stamp},instructions:[ix,{...ix,isCommitted:false,accounts:[]}]}]);
  assert.equal(result.pools[0].pool,id);assert.equal(result.trades.length,0);
  const child=(i,accounts)=>({programId:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',accounts,
    isCommitted:true,transactionIndex:1,instructionAddress:[0,i],d8:'0x0c98e94b00000000',data:'i3qWuK6otZvFw'});
  const transferA=child(0,[id,mint,mint]),transferB=child(1,[stable,stable,id]);
  const block={header:{timestamp:stamp},instructions:[ix,transferA,transferB]};
  assert.deepEqual(solanaActivities([block]).trades[0].tokens,[mint,stable]);
  assert.equal(solanaActivities([{...block,instructions:[ix,transferA,{...transferB,transactionIndex:2}]}]).trades.length,0);
  assert.equal(solanaActivities([{...block,instructions:[...block.instructions,child(2,[stable,stable,id])]}]).trades.length,0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createMultiversxSwaps,xexchangeTicks} from '../lib/multiversx-swaps.mjs';

// Real TADA/WEGLD Pair.swap payload from finalized shard 1 block 41980785.
const address='erd1qqqqqqqqqqqqqpgqamlvh7su5925r7djmd36xd93gylfym9j2jpsdya7mj';
const event={address,identifier:'swapTokensFixedInput',
  topics:['c3dhcA==','VEFEQS01YzAzMmM=','V0VHTEQtYmQ0ZDc5','EgDagQ2LZHREr8t90iPfQ+Stcfeplp4Kx3hf1DClE4U=','CP8='],
  data:'EgDagQ2LZHREr8t90iPfQ+Stcfeplp4Kx3hf1DClE4UAAAALVEFEQS01YzAzMmMAAAAKCm71i0+z+8oAAAAAAAxXRUdMRC1iZDRkNzkAAAAIGYaDX0+oLUkAAAAJAqvD+rQl4kAAAAAACw52A4PbVZ1ck2C/AAAACSNiqzNuwo+zRAAAAAACgJNxAAAAAAAACP8AAAAAawUK8Q=='};
const height=41980785,time=1795492593;
const block={shard:1,status:'on-chain',nonce:height,timestamp:time,hash:'a'.repeat(64),prevBlockHash:'b'.repeat(64),numTxs:1,
  miniBlocks:[{type:'TxBlock',destinationShard:1,transactions:[{status:'success',logs:{events:[event]}}]}]};
const pools=new Set([address.slice(4,-6)]);
test('native MultiversX pair payload is bound to shard, block, token IDs, and router membership',()=>{
  const {ticks}=xexchangeTicks(block,height,pools);
  assert.deepEqual(ticks[0].tokens,['TADA-5c032c','WEGLD-bd4d79']);
  assert.equal(ticks[0].rawRatio,0.00003733069368504439);
  assert.equal(xexchangeTicks(block,height,new Set()).ticks.length,0);
  assert.throws(()=>xexchangeTicks({...block,shard:2},height,pools));
  assert.throws(()=>xexchangeTicks({...block,timestamp:time+1},height,pools));
  const batch=structuredClone(block);
  batch.miniBlocks[0].transactions[0].logs.events.push(event);
  assert.deepEqual(xexchangeTicks(batch,height,pools).ticks.map(t=>t.seq),[1,2]);
  batch.miniBlocks[0].transactions[0].logs.events[0].topics[1]='VEFEQQ==';
  assert.throws(()=>xexchangeTicks(batch,height,pools));
});
test('a failed finalized block is retried without committing a gap or repeating earlier swaps',async()=>{
  let saved={height:height-1,hash:block.prevBlockHash,observed:0,lastSwapAt:null},at=0,broken=true;
  const commits=[];
  const reg={cursor:()=>saved,commit:(rows,key,c,ticks)=>{saved=c;commits.push([c.height,ticks.length])}};
  const alpha='qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const bits=[...address.slice(4,-6)].map(ch=>alpha.indexOf(ch).toString(2).padStart(5,'0')).join('');
  const raw=Buffer.from(bits.slice(0,256).match(/.{8}/g).map(b=>parseInt(b,2))).toString('base64');
  const next={...block,nonce:height+1,hash:'c'.repeat(64),prevBlockHash:block.hash,miniBlocks:[],numTxs:0};
  const reader=createMultiversxSwaps(reg,{now:()=>at,request:async url=>{
    let data;
    if(url.endsWith('/query'))data={data:{returnCode:'ok',returnData:[raw]}};
    else if(url.includes('/network/status/'))data={status:{erd_highest_final_nonce:height+1}};
    else data={block:url.includes('/'+height+'?')?block:{...next,prevBlockHash:broken?'d'.repeat(64):block.hash}};
    return Response.json({code:'successful',data});
  }});
  await reader.refresh();assert.match(reader.coverage()[0].error,/continuity/);
  assert.deepEqual(commits,[[height,1]]);
  broken=false;at=6000;await reader.refresh();await reader.refresh();
  assert.deepEqual(commits,[[height,1],[height+1,0]]);assert.equal(reader.coverage()[0].observed,1);
});

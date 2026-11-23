import test from 'node:test';
import assert from 'node:assert/strict';
import {CHAINS} from '../lib/assets.js';
import {readCloudDepth,depthRecheckEntries} from '../lib/cloud-pool-depth.mjs';
import {depthFactory} from '../lib/pool-depth.mjs';

const addr=n=>'0x'+n.toString(16).padStart(40,'0');
const raw=a=>a.slice(2).padStart(64,'0');
const chain=8453,stable=CHAINS[chain].usdc,asset=addr(11),wrapped=addr(12),pool=addr(21),anchor=addr(22);
const target='dex:'+chain+':'+asset+':'+pool;
const pair=(id=pool)=>({chainId:'base',pairAddress:id,dexId:'uniswap',baseToken:{address:asset},quoteToken:{address:wrapped}});
const v2=depthFactory(chain,'uniswap','v2'),v3=depthFactory(chain,'uniswap','v3');
const zero=raw(addr(0));
function factoryResult(c){
  if(c.to===v2&&c.data.startsWith('e6a43905')&&c.data.includes(raw(asset))&&c.data.includes(raw(wrapped)))return raw(pool);
  if(c.to===v3&&c.data.startsWith('1698ee82')&&c.data.includes(raw(stable))&&c.data.includes(raw(wrapped))&&c.data.endsWith((500).toString(16).padStart(64,'0')))return raw(anchor);
  return zero;
}
test('missing indexed target is recovered by exact pool and canonical factory; included anchor is re-read',async()=>{
  const batches=[];
  const io={readWords:async(id,calls)=>{
    assert.equal(id,chain);batches.push(calls.length);
    return calls.map(c=>c.to===pool?({'0dfe1681':raw(wrapped),'d21220a7':raw(asset),'ddca3f43':null}[c.data]):factoryResult(c));
  },readPools:async(entries,assets,options)=>({entries,options})};
  const result=await readCloudDepth({pairs:[],assets:new Map(),targets:[target]},io);
  assert.equal(batches.length,2);
  assert.equal(result.entries.find(e=>e.pool===pool).base,asset);
  assert.deepEqual(result.entries.map(e=>e.protocol).sort(),['v2','v3']);
  assert.equal(result.options.concurrency,1);
});
test('source ID with a lookalike asset and a forged index hint cannot introduce pool depth',async()=>{
  const id='dex:'+chain+':'+addr(91)+':'+pool;
  const reads=[];
  const io={readWords:async(_,calls)=>calls.map(c=>c.data==='0dfe1681'?raw(asset):c.data==='d21220a7'?raw(wrapped):factoryResult(c)),
    readPools:async entries=>{reads.push(entries);return {markets:[]}}};
  const out=await readCloudDepth({pairs:[pair()],assets:[],targets:[id]},io);
  assert.deepEqual(out.markets,[]);assert.equal(reads.length,0);
  const unlisted=addr(92);
  await readCloudDepth({pairs:[{...pair(unlisted),quoteToken:{address:stable}}],assets:[],targets:['dex:'+chain+':'+asset+':'+unlisted],
    savedEntries:[{chain,pool:unlisted,base:asset,quote:stable,protocol:'v2',dexId:'uniswap'}]},io);
  assert.equal(reads.length,0);
});
test('bounded fallback rotates selected pools, skips unknown sources, retains exact recheck descriptors',async()=>{
  const many=Array.from({length:14},(_,i)=>({...pair(addr(i+101)),baseToken:{address:addr(i+1)},quoteToken:{address:stable}}));
  many.push({...pair(),chainId:'otherchain'}, {...pair(),dexId:'unlisted'});
  const io={readWords:async(_,calls)=>calls.map(c=>{
    if(c.to!==v2)return zero;
    const index=many.slice(0,14).findIndex(p=>c.data.includes(raw(p.baseToken.address)));
    return index<0?zero:raw(many[index].pairAddress);
  }),readPools:async entries=>({markets:entries})};
  const one=await readCloudDepth({pairs:many,assets:[],cursor:0},io),two=await readCloudDepth({pairs:many,assets:[],cursor:8},io);
  assert.equal(one.markets.length,8);assert.equal(two.markets.length,8);
  assert.equal(new Set([...one.markets,...two.markets].map(p=>p.pool)).size,14);
  const descriptor={chain,pool,token0:asset,token1:stable,dexId:'uniswap',protocol:'v3',feePpm:500};
  assert.deepEqual(depthRecheckEntries({depth:descriptor},{pools:[pool]}),[{chain,pool,base:asset,quote:stable,dexId:'uniswap',protocol:'v3',feePpm:500}]);
});

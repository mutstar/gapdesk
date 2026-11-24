import test from 'node:test';
import assert from 'node:assert/strict';
import {dexVenues,networks} from '../lib/dex-venues.mjs';
import {createVenueMonitor,readScreener,readGecko,responseTime} from '../lib/venue-observations.mjs';
import {strictContractKey} from '../lib/contract-identity.mjs';
import {discover} from '../lib/universe.mjs';

const now=Date.now(),fx={ask:1.01,bid:1,time:now},dex=dexVenues.find(v=>v.name==='Cetus');
const pool='0x'+'2'.repeat(64),usdc='0xa::coin::USDC',coin='0xb::d::DEEP';
const pair={chainId:'sui',dexId:'cetus',pairAddress:pool,baseToken:{address:coin,symbol:'DEEP'},
  quoteToken:{address:usdc,symbol:'USDC'},priceUsd:'2',priceNative:'2',liquidity:{usd:10000}};
test('all 61 distinct venues have a chain and a collection source',()=>{
  assert.equal(new Set(dexVenues.map(v=>v.id)).size,61);
  assert.ok(dexVenues.every(v=>v.chains.every(c=>networks[c])));
  assert.equal(createVenueMonitor().snapshot().sources.filter(s=>s.ok).length,0);
});
test('pool observations require exact venue, network and token, and preserve issuer case',()=>{
  const rows=readScreener(dex,[pair,{...pair,dexId:'other'},{...pair,chainId:'aptos'}],now,fx);
  assert.equal(rows.length,2);assert.equal(rows[0].ask,2);assert.equal(rows[0].bid,2/1.01);
  assert.equal(rows[0].observationOnly,true);
  assert.notEqual(strictContractKey({chain:'sui',token:coin}),strictContractKey({chain:'sui',token:coin.toLowerCase()}));
  assert.equal(strictContractKey({chain:'sui',token:'0x000b::d::DEEP'}),strictContractKey({chain:'sui',token:coin}));
  const b={...pair,pairAddress:'0x'+'3'.repeat(64),priceUsd:'3'};
  const result=discover(rows.concat(readScreener(dex,[b],now,fx)),1000,1,1,true);
  assert.equal(result.candidates.length,0);assert.ok(result.diagnosticGaps.length);
  assert.ok(result.signalData.gaps.length);assert.equal(result.signalData.gaps[0].profit,undefined);
});
test('Gecko prices require a matching pool, token relationship and DEX deployment',()=>{
  const network='sui-network',id=network+'_'+coin,d={data:[{id:network+'_'+pool,type:'pool',attributes:{address:pool,base_token_price_usd:'2'},
    relationships:{dex:{data:{id:'cetus'}},base_token:{data:{id}}}}],included:[{type:'token',id,attributes:{address:coin,symbol:'DEEP'}}]};
  assert.equal(readGecko(dex,'sui/cetus',d,now,fx).length,1);
  assert.deepEqual(readGecko(dex,'sui/not-cetus',d,now,fx),[]);
  d.included[0].attributes.address=usdc;
  assert.deepEqual(readGecko(dex,'sui/cetus',d,now,fx),[]);
});
test('a cached response keeps its age and unknown publication times cannot be current',()=>{
  const headers=new Headers({date:new Date(now).toUTCString(),age:'60'});
  assert.ok(responseTime(headers,now)<=now-60000);
  assert.equal(responseTime(new Headers(),now),0);
});

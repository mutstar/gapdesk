import test from 'node:test';
import assert from 'node:assert/strict';
import {discover} from '../lib/universe.mjs';
import {bridgeDestinations} from '../lib/token-contracts.mjs';
const token=n=>'0x'+n.toString(16).padStart(40,'0');
test('contract rows retain case-sensitive addresses, collapse pools and isolate namesakes for bridging',()=>{
  const make=(chain,addr,venue)=>({chain,token:addr,id:venue,kind:'DEX',symbol:'ACE'});
  const one=make(1,token(1),'pool1'),alt=make(8453,token(2),'pool2'),fake=make(56,token(3),'pool3');
  const sol='AGmJfQzt3Qapw2puDq5LFrZKGRv7d7buaKz91UfeSksS';
  const cex={id:'cex',kind:'CEX',symbol:'ACE',name:'Exchange',networks:[one,alt,{chain:'solana',token:sol}]};
  const [row]=discover([cex,one,alt,{...one,id:'anotherPool'},fake],1000,5).summaries;
  assert.equal(row.contracts.length,4);
  assert.ok(row.contracts.some(c=>c.token===sol));
  const src=row.contracts.find(c=>c.chain===1);
  assert.deepEqual(src.venues,['Exchange']);
  assert.deepEqual(bridgeDestinations(src,row.contracts).map(c=>c.chain),[8453]);
  assert.deepEqual(bridgeDestinations(row.contracts.find(c=>c.chain===56),row.contracts),[]);
});
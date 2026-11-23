import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSpikeTracker} from '../lib/venue-spikes.mjs';

const interval=30_000;
const start=Math.floor(Date.now()/interval)*interval;
const price=(name,ask,bid=ask,extra={})=>({id:name+':ACE',symbol:'ACE',asset:'bsc:ace',venue:name,name,ask,bid,...extra});
const snapshot=(tracker,tick,markets,config='1000:5:1')=>{
  const at=start+tick*interval;
  return tracker.observe(markets.map(m=>({time:at,...m})),{at,config});
};

test('spikes use opposite sides of the book, source timestamps and independent asset references',async()=>{
  const tracker=await createSpikeTracker();
  snapshot(tracker,0,[price('Bitget',102,100),price('KuCoin',101,100)]);
  const found=snapshot(tracker,1,[price('Bitget',80,79,{time:start+interval-2000}),price('KuCoin',82,80)]);
  const bitget=found.find(x=>x.marketId==='Bitget:ACE');
  assert.equal(bitget.side,'down');
  assert.ok(Math.abs(bitget.changePct+20)<1e-10);
  assert.equal(bitget.price,80);
  assert.equal(bitget.baselinePrice,100);
  assert.equal(bitget.windowSec,30);
  assert.equal(bitget.at,start+interval-2000);
  assert.equal(bitget.baselineAt,start);
  assert.equal(bitget.corroborated,true);
  assert.equal(bitget.referenceVenue,'KuCoin');

  const rise=snapshot(tracker,2,[price('Bitget',102,100),price('KuCoin',104,102)]);
  const up=rise.find(x=>x.marketId==='Bitget:ACE'&&x.windowSec===30);
  assert.equal(up.side,'up');
  assert.equal(up.baselinePrice,80);
  assert.equal(up.price,100);
  assert.equal(up.changePct,25);
});

test('one-sided DEX samples can compare available opposite sides without inventing a missing price',async()=>{
  const tracker=await createSpikeTracker();
  snapshot(tracker,0,[price('Uni',100,98),price('Dex2',100,null)]);
  const signals=snapshot(tracker,1,[price('Uni',80,null),price('Dex2',null,125)]);
  assert.equal(signals.length,2);
  assert.deepEqual(signals.map(x=>[x.side,x.baselinePrice,x.price]),[['down',98,80],['up',100,125]]);
});

test('continuous threshold crossing emits once per window and direction',async()=>{
  const tracker=await createSpikeTracker();
  snapshot(tracker,0,[price('A',100)]);
  const initial=snapshot(tracker,1,[price('A',111)]);
  const sustained=snapshot(tracker,2,[price('A',127)]);
  assert.deepEqual(initial.map(e=>e.windowSec),[30]);
  assert.deepEqual(sustained.map(e=>e.windowSec),[60]);
  assert.deepEqual(snapshot(tracker,2,[price('A',127)]),[]);
  snapshot(tracker,3,[price('A',127)]);
  assert.deepEqual(snapshot(tracker,4,[price('A',145)]).map(e=>e.windowSec),[30]);
});

test('no independent corroboration from unknown or colliding tickers or other pools at the same venue',async()=>{
  const tracker=await createSpikeTracker();
  const rows=(p)=>[price('Uni',p),price('Uni',p,p,{id:'pool2'}),price('Other',p,p,{asset:'eth:namesake'}),price('Bithumb',p,p,{asset:null})];
  snapshot(tracker,0,rows(100));
  const events=snapshot(tracker,1,rows(125));
  assert.equal(events.length,4);
  assert.ok(events.every(e=>!e.corroborated && e.referenceVenue===null));
});

test('gaps, stale source timestamps and changed settings invalidate the baseline',async()=>{
  const tracker=await createSpikeTracker();
  snapshot(tracker,0,[price('A',100),price('B',100)]);
  snapshot(tracker,1,[price('A',100)]);
  assert.deepEqual(snapshot(tracker,2,[price('B',125)]),[]);
  assert.deepEqual(snapshot(tracker,4,[price('A',130),price('B',180)]),[]);
  assert.deepEqual(snapshot(tracker,5,[price('A',190),price('B',230)],'new amount'),[]);
  assert.deepEqual(snapshot(tracker,6,[price('A',195,195,{time:start+5*interval})],'new amount'),[]);
  assert.deepEqual(snapshot(tracker,7,[price('A',210)],'new amount'),[]);
  assert.deepEqual(snapshot(tracker,8,[price('A',300,300,{asset:'other'})],'new amount'),[]);
});

test('hour-long baselines require continuous samples and survive an actual tracker restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'gapdesk-spike-'));
  const file=join(dir,'frames.sqlite');let tracker;
  try{
    tracker=await createSpikeTracker({cacheFile:file,now:()=>start});
    for(let tick=0;tick<120;tick++)snapshot(tracker,tick,[price('A',100)]);
    const initial=snapshot(tracker,120,[price('A',115)]);
    assert.deepEqual(initial.map(e=>e.windowSec),[30,60,300,900,1800,3600]);
    tracker.close();
    tracker=await createSpikeTracker({cacheFile:file,now:()=>start+121*interval});
    assert.deepEqual(snapshot(tracker,121,[price('A',135)]),[]);
  }finally{tracker?.close();await rm(dir,{recursive:true,force:true})}
});

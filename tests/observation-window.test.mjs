import test from 'node:test';
import assert from 'node:assert/strict';
import {combineObservationBooks,currentQualifiedRows,displayedObservations,mergeFrame,observationCache,restoreObservationCache} from '../lib/observation-window.mjs';
const now=2_000_000,token='0x'+'1'.repeat(40);
function row(id,time,kind='CEX'){
  return {id,time,symbol:'ACE',gap:8,match:{chain:1,token},kind:'spot_spot',buy:{kind},sell:{kind:'CEX'}};
}
function frame(startedAt,complete,rows,seq=1){
  return {startedAt,at:startedAt+seq,seq,complete,budget:1000,floor:5,maxImpact:1,spotGaps:rows,futures:{rows:[]}};
}
const old=frame(now-30000,true,[row('a',now-31000),row('b',now-31500,'DEX')]);
test('prior observations keep source time in a partial cycle, including on first visit',()=>{
  const empty={...frame(now,false,[]),previous:old};
  const state=mergeFrame(null,empty);
  assert.deepEqual(displayedObservations(state,now).map(r=>[r.id,r.previous,r.time]),[['a',true,now-31000],['b',true,now-31500]]);
  const updated=mergeFrame(state,frame(now,false,[row('new',now-100)],2));
  assert.deepEqual(displayedObservations(updated,now).map(r=>[r.id,r.previous]),[['new',false],['b',true]]);
  const closed=mergeFrame(updated,frame(now,true,[],3));
  assert.deepEqual(displayedObservations(closed,now+3).map(r=>[r.id,r.previous,r.time]),[['new',true,now-100],['b',true,now-31500]]);
  assert.equal(mergeFrame(closed,empty),closed);
});
test('delayed full can seed a newer partial but cannot replace it or change settings',()=>{
  const partial=frame(now,false,[]);
  const state=mergeFrame(mergeFrame(null,partial),old);
  assert.equal(state.frame.startedAt,now);
  assert.equal(displayedObservations(state,now)[0].previous,true);
  assert.deepEqual(displayedObservations(mergeFrame(null,{...partial,budget:300,previous:old}),now),[]);
});
test('expiry is driven by original timestamps even when refresh is paused or replayed',()=>{
  const state=mergeFrame(null,old);
  assert.equal(displayedObservations(state,now)[0].previous,false);
  assert.equal(displayedObservations(state,now,true)[0].previous,true);
  assert.equal(displayedObservations(state,now+15000)[0].previous,true);
  assert.equal(displayedObservations(state,now+90000)[0].previous,true);
  assert.deepEqual(displayedObservations(state,now+269000),[]);
});

test('retains the latest source observation and stable position through partial ranking and a sparse full scan',()=>{
  const first=mergeFrame(null,old);
  const mixed=mergeFrame(first,frame(now,false,[{...row('older-path',now-32000),gap:99},{...row('b',now-9,'DEX'),gap:22}]));
  assert.deepEqual(displayedObservations(mixed,now).map(r=>[r.id,r.previous]),[['a',true],['b',false]]);
  const next=mergeFrame(mixed,frame(now,true,[row('replacement',now-3)],2));
  const result=displayedObservations(next,now);
  assert.deepEqual(result.map(r=>[r.id,r.previous]),[['b',true],['replacement',false]]);
  assert.equal(result[1].displayKey,first.displayRows[0].displayKey);
});

test('an affirmative newer suspension clears the exact route and suppresses delayed alternate-source replays',()=>{
  const start=mergeFrame(null,old),blocked={...row('a',now),networkAt:now-100,diagnosis:{code:'deposit_closed'}};
  const empty={...frame(now,false,[]),diagnosticGaps:[blocked]};
  const closed=mergeFrame(start,empty);
  assert.deepEqual(displayedObservations(closed,now).map(r=>r.id),['b']);
  const replay=mergeFrame(closed,{...frame(now,true,[row('a',now-101)],2),previous:old});
  assert.deepEqual(displayedObservations(combineObservationBooks(replay,start),now).map(r=>r.id),['b']);
  const reopened=mergeFrame(replay,frame(now+10,true,[row('a',now+8)]));
  assert.equal(displayedObservations(reopened,now+10).find(r=>r.id==='a').previous,false);
});

test('fallback supplements missing rows without making them current or reverting newer source times',()=>{
  const relay=mergeFrame(null,frame(now,false,[row('pc',now-4)]));
  const cloud=mergeFrame(null,frame(now,false,[row('other',now-9),row('dex',now-2,'DEX')]));
  assert.deepEqual(combineObservationBooks(relay,cloud).displayRows.map(r=>[r.id,r.previous]),[['pc',false],['dex',true]]);
  assert.deepEqual(combineObservationBooks(cloud,relay).displayRows.map(r=>[r.id,r.previous]),[['pc',true],['dex',false]]);
  assert.equal(combineObservationBooks(relay,mergeFrame(null,{...old,budget:300})),relay);
});

test('session cache restores display only, using source timestamps, exact config, and a bounded lifetime',()=>{
  const input={...row('a',now-30),diagnosis:{code:'pending'},wallet:'sensitive',profit:42};
  const book=mergeFrame(null,frame(now,true,[input]));
  const cache=observationCache(book,now);
  assert.equal(cache.rows[0].wallet,undefined);
  assert.equal(cache.rows[0].diagnosis,undefined);
  assert.equal(cache.rows[0].profit,undefined);
  const restored=restoreObservationCache(JSON.parse(JSON.stringify(cache)),old,now+1000);
  assert.deepEqual(displayedObservations(restored,now+1000).map(r=>[r.time,r.previous]),[[now-30,true]]);
  assert.equal(restoreObservationCache(cache,{...old,maxImpact:2},now),null);
  assert.equal(restoreObservationCache(cache,old,now+300000),null);
  assert.equal(mergeFrame(restored,frame(now+2000,false,[])).displayRows[0].previous,true);
});

test('newer matching failure or suspension withholds previously confirmed route from the qualified board',()=>{
  const candidate={...row('id',now-1000),buyQuoteAt:now-2000,sellQuoteAt:now-2000,verifiedAt:now-1000,expires:now+40000};
  const snapshot={...old,rows:[candidate]};
  const suspension={...candidate,networkAt:now-100,diagnosis:{code:'deposit_closed'}};
  const book={...frame(now-500,false,[]),diagnosticGaps:[suspension]};
  assert.equal(currentQualifiedRows(snapshot,book,now).length,0);
  assert.equal(currentQualifiedRows(snapshot,{...book,budget:500},now).length,1);
  assert.equal(currentQualifiedRows(snapshot,{...book,diagnosticGaps:[{...suspension,networkAt:now-3000}]},now).length,1);
  const failed={...candidate,cycle:book.startedAt,checkedAt:now-10,status:'unconfirmed'};
  assert.equal(currentQualifiedRows(snapshot,{...book,diagnosticGaps:[],routeChecks:[failed]},now).length,0);
  assert.equal(currentQualifiedRows(snapshot,{...book,diagnosticGaps:[],routeChecks:[{...failed,match:{chain:56,token}}]},now).length,1);
});

test('a sparse next frame or source fallback cannot restore executable status after a known suspension or failed recheck',()=>{
  const base={...row('path',now-100),buyQuoteAt:now-1000,sellQuoteAt:now-1000,verifiedAt:now-100,expires:now+40000};
  const snapshot={...old,rows:[base]};
  const stop={...base,networkAt:now-300,diagnosis:{code:'withdraw_closed'}};
  const first=mergeFrame(null,{...frame(now-500,false,[],300),diagnosticGaps:[stop]});
  const next=mergeFrame(first,frame(now,false,[])), alternate=mergeFrame(null,old);
  assert.deepEqual(currentQualifiedRows(snapshot,combineObservationBooks(alternate,next),now),[]);
  const updated={...snapshot,rows:[{...base,buyQuoteAt:now-50,sellQuoteAt:now-50,verifiedAt:now-10}]};
  assert.equal(currentQualifiedRows(updated,next,now).length,1);
  const checked={...base,cycle:now,status:'unconfirmed',checkedAt:now+1};
  const failed=mergeFrame(next,{...frame(now,true,[],4),routeChecks:[checked]});
  const later=mergeFrame(failed,frame(now+5,false,[]));
  assert.deepEqual(currentQualifiedRows(updated,later,now+6),[]);
  assert.equal(currentQualifiedRows({...updated,rows:[{...updated.rows[0],verifiedAt:now+5}]},later,now+6).length,1);
});

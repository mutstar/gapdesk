import test from 'node:test';
import assert from 'node:assert/strict';
import {currentQualifiedRows,displayedObservations,mergeFrame} from '../lib/observation-window.mjs';
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
  assert.deepEqual(displayedObservations(closed,now+3),[]);
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
  assert.deepEqual(displayedObservations(state,now+90000),[]);
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

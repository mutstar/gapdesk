import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {logSignals,signalHistory,InvalidSignalQuery} from '../lib/signal-store.ts';

const start=1700000000000,marketIds=['bitget:ACE','kucoin:ACE'];
const gap={id:marketIds.join('|'),symbol:'ACE',buy:'Bitget',sell:'KuCoin',ask:1,bid:1.1,gap:10,blocked:null};
const frame=(i,changes={})=>({startedAt:start+i*30000,at:start+i*30000+5000,
  budget:1000,floor:5,maxImpact:1,signalGaps:[gap],signalMarketIds:marketIds,...changes});
function setup(t){
  const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
  sqlite.exec(readFileSync(new URL('../drizzle/0000_serious_lorna_dane.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../drizzle/0001_naive_magik.sql',import.meta.url),'utf8'));
  const db={
    prepare(sql){return {sql,args:[],bind(...args){return {sql,args}}}},
    async batch(jobs){
      sqlite.exec('BEGIN');
      try{
        const rows=jobs.map(({sql,args})=>({results:sqlite.prepare(sql).all(...args)}));
        sqlite.exec('COMMIT');return rows;
      }catch(e){sqlite.exec('ROLLBACK');throw e}
    }
  };
  return {log:data=>logSignals(data,db),history:(params={},now=start+300000)=>signalHistory(new URLSearchParams(params),db,now)};
}
test('gap first/last marks, exact verification cycle and duplicate/out-of-order revisions',async t=>{
  const {log,history}=setup(t);
  const first=frame(0),second=frame(1,{signalGaps:[{...gap,gap:17,bid:1.17}]});
  await log(first);await log(second);
  await log(frame(1,{entryChecks:[{id:gap.id,cycle:second.startedAt,status:'passed',checkedAt:second.at+1000,profit:10}]}));
  let [row]=(await history({},second.at+2000)).items;
  assert.equal(row.status,'unchecked');assert.equal(row.latestGap,17);
  await log(frame(0,{entryChecks:[{id:gap.id,cycle:first.startedAt,status:'passed',checkedAt:first.at+46000,profit:7}]}));
  assert.equal((await history({},second.at+2000)).items[0].status,'unchecked');
  const enriched=frame(0,{entryChecks:[{id:gap.id,cycle:first.startedAt,status:'passed',checkedAt:first.at+42000,profit:7}]});
  await log(enriched);await log(enriched);
  assert.equal((await history({},first.at+50000)).historyStartedAt,first.at);
  const [verified]=(await history({},first.at+50000)).items;
  assert.equal(verified.openedAt,first.at);assert.equal(verified.entryGap,10);assert.equal(verified.latestGap,17);
  assert.equal(verified.lastSeen,second.at);assert.equal(verified.status,'passed');assert.equal(verified.profit,7);
  await log(frame(2,{signalGaps:[]}));
  await log(frame(3,{signalGaps:[{...gap,blocked:'입금 중단'}]}));
  await log(first);
  const rows=(await history({symbol:'ace',venue:'Bitget'},frame(3).at)).items;
  assert.deepEqual(rows.map(r=>[r.state,r.status]),[['active','blocked'],['closed','passed']]);
  assert.equal(rows[0].reason,'입금 중단');
});
test('market outages, gatherer gaps and budget changes split episodes and preserve historical assumptions',async t=>{
  const {log,history}=setup(t);
  await log(frame(0));await log(frame(1,{signalGaps:[],signalMarketIds:marketIds.slice(0,1)}));await log(frame(2));
  await log(frame(4));await log(frame(5,{budget:2500}));
  const at=frame(5).at;
  const rows=(await history({},at)).items;
  assert.deepEqual(rows.map(r=>r.state),['active','interrupted','interrupted','interrupted']);
  assert.deepEqual(rows.map(r=>r.budget),[2500,1000,1000,1000]);
  assert.equal((await history({},at+91000)).items[0].state,'interrupted');
});
test('venue spikes are idempotent, date paginated and filtered by symbol and venue',async t=>{
  const {log,history}=setup(t);
  const first=frame(0);
  const one={id:'one',marketId:'venue:ACE',symbol:'ACE',venue:'Bitget',windowSec:30,at:first.at,
    baselineAt:first.at-30000,baselinePrice:1.1,price:1,changePct:-9.09,thresholdPct:5,side:'down',corroborated:false};
  const two={...one,id:'two',venue:'KuCoin',at:first.at+30000,corroborated:true};
  await log({...first,spikes:[one]});await log(frame(1,{spikes:[one,two]}));
  const q={kind:'spikes',symbol:'aCe',limit:'1'};
  const a=await history(q);assert.equal(a.items[0].id,'two');assert.equal(a.items[0].corroborated,true);
  const b=await history({...q,cursor:a.nextCursor});assert.equal(b.items[0].id,'one');assert.equal(b.items[0].corroborated,false);
  assert.equal(b.nextCursor,null);assert.equal((await history({...q,venue:'none'})).items.length,0);
  await assert.rejects(history({...q,venue:'KuCoin',cursor:a.nextCursor}),InvalidSignalQuery);
  await assert.rejects(history({hours:'999'}),InvalidSignalQuery);
});

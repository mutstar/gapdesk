import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {events,v4Networks,v4Swap} from '../lib/pool-event-stream.mjs';
import {solanaActivities} from '../lib/solana-swaps.mjs';
import {openWatchRegistry} from '../lib/watch-registry.mjs';
import {indexedTicks} from '../lib/indexed-swaps.mjs';
import {matchesQualifiedSettings} from '../lib/quote-freshness.mjs';

const net=v4Networks.find(x=>x.chain==='bsc'),pool='0x'+'2'.repeat(64),ace='0xc27a719105a987b4c34116223cae8bd8f4b5def4';
const stable='0x55d398326f99059ff775485246999027b3197955',at=1700000000000;
const metadata=[{chain:'bsc',pool,tokens:[stable,ace],initialized:true,venue:'uniswap'}];
const abi=n=>BigInt.asUintN(256,BigInt(n)).toString(16).padStart(64,'0');
function page(block,time,multipliers){
  return events(net,[{header:{number:block,timestamp:time/1000,hash:'block'+block},
    logs:multipliers.map((m,i)=>({address:net.manager,logIndex:i,topics:[v4Swap,pool,'0x'+abi(1)],
      data:'0x'+[1,-1,BigInt(m)*2n**96n,5,0,0].map(abi).join('')}))}]);
}
function feed(r,p){
  r.commit(p.pools,'block/bsc',p.ticks.at(-1).block,p.ticks);
}
test('each same-block V4 trade survives coalescing, a restart and replay',()=>{
  const dir=mkdtempSync(join(tmpdir(),'swap-spikes-')),file=join(dir,'watch.sqlite');
  let r=openWatchRegistry(file);
  try{
    r.commit(metadata);
    feed(r,page(1,at,[1]));r.close();r=openWatchRegistry(file);
    r.spikes.setAssets([{slug:'bsc',token:ace,symbol:'ACE',decimals:18},{slug:'bsc',token:stable,symbol:'USDT',decimals:18}]);
    const second=page(2,at+12000,[2,1]);
    assert.equal(second.swaps.length,1);assert.equal(second.ticks.length,2);feed(r,second);
    const rows=r.spikes.pending().sort((a,b)=>a.id.localeCompare(b.id));
    assert.deepEqual(rows.map(r=>[r.symbol,r.changePct,r.price,r.side]),[['ACE',-75,0.25,'down'],['ACE',300,1,'up']]);
    assert.equal(rows[1].baselineAt,rows[1].at);
    r.close();r=openWatchRegistry(file);feed(r,second);
    assert.equal(r.spikes.pending().length,2);r.ackSpikes(rows.map(x=>x.id));feed(r,second);
    assert.deepEqual(r.spikes.pending(),[]);
  }finally{r.close();rmSync(dir,{recursive:true,force:true})}
});
test('an unchanged canonical V4 spot carries to the start of the next minute; sparse index trades do not',()=>{
  const r=openWatchRegistry(':memory:');r.commit(metadata);feed(r,page(1,at,[1]));
  feed(r,page(2,at+180000,[2]));
  const [alert]=r.spikes.pending();assert.equal(alert.baselineAt,alert.at-60000);assert.equal(alert.changePct,-75);
  const s=openWatchRegistry(':memory:');s.commit(metadata);
  for(const p of [page(1,at,[1]),page(2,at+61000,[2])])s.commit([],null,null,p.ticks,'index');
  assert.equal(s.spikes.pending().length,0);s.close();r.close();
});
test('trade index replays individual trades in order and ignores a mismatched CA and a repeated page',()=>{
  const entry={chain:'bsc',pool,venue:'uniswap',token0:ace,token1:stable};
  const item=(id,ratio,to=stable)=>({id,type:'trade',attributes:{block_timestamp:new Date(at).toISOString(),
    from_token_address:ace,to_token_address:to,from_token_amount:'1',to_token_amount:ratio}});
  const data={data:[item('c',1),item('b',0.25),item('fake',1,ace),item('a',1)]};
  const {ticks,next}=indexedTicks(entry,data);assert.deepEqual(ticks.map(s=>s.hash),['a','b','c']);
  const r=openWatchRegistry(':memory:');r.commit([],null,null,ticks,'index');
  assert.deepEqual(r.spikes.pending().map(x=>x.changePct).sort((a,b)=>a-b),[-75,300]);
  assert.deepEqual(indexedTicks(entry,data,next).ticks,[]);r.close();
});
test('the Solana decoder retains every same-slot fill in instruction order even when vault direction flips',()=>{
  const a='So11111111111111111111111111111111111111112',b='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const pool='Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE',program='whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
  function transfer(amount){
    const buf=Buffer.alloc(10);buf[0]=12;buf.writeBigUInt64LE(BigInt(amount),1);buf[9]=6;
    let n=BigInt('0x'+buf.toString('hex')),s='';
    while(n){s='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[Number(n%58n)]+s;n/=58n}
    return s;
  }
  const instructions=[];
  for(const [tx,qty] of [100,25,100].entries()){
    const meta={isCommitted:true,transactionIndex:tx};
    instructions.push({...meta,programId:program,d8:'0xf8c69e91e17587c8',instructionAddress:[0],accounts:['','',pool,'','vaultA','','vaultB']});
    for(const [i,[mint,vault,q]] of [[a,'vaultA',1],[b,'vaultB',qty]].entries()){
      const add=i===tx%2;
      instructions.push({...meta,programId:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',d8:'0x0c00000000000000',
        data:transfer(q),instructionAddress:[0,i],accounts:add?['user',mint,vault]:[vault,mint,'user']});
    }
  }
  const page=solanaActivities([{header:{number:90,timestamp:at/1000},instructions:instructions.reverse()}]);
  assert.equal(page.trades.length,1);assert.equal(page.ticks.length,3);
  const r=openWatchRegistry(':memory:');r.commit(page.pools,'sol',90,page.ticks);
  assert.deepEqual(r.spikes.pending().map(x=>x.changePct).sort((x,y)=>x-y),[-75,300]);r.close();
});
test('execution rows require matching amount and impact settings, live quotes and a positive net profit meeting the floor',()=>{
  const row={budget:1000,maxImpact:1,profit:1,buyQuoteAt:at,sellQuoteAt:at,expires:at+30000};
  const valid=r=>matchesQualifiedSettings(r,1000,1,1,at);
  assert.equal(valid(row),true);
  for(const change of [{budget:100},{profit:0.99},{maxImpact:2},{buyQuoteAt:at-45000},{expires:at},{profit:Infinity}])assert.equal(valid({...row,...change}),false);
  assert.equal(valid({side:'down',changePct:-75}),false);
});

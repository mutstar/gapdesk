import test from 'node:test';
import assert from 'node:assert/strict';
import {spotPairs,ingestSpotTrades} from '../lib/hypercore-trades.mjs';
import {ledgerCloses} from '../lib/xrpl-book-closes.mjs';
import {openWatchRegistry} from '../lib/watch-registry.mjs';
test('HyperCore spot feeds use native token IDs and replay same-time fills once',()=>{
  const pairs=spotPairs({tokens:[{index:0,name:'USD',tokenId:'0x'+'0'.repeat(32)},{index:1,name:'BASE',tokenId:'0x'+'1'.repeat(32)}],
    universe:[{tokens:[1,0],index:0,name:'BASE/USD'}]});
  const reg=openWatchRegistry(':memory:'),pair=pairs.get('BASE/USD');
  try{
    const events=[{tid:5,time:1700000000000,px:2,sz:4},{tid:3,time:1700000000000,px:1,sz:3}];
    ingestSpotTrades(reg,pair,events);ingestSpotTrades(reg,pair,events);
    assert.deepEqual(reg.cursor('hypercore/trades/spot/0').ids,[5,3]);
    assert.equal(reg.spikes.pending().length,1);
  }finally{reg.close()}
});
test('XRPL commits order-book closes separately from per-swap receipts',()=>{
  const reg=openWatchRegistry(':memory:');
  const row={validated:true,ledger_index:33,ledger_hash:'A'.repeat(64),ledger_time:800000000,changes:[{currency_a:'XRP_drops',currency_b:'issuer/USD',volume_a:'123',volume_b:'10',close:'12.3'}]};
  try{
    const ticks=ledgerCloses(row,33);
    assert.deepEqual(ticks[0].tokens,['issuer/USD','XRP_drops']);
    reg.commit([],null,null,ticks,'ledger-close');
    assert.deepEqual(reg.spikes.receipts(),[]);
    assert.throws(()=>ledgerCloses({...row,validated:false},33));
  }finally{reg.close()}
});

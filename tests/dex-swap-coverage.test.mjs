import test from 'node:test';
import assert from 'node:assert/strict';
import {openWatchRegistry} from '../lib/watch-registry.mjs';
import {dexSwapCoverage} from '../lib/dex-swap-coverage.mjs';
import {stellarPage} from '../lib/stellar-ledger-trades.mjs';
import {tronAddress} from '../lib/chain-log-rpcs.mjs';

test('the 61-venue directory distinguishes confirmed chain fills from initialization and price indexes',()=>{
  const reg=openWatchRegistry(':memory:');
  try{
    const sample={chain:'bsc',pool:'test',venue:'uniswap',protocol:'v4',time:1700000000000,block:20,seq:0,rawRatio:4};
    reg.commit([],null,null,[{...sample,seed:true}]);
    reg.commit([],null,null,[{...sample,seq:1}],'index');
    assert.equal(reg.spikes.receipts().length,0);
    reg.commit([],null,null,[{...sample,seq:2}]);
    reg.commit([],null,null,[{...sample,seq:2}]);
    const rows=dexSwapCoverage(reg.spikes.receipts(),[{chain:'sui',venue:'cetus',processed:10}]);
    assert.equal(new Set(rows.map(r=>r.id)).size,61);
    assert.equal(rows.find(r=>r.id==='uniswap').evidence.length,1);
    assert.equal(rows.find(r=>r.id==='momentum').feeds.length,0);
    assert.equal(rows.find(r=>r.id==='cetus').feeds.length,1);
    assert.equal(rows.find(r=>r.id==='stellarx').mode,'ledger');
  }finally{reg.close()}
});
test('Stellar LP cursor preserves large operation IDs and separate fills on the same ledger',()=>{
  const make=(leg,reverse)=>({paging_token:'281926974774079519-'+leg,trade_type:'liquidity_pool',counter_liquidity_pool_id:'a'.repeat(64),
    base_amount:reverse?'4':'2',counter_amount:reverse?'2':'4',ledger_close_time:'2026-11-24T03:00:00Z',
    [reverse?'counter_asset_type':'base_asset_type']:'native',[reverse?'base_asset_code':'counter_asset_code']:'USDC',
    [reverse?'base_asset_issuer':'counter_asset_issuer']:'G'+'A'.repeat(55)});
  const a=stellarPage([make(0,false)],null),b=stellarPage([make(1,true)],a.cursor);
  assert.equal(a.ticks[0].rawRatio,b.ticks[0].rawRatio);
  assert.equal(b.ticks[0].seq,1);
  assert.throws(()=>stellarPage([make(0,false)],b.cursor),/order/);
  assert.equal(tronAddress('0xa614f803b6fd780986a42c78ec9c7f77e6ded13c'),'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
});

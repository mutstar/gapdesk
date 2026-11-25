import test from 'node:test';
import assert from 'node:assert/strict';
import {exchangeContract,createIdentityCache} from '../lib/exchange-contracts.mjs';
import {currencyIndex,listingContracts} from '../lib/public-currency-feed.mjs';
import {discover} from '../lib/universe.mjs';

const move='0xe4239cd951f6c53d9c41e25270d80d31f925ad1655e5ba5b543843d4a66975ee::SUIP::SUIP';
test('official currency records preserve the full case-sensitive token identity',()=>{
  const result={chain:'sui',token:move};
  assert.deepEqual(exchangeContract('gate','SUINEW',move,'SUIP'),result);
  assert.deepEqual(exchangeContract('kucoin','sui',move,'SUIP'),result);
  assert.equal(exchangeContract('bitget','SUI',move.split('::')[0],'SUIP'),null);
  assert.equal(exchangeContract('kucoin','SUINEW',move,'SUIP'),null);
  assert.equal(exchangeContract('kucoin','sui','','SUIP'),null);
});
test('failed requests retain only same-venue contract identity, and expire',()=>{
  const load=createIdentityCache(),t=Date.now(),id=r=>r.symbol,parse=r=>r.nets;
  const official={chain:'sui',token:move,deposit:true,withdraw:true,depositOpen:true,withdrawOpen:true};
  const rows=[{symbol:'SUIP',nets:[official]}];
  assert.equal(load('gate',rows,id,parse,t,t).bySymbol.get('SUIP')[0].deposit,true);
  const cached=load('gate',[],id,parse,0,t+60000);
  assert.equal(cached.time,t);assert.equal(cached.bySymbol.get('SUIP')[0].deposit,false);
  assert.equal(cached.bySymbol.get('SUIP')[0].withdrawOpen,null);
  assert.equal(load('kucoin',[],id,parse,0,t).bySymbol.size,0);
  assert.equal(load('gate',[],id,parse,0,t+7200000).bySymbol.size,0);
});
test('official supplemental records require the exact spot pair ID',()=>{
  const t=Date.now(),feed={time:t,index:currencyIndex('htx',{data:[{currency:'suip',chains:[{baseChain:'SUI',contractAddress:move}]}]})};
  assert.equal(listingContracts('htx',feed,'SUIP','USDT','suipusdt',t)[0].token,move);
  assert.deepEqual(listingContracts('htx',feed,'SUIP','USDT','suip2usdt',t),[]);
  assert.deepEqual(listingContracts('htx',feed,'SUIP','USDT','suipusdt',t+7200000),[]);
});
test('identified native currencies remain distinct from issued contracts and trade candidates',()=>{
  const btc=exchangeContract('gate','BTC','','BTC');
  const m={id:'gate:BTC_USDT',venue:'gate',name:'Gate.io',kind:'CEX',symbol:'BTC',networks:[btc]};
  const scan=discover([m],1000,1);
  assert.equal(scan.summaries[0].nativeAsset.chain,'bitcoin');assert.equal(scan.summaries[0].match,null);
  assert.equal(scan.candidates.length,0);
});

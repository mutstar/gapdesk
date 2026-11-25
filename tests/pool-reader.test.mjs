import test from 'node:test';
import assert from 'node:assert/strict';
import { poolType, readPools } from '../lib/pool-reader.mjs';
import { CHAINS } from '../lib/assets.js';

const chain = 1, usdc = CHAINS[chain].usdc;
const address = n => '0x' + n.toString(16).padStart(40, '0');
const word = n => BigInt(n).toString(16).padStart(64, '0');
const addressWord = a => a.slice(2).padStart(64, '0');
const asset = (token, decimals, ask = null, time = Date.now()) => ({
  id: 'dex:1:' + token, chain, token, decimals, ask, bid: ask, time, symbol: 'TEST', kind: 'DEX', venue: 'dex',
});
const entry = (pool, token, label = 'v2', quote = usdc) => ({ chain, pool, base: token, quote, dexId: 'uniswap', labels: [label] });
const getWord = (data, n) => Number(BigInt('0x' + data.slice(n, n + 64)));
function mockRpc(headTime, handler) {
  return async (_url, method, params) => {
    if (method === 'eth_getBlockByNumber') return { number: '0xac', timestamp: '0x' + Math.floor(headTime / 1000).toString(16) };
    assert.equal(method, 'eth_call');
    const [call, pinned] = params;
    assert.equal(pinned, '0xac');
    assert.equal(call.to, '0xca11bde05977b3631167028862be2a173976ca11');
    assert.equal(call.data.slice(0, 10), '0x82ad56cb');
    const body = call.data.slice(10), arr = getWord(body, 0) * 2, len = getWord(body, arr);
    const heads = [], payloads = [];
    let offset = 32 * len;
    for (let i = 0; i < len; i++) {
      const start = arr + 64;
      const tuple = start + 2 * getWord(body, start + 64 * i);
      const target = '0x' + body.slice(tuple + 24, tuple + 64);
      assert.equal(getWord(body, tuple + 64), 1);
      const selectorStart = tuple + getWord(body, tuple + 128) * 2;
      const size=getWord(body,selectorStart);
      assert.ok(size===4 || size===36);
      const selector = body.slice(selectorStart + 64, selectorStart + 72);
      const args=body.slice(selectorStart+72,selectorStart+64+size*2);
      const value = handler(target, selector,args);
      const tail = word(value != null ? 1 : 0) + word(64) + word((value || '').length / 2) + (value || '');
      heads.push(word(offset)); payloads.push(tail); offset += tail.length / 2;
    }
    return '0x' + word(32) + word(len) + heads.join('') + payloads.join('');
  };
}

test('full pinned batch handles reversed tokens, 6/18 decimals, V2 reserves and V3 Q96', async () => {
  const now = Date.now(), a = address(1), b = address(2), p = address(101), q = address(102);
  const rpc = mockRpc(now, (target, selector) => {
    if (selector === '313ce567') return word(18);
    // Registry puts stable last while the V2 pool puts stable first.
    if (selector === '0dfe1681') return addressWord(target === p ? usdc : b);
    if (selector === 'd21220a7') return addressWord(target === p ? a : usdc);
    if (selector === '0902f1ac') return word(6000000) + word(3n * 10n ** 18n) + word(10);
    if (selector === '3850c7bd') return word(2n ** 96n / 1000000n) + word(0).repeat(6);
    if (selector === '1a686502') return word(1);
    return null;
  });
  const { markets, coverage } = await readPools([entry(p, a), entry(q, b, 'v3')], [asset(a, null),asset(b, 18)], { rpc, intervalMs: 0 });
  assert.equal(markets.length, 2);
  assert.equal(markets.find(m => m.token === a).ask, 2);
  assert.ok(Math.abs(markets.find(m => m.token === b).ask - 1) < 1e-12);
  assert.equal(markets[0].time, Math.floor(now / 1000) * 1000);
  assert.equal(coverage[0].priced, 2); assert.equal(coverage[0].complete, true);
});

test('an explicit settlement pool supplies a same-block mark and rejects a mismatched conversion',async()=>{
  const a=address(901),counter=address(902),pool=address(903),conversion=address(904);
  const factory='0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f';
  const rpc=mockRpc(Date.now(),(target,selector)=>{
    if(selector==='0dfe1681')return addressWord(target===pool?a:counter);
    if(selector==='d21220a7')return addressWord(target===pool?counter:usdc);
    if(selector==='c45a0155')return addressWord(factory);
    if(selector==='0902f1ac')return word(1000000000)+word(target===pool?2000000000:3000000000)+word(1);
    return null;
  });
  const tracked={...entry(pool,a,'v2',counter),protocol:'v2',settlementPool:conversion};
  const anchor={...entry(conversion,counter),protocol:'v2'};
  const run=async ref=>(await readPools([{...tracked,settlementPool:ref},anchor],[asset(a,6),asset(counter,6,99)],{rpc,intervalMs:0})).markets.find(m=>m.token===a);
  const mark=await run(conversion);
  assert.equal(mark.ask,6);assert.equal(mark.depthBridges[0].block,mark.block);
  assert.equal(await run(address(999)),undefined);
});

test('one missing or wrong pool never suppresses later batches; unsupported curves stay visible in coverage', async () => {
  const a = address(44), p = address(201), q = address(202), unknown = { ...entry(address(203), a), dexId: 'curve' };
  const rpc = mockRpc(Date.now(), (target, selector) => {
    if (selector === '0dfe1681') return addressWord(target === q ? address(55) : a);
    if (selector === 'd21220a7') return addressWord(usdc);
    if (selector === '0902f1ac') return word(100) + word(120) + word(0);
    return null;
  });
  const { markets, coverage: [c] } = await readPools([entry(q, a),unknown,entry(p, a),entry(p, a)], [asset(a, 6)], { rpc, batchSize: 1, intervalMs: 0 });
  assert.deepEqual([c.registered, c.supported, c.attempted, c.read, c.priced, c.complete], [3,2,2,1,1,false]);
  assert.equal(markets[0].ask, 1.2);
  assert.equal(poolType(unknown), null);
});

test('stale blocks and stale conversion references cannot publish fresh prices', async () => {
  const token = address(301), quote = address(302), pool = address(303);
  const stale = Date.now() - 120000;
  const assets = [asset(token, 18), asset(quote, 18, 2, stale)];
  const rpc = t => mockRpc(t, (_target, selector) => {
    if (selector === '0dfe1681') return addressWord(token);
    if (selector === 'd21220a7') return addressWord(quote);
    if (selector === '0902f1ac') return word(10) + word(20) + word(0);
    return null;
  });
  const entries = [entry(pool, token, 'v2', quote)];
  const old = await readPools(entries, assets, { rpc: rpc(stale), intervalMs: 0 });
  assert.equal(old.coverage[0].attempted, 0);
  assert.match(old.coverage[0].error, /stale block/);
  const unpriced = await readPools(entries, assets, { rpc: rpc(Date.now()), intervalMs: 0 });
  assert.equal(unpriced.markets.length, 0);
  assert.equal(unpriced.coverage[0].unpriced, 1);
});

test('cancelled scan cannot imply complete coverage', async () => {
  const x = await readPools([entry(address(401), address(402))], [], { signal: AbortSignal.abort(), rpc: () => assert.fail('should not dispatch') });
  assert.equal(x.coverage[0].attempted, 0);
  assert.equal(x.coverage[0].failed, 1);
  assert.equal(x.coverage[0].complete, false);
});

test('Aerodrome stable invariant uses normalized reserves, including cached pool metadata', async () => {
  const chain = 8453, quote = CHAINS[chain].usdc, token = address(901), pool = address(902);
  const pair = {chain, base:token, quote, pool, dexId:'aerodrome', labels:[]};
  const rpc = mockRpc(Date.now(), (_target, selector) => {
    if (selector === '0dfe1681') return addressWord(quote);
    if (selector === 'd21220a7') return addressWord(token);
    if (selector === '22be3de1') return word(1);
    if (selector === '0902f1ac') return word(2 * 10 ** 6) + word(10n ** 18n) + word(0);
    return null;
  });
  for (let i = 0; i < 2; i++) {
    const {markets} = await readPools([pair], [{...asset(token, 18),chain}], {rpc,intervalMs:0});
    assert.equal(markets.length, 1);
    assert.ok(Math.abs(markets[0].ask - 14 / 13) < 1e-12);
  }
});

test('factory provenance, immutable fees and a signed pinned bitmap are required for wider V3 depth', async () => {
  const p=address(5001),token=address(5002),price='79224201403219477170569942574',factory='0x1f98431c8ad98523631ae4a59f267346ea31f984';
  const e={...entry(p,token,'v3'),protocol:'v3'};
  const calls=[];
  const rpc=mockRpc(Date.now(),(_target,s,args)=>{
    calls.push(s);
    if(s==='0dfe1681') return addressWord(token);
    if(s==='d21220a7') return addressWord(usdc);
    if(s==='c45a0155') return addressWord(factory);
    if(s==='ddca3f43') return word(500);
    if(s==='d0c93a7c') return word(10);
    if(s==='1a686502') return word(1000000000000000n);
    if(s==='3850c7bd') return word(price)+word(BigInt.asUintN(256,-1n))+word(0).repeat(4)+word(1);
    if(s==='5339c296') {assert.equal(args,'f'.repeat(64));return word(0);}
    return null;
  });
  const inputs=[asset(token,6)];
  const [cold]= (await readPools([e],inputs,{rpc,intervalMs:0})).markets;
  assert.equal(cold.depth.tick,-1);assert.equal(cold.depth.bitmap,undefined);
  const [warm]= (await readPools([e],inputs,{rpc,intervalMs:0})).markets;
  assert.equal(warm.depth.wordIndex,-1);
  assert.equal(warm.depth.bitmap,'0x'+word(0));
  assert.equal(calls.filter(s=>s==='ddca3f43').length,1);
  const [indexed]=(await readPools([{...e,protocol:undefined}],inputs,{rpc,intervalMs:0})).markets;
  assert.equal(indexed.depth,undefined);
});

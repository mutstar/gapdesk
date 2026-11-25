import { test } from 'node:test';
import assert from 'node:assert/strict';

const token = n => '0x' + n.toString(16).padStart(40, '0');
const stables = {
  1: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  56: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
  8453: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  42161: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
};
test('catalog keeps all contracts, distinguishes same-ticker assets and observes multiple real pools', async () => {
  const actual = globalThis.fetch;
  const make = (chain, address, symbol = 'ACE', decimals = 6) => ({ chainId: chain, address, symbol, decimals, priceUSD: '2' });
  const pools = [7, 8].map((id, index) => ({ dexId: 'test' + id, chainId: 'bsc', pairAddress: token(id),
    baseToken: { address: token(20) }, quoteToken: { address: stables[56] }, priceUsd: String(4 - index), priceNative: String(2 - index / 2) }));
  const batches = [];
  globalThis.fetch = async path => {
    const u = new URL(path);
    if (u.pathname.endsWith('/tokens')) {
      const chain = Number(u.searchParams.get('chains'));
      const sample = Array.from({ length: 36 }, (_, i) => make(chain, token(100 + i), 'T' + i));
      return Response.json({ tokens: { [chain]: [make(chain, stables[chain], 'USDC'), make(chain, token(11)), ...sample] } });
    }
    if (u.pathname.endsWith('/token')) return Response.json(make(56, token(20), 'ACE', 9));
    if (u.pathname.includes('/token-pairs/')) return Response.json(u.pathname.includes(token(20)) ? pools : []);
    batches.push(u.pathname);
    return Response.json(u.pathname.includes(token(20)) ? pools.slice(0,1) : []);
  };
  try {
    const { loadDex } = await import('../lib/dex-catalog.mjs?fixture=one');
    const cex = [
      { symbol: 'ACE', ask: 3, bid: 2, networks: [{ chain: 56, token: token(20), decimals: 2 }, { chain: 8453, token: token(30), decimals: 2 }] },
    ];
    const first = await loadDex(cex);
    assert.ok(first.markets.some(m=>m.chain===56&&m.referenceOnly&&m.symbol==='MLTP'&&m.token==='0xf390fb7d16f2cbba037c1fc48862463116a7e545'));
    assert.equal(first.poolCoverage.contracts, 4 * 38 + 2 + 1);
    const asset = first.markets.find(m => m.chain === 56 && m.token === token(20) && !m.pool);
    const linked = first.markets.find(m => m.chain === 8453 && m.token === token(30));
    const unrelated = first.markets.find(m => m.chain === 1 && m.token === token(11));
    assert.equal(asset.identity, linked.identity);
    assert.notEqual(asset.identity, unrelated.identity);
    assert.equal(asset.decimals, 9);
    assert.equal(asset.ask, null);
    assert.equal(linked.decimals, null);
    const actualPools = first.markets.filter(m => m.chain === 56 && m.token === token(20) && m.pool);
    assert.equal(new Set(actualPools.map(m => m.id)).size, 2);
    assert.ok(actualPools.every(m => m.identity === asset.identity && m.decimals === 9));
    assert.deepEqual(actualPools.map(m=>m.bid).sort(), [1.5, 2]);
    const before = batches.slice(0, 4);
    batches.length = 0;
    await loadDex(cex, first.nextCursor);
    assert.notDeepEqual(before, batches.slice(0,4));
  } finally { globalThis.fetch = actual; }
});

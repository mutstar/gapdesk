import test from 'node:test';
import assert from 'node:assert/strict';
import { kucoinPerpMarkets, loadKucoinPerps } from '../lib/kucoin-perps.mjs';

const now = 1795413000000;
const contract = {
  type: 'FFWCSX', symbol: 'XBTUSDTM', baseCurrency: 'XBT', quoteCurrency: 'USDT', settleCurrency: 'USDT',
  assetClass: 'CRYPTO', status: 'Open', marketStage: 'NORMAL', isInverse: false, expireDate: null, settleDate: null,
  firstOpenDate: now - 10000, multiplier: 0.001, lotSize: 2, marketMaxOrderQty: 600,
  fundingFeeRate: '-0.0002', currentFundingRateGranularity: 14400000, fundingRateGranularity: 28800000,
  nextFundingRateTime: 60000, nextFundingRateDateTime: now + 60000, markPrice: 60000, openInterest: '500',
  takerFeeRate: '0.0006', takerFixFee: 0
};
const ticker = {
  symbol: 'XBTUSDTM', price: 55000, bestBidPrice: '60001', bestAskPrice: '60002',
  bestBidSize: '250', bestAskSize: '10', ts: String(BigInt(now - 100) * 1000000n)
};
const normalize = (spec = {}, quote = {}) => kucoinPerpMarkets([{ ...contract, ...spec }], [{ ...ticker, ...quote }], now);

test('KuCoin converts contract counts and order limits into base units while preserving book prices', () => {
  const [m] = normalize();
  assert.equal(m.symbol, 'BTC');
  assert.equal(m.kind, 'PERP');
  assert.equal(m.time, now - 100);
  assert.deepEqual([m.ask, m.bid, m.askSize, m.bidSize], [60002, 60001, 0.01, 0.25]);
  assert.deepEqual([m.step, m.minQty, m.maxQty], [0.002, 0.002, 0.6]);
  assert.deepEqual([m.fundingRate, m.intervalHours, m.nextFundingAt], [-0.0002, 4, now + 60000]);
  assert.equal(m.openInterestUsdt, 30000);
  assert.equal(m.tradeFee, 0.0006);
});

test('KuCoin keeps bundle identity and does not turn missing funding or open interest into zero', () => {
  const [m] = normalize({ symbol: '1000BONKUSDTM', baseCurrency: '1000BONK', fundingFeeRate: '',
    nextFundingRateDateTime: now - 12, openInterest: null }, { symbol: '1000BONKUSDTM' });
  assert.equal(m.symbol, '1000BONK');
  assert.equal(m.fundingRate, null);
  assert.equal(m.openInterestUsdt, null);
  assert.equal(m.nextFundingAt, null);
});

test('KuCoin excludes delivery, inverse, premkt, equity, and pre-opening contracts', () => {
  for (const spec of [{ expireDate: now + 30000 }, { settleDate: now + 30000 }, { isInverse: true },
    { marketStage: 'PRE_MARKET' }, { status: 'Paused' }, { assetClass: 'STOCK' }, { firstOpenDate: now + 500 },
    { type: 'FFICSX' }, { quoteCurrency: 'USDC' }, { settleCurrency: 'XBT' }, { multiplier: 0 }]) {
    assert.deepEqual(normalize(spec), [], JSON.stringify(spec));
  }
});

test('KuCoin rejects stale and invalid BBOs without falling back to last trade', () => {
  for (const quote of [{ ts: (now - 45000) * 1e6 }, { ts: (now + 5100) * 1e6 }, { ts: null },
    { bestBidPrice: 60004 }, { bestAskPrice: '' }, { bestAskSize: 0 }, { symbol: 'UNRELATED' }]) {
    assert.deepEqual(normalize({}, quote), [], JSON.stringify(quote));
  }
});

test('KuCoin fails closed when a public feed fails', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 429 }));
  const { markets, source } = await loadKucoinPerps();
  assert.deepEqual(markets, []);
  assert.equal(source.ok, false);
  assert.match(source.error, /429/);
});

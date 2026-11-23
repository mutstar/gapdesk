import assert from 'node:assert/strict';
import {test} from 'node:test';

const now = Date.now();
function contract(symbol, edits = {}) {
  return {symbol: symbol + 'USDT', baseAsset: symbol, pair: symbol + 'USDT', quoteAsset: 'USDT',
    marginAsset: 'USDT', underlyingType: 'COIN', underlyingSubType: ['Crypto'], status: 'TRADING',
    contractType: 'PERPETUAL', onboardDate: now - 86400000, deliveryDate: now + 86400000,
    orderTypes: ['MARKET'], filters: [
      {filterType: 'LOT_SIZE', minQty: '0.001', maxQty: '1000', stepSize: '0.001'},
      {filterType: 'MARKET_LOT_SIZE', minQty: '0.002', maxQty: '120', stepSize: '0.001'},
      {filterType: 'MIN_NOTIONAL', notional: '5'}
    ], ...edits};
}
async function load(t, {contracts = [contract('BTC')], fxTime = now, edits = {}, schedule = [], indexRows, funding = true} = {}) {
  const {loadBinancePerps, enrichBinanceInterest} = await import('../lib/binance-perps.mjs?test=' + encodeURIComponent(t.name));
  const calls = [];
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input), path = url.pathname, symbol = url.searchParams.get('symbol');
    calls.push(path);
    let payload;
    if (path === '/api/v3/exchangeInfo') payload = {symbols: [{symbol: 'USDCUSDT', status: 'TRADING', isSpotTradingAllowed: true}]};
    else if (path === '/api/v3/ticker/24hr') payload = {symbol: 'USDCUSDT', bidPrice: '0.99', askPrice: '1.01', closeTime: fxTime};
    else if (path.endsWith('/exchangeInfo')) payload = {symbols: contracts};
    else if (path.endsWith('/bookTicker')) payload = contracts.map(c => ({symbol: c.symbol, time: now, bidPrice: '100', askPrice: '101',
      bidQty: '1.2', askQty: '3.6', ...edits[c.symbol]}));
    else if (path.endsWith('/premiumIndex')) payload = funding ? contracts.map(c => ({symbol: c.symbol, time: now,
      lastFundingRate: '-0.0003', markPrice: '100', nextFundingTime: now + 3600000})) : [];
    else if (path.endsWith('/openInterest')) payload = {symbol, time: now, openInterest: '10'};
    else if (path.endsWith('/fundingInfo')) {
      if (schedule === null) return Response.error();
      payload = schedule;
    } else if (path.endsWith('/constituents')) payload = {symbol, time: now, constituents: indexRows ?? []};
    else throw Error('Unknown URL ' + url);
    return Response.json(payload);
  });
  const result = await loadBinancePerps();
  return {result, calls, loadBinancePerps, enrichBinanceInterest};
}

test('Binance uses USDT L1 sides, venue FX, order-size filters, signed funding and direct index constituents', async t => {
  const {result} = await load(t, {schedule: [{symbol: 'BTCUSDT', fundingIntervalHours: 4}], indexRows: [
    {exchange: 'kucoin', symbol: 'BTC-USDT', price: '100', weight: '0.2'},
    {exchange: 'bitget', symbol: 'BTCUSDT', price: '100', weight: '0.3'},
    {exchange: 'bitget', symbol: 'BTCUSDT*100', price: '100', weight: '0.1'},
    {exchange: 'kucoin', symbol: 'DOGE-USDT', price: '100', weight: '0.1'}
  ]});
  assert.equal(result.source.ok, true);
  assert.deepEqual(result.fx, {bid: 0.99, ask: 1.01, time: now});
  const [m] = result.markets;
  assert.deepEqual([m.ask,m.bid,m.askSize,m.bidSize,m.step,m.minQty,m.maxQty,m.minNotional],
    [101,100,3.6,1.2,0.001,0.002,120,5]);
  assert.deepEqual([m.time,m.fundingRate,m.intervalHours,m.nextFundingAt], [now,-0.0003,4,now+3600000]);
  assert.deepEqual(m.spotAnchorIds, ['kucoin:BTC-USDT','bitget:BTCUSDT']);
});

test('Binance rejects inactive, non-crypto, bundled, stale or crossed markets and rate-limits index reads', async t => {
  const contracts = [...Array.from({length: 12}, (_, i) => contract('COIN' + i)),
    contract('1000SHIB'), contract('1MBABYDOGE'), contract('INDEX', {underlyingType:'INDEX'}),
    contract('PAUSE', {status:'SETTLING'}), contract('DATED', {contractType:'CURRENT_QUARTER'}),
    contract('CROSS'), contract('STALE'), contract('TSLA', {underlyingSubType:['Stock']})];
  const {result, calls, loadBinancePerps} = await load(t, {contracts, funding:false, schedule:null,
    edits: {STALEUSDT: {time: now - 46000}, CROSSUSDT: {bidPrice:'120'}}});
  assert.equal(result.source.count, 12);
  assert.ok(result.markets.every(m => /^COIN\d+$/.test(m.symbol) && m.fundingRate === null && m.intervalHours === null));
  await loadBinancePerps();
  assert.equal(calls.filter(path => path.endsWith('/constituents')).length, 8);
});
test('Binance stale conversion fails closed without assuming dollar parity', async t => {
  const {result} = await load(t, {fxTime: now-46000});
  assert.equal(result.source.ok, false);
  assert.deepEqual(result.markets, []);
  assert.equal(result.fx,null);
});
test('Binance enriches at most eight ranked OI markets and shares results across repeated legs and scans', async t => {
  const contracts = Array.from({length: 10}, (_, i) => contract('COIN' + i));
  const {result, calls, enrichBinanceInterest} = await load(t, {contracts});
  const rows = result.markets.map(m => ({time: now, buy: {...m}, sell: {kind: 'CEX'}}));
  rows.push({...rows[0], buy: {...rows[0].buy}});
  const stale = {time: now-46000, buy: {...rows[0].buy}, sell: {kind: 'CEX'}};
  rows.unshift(stale);
  await enrichBinanceInterest(rows);
  await enrichBinanceInterest(rows);
  assert.equal(calls.filter(path => path.endsWith('/openInterest')).length,8);
  assert.deepEqual(rows.map(r => r.buy.openInterestUsdt), [null, ...Array(8).fill(1000), null, null, 1000]);
});

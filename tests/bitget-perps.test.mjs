import test from 'node:test';
import assert from 'node:assert/strict';
import {loadBitgetPerps} from '../lib/bitget-perps.mjs';
import {createBitgetAnchorLookup} from '../lib/perp-index-anchors.mjs';

function fixtures() {
  const now = Date.now();
  const c = {symbol: 'ETHUSDT', baseCoin: 'ETH', quoteCoin: 'USDT', supportMarginCoins: ['USDT'],
    symbolType: 'perpetual', symbolStatus: 'normal', isRwa: 'NO', sizeMultiplier: '0.01',
    minTradeNum: '0.02', minTradeUSDT: '5', takerFeeRate: '0.0006', fundInterval: '8'};
  const t = {symbol: c.symbol, ts: now, askPr: '3000.2', bidPr: '3000.1', askSz: '0.05',
    bidSz: '0.21', markPrice: '3000', holdingAmount: '50000', fundingRate: '0.0001'};
  const f = {symbol: c.symbol, fundingRate: '-0.0002', fundingRateInterval: '4', nextUpdate: now + 3600000};
  return {now, c, t, f};
}

function api(contracts, tickers, funding, now = Date.now()) {
  const lists = {contracts, tickers, 'current-fund-rate': funding};
  return async url => {
    const endpoint = new URL(url).pathname.split('/').pop();
    const rows = lists[endpoint];
    if (rows === null) throw Error('피드 중단');
    return {ok: true, json: async () => ({code: '00000', requestTime: now, data: rows})};
  };
}

test('Bitget linear perps retain base quantity, decimal funding and mark-valued OI', async () => {
  const {c, t, f} = fixtures();
  const {markets: [m], source} = await loadBitgetPerps(api([c], [t], [f]));
  assert.equal(source.ok, true);
  assert.equal(m.symbol, 'ETH');
  assert.equal(m.contract, 'ETHUSDT');
  assert.equal(m.ask, 3000.2);
  assert.equal(m.bidSize, 0.21);
  assert.equal(m.askSize, 0.05);
  assert.equal(m.minQty, 0.02);
  assert.equal(m.minNotional, 5);
  assert.equal(m.step, 0.01);
  assert.equal(m.intervalHours, 4);
  assert.equal(m.fundingRate, -0.0002);
  assert.equal(m.nextFundingAt, f.nextUpdate);
  assert.equal(m.openInterestUsdt, 150000000);
});

test('excludes delivery, suspended, RWA, bundled symbols and stale or crossed quotes', async () => {
  const {now, c, t} = fixtures();
  const symbols = ['1INCH', 'INACTIVE', 'DELIVERY', 'EQUITY', '1000BONK', '1MCHEEMS', 'OLD', 'CROSSED'];
  const contracts = symbols.map(baseCoin => ({...c, symbol: baseCoin + 'USDT', baseCoin}));
  contracts[1].symbolStatus = 'maintain';
  contracts[2].symbolType = 'delivery';
  contracts[3].isRwa = 'YES';
  const tickers = contracts.map(({symbol}) => ({...t, symbol}));
  tickers[6].ts = now - 46000;
  tickers[7].bidPr = 4000;
  const {markets} = await loadBitgetPerps(api(contracts, tickers, null));
  assert.deepEqual(markets.map(m => m.symbol), ['1INCH']);
  assert.equal(markets[0].fundingRate, 0.0001);
  assert.equal(markets[0].nextFundingAt, null);
});

test('does not fabricate sizes, funding or OI when the funding schedule is stale', async () => {
  const {now, c, t, f} = fixtures();
  const [{fundingRate, nextFundingAt, openInterestUsdt, askSize}] = (await loadBitgetPerps(
    api([c], [{...t, fundingRate: '', holdingAmount: null, askSz: ''}], [f], now - 60000))).markets;
  assert.deepEqual([fundingRate, nextFundingAt, openInterestUsdt, askSize], [null, null, null, null]);
  assert.equal((await loadBitgetPerps(api(null, [t], []))).source.ok, false);
});

test('index anchors require an explicitly named spot pair and a current matching contract response', async () => {
  const make = symbol => ({symbol,contract:symbol+'USDT'});
  const markets = ['IDE','EMPTY','STALE','WRONG'].map(make);
  const positive = {weight:'0.1',equivalentPrice:'3.2'};
  await createBitgetAnchorLookup()(markets, async url => {
    const contract = new URL(url).searchParams.get('symbol');
    const pair = contract.slice(0,-4) + '/USDT';
    const componentList = contract==='EMPTYUSDT' ? [] : [
      {exchange:'BITGET',spotPair:pair,...positive},{exchange:'KUCOIN',spotPair:pair,...positive},
      {exchange:'BITGET_FUTURE',spotPair:pair,...positive},{exchange:'KUCOIN',spotPair:'UNRELATED/USDT',...positive}
    ];
    return Response.json({code:'00000', requestTime:Date.now()-(contract==='STALEUSDT'?60000:0),
      data:{symbol:contract==='WRONGUSDT'?'OTHER':contract, componentList}});
  });
  assert.deepEqual(markets.map(m=>m.spotAnchorIds),[['bitget:IDEUSDT','kucoin:IDE-USDT'],[],[],[]]);
});

test('bounded index refresh visits remaining listings before polling previously queried contracts', async t => {
  const lookup=createBitgetAnchorLookup(),markets=Array.from({length:10},(_,i)=>({symbol:'C'+i,contract:'C'+i+'USDT'}));
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const calls=[];
  const api=async url=>{
    const contract=new URL(url).searchParams.get('symbol');calls.push(contract);
    return Response.json({code:'00000',requestTime:now,data:{symbol:contract,componentList:[
      {exchange:'BITGET_FUTURE',spotPair:contract.slice(0,-4)+'/USDT',weight:'0.1',equivalentPrice:'4'}
    ]}});
  };
  await lookup(markets,api);await lookup(markets,api);assert.equal(calls.length,8);
  now+=30000;await lookup(markets,api);assert.equal(new Set(calls).size,10);assert.equal(calls.length,10);
  assert.ok(markets.every(m=>m.spotAnchorIds.length===0));
});

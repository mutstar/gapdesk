const API = 'https://api-futures.kucoin.com/api/v1';
const VENUE = 'kucoin';
const NAME = 'KuCoin';
const MAX_AGE_MS = 45_000;

function number(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isCryptoPerpetual(contract, now) {
  return contract?.type === 'FFWCSX' && contract.status === 'Open' &&
    contract.marketStage === 'NORMAL' && contract.assetClass === 'CRYPTO' &&
    contract.quoteCurrency === 'USDT' && contract.settleCurrency === 'USDT' &&
    contract.isInverse === false && contract.expireDate == null && contract.settleDate == null &&
    !(number(contract.firstOpenDate) > now) && /^[A-Z0-9]+$/.test(contract.baseCurrency ?? '') &&
    contract.symbol === contract.baseCurrency + 'USDTM';
}

export function kucoinPerpMarkets(contracts, tickers, now) {
  const byContract = new Map(tickers.map(t => [t.symbol, t]));
  const markets = [];
  for (const contract of contracts) {
    if (!isCryptoPerpetual(contract, now)) continue;
    const ticker = byContract.get(contract.symbol);
    if (!ticker) continue;
    // Futures ticker.ts is the exchange timestamp in nanoseconds.
    const time = Math.trunc(number(ticker.ts) / 1e6);
    if (time <= now - MAX_AGE_MS || time > now + 5000) continue;
    const ask = number(ticker.bestAskPrice), bid = number(ticker.bestBidPrice);
    const askContracts = number(ticker.bestAskSize), bidContracts = number(ticker.bestBidSize);
    const multiplier = number(contract.multiplier), lot = number(contract.lotSize);
    if (!(ask >= bid && bid > 0 && askContracts > 0 && bidContracts > 0 && multiplier > 0 && lot > 0)) continue;
    const step = multiplier * lot;
    const maxOrder = number(contract.marketMaxOrderQty);
    const openContracts = number(contract.openInterest), mark = number(contract.markPrice);
    const interval = number(contract.currentFundingRateGranularity) ?? number(contract.fundingRateGranularity);
    const nextTime = number(contract.nextFundingRateDateTime);
    const taker = number(contract.takerFeeRate);
    const fixedFee = number(contract.takerFixFee);
    markets.push({
      id: VENUE + ':perp:' + contract.symbol, venue: VENUE, name: NAME, kind: 'PERP',
      symbol: contract.baseCurrency === 'XBT' ? 'BTC' : contract.baseCurrency,
      contract: contract.symbol, quote: 'USDT', ask, bid, time,
      askSize: askContracts * multiplier, bidSize: bidContracts * multiplier,
      step, minQty: step, maxQty: maxOrder > 0 ? maxOrder * multiplier : null, minNotional: null,
      tradeFee: taker !== null && taker >= 0 && taker < 1 && fixedFee === 0 ? taker : null,
      fundingRate: number(contract.fundingFeeRate),
      intervalHours: interval > 0 ? interval / 3_600_000 : null,
      nextFundingAt: nextTime > now ? nextTime : null,
      openInterestUsdt: openContracts !== null && openContracts >= 0 && mark > 0 ? openContracts * multiplier * mark : null
    });
  }
  return markets;
}

async function rows(path) {
  const response = await fetch(API + path, {
    cache: 'no-store', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('KuCoin HTTP ' + response.status);
  const data = await response.json();
  if (data.code !== '200000' || !Array.isArray(data.data)) throw new Error('KuCoin 선물 피드 오류');
  return data.data;
}

export async function loadKucoinPerps() {
  const source = { id: 'kucoin-perp', venue: VENUE, name: 'KuCoin 선물', ok: false, count: 0, at: Date.now() };
  try {
    const [contracts, tickers] = await Promise.all([rows('/contracts/active'), rows('/allTickers')]);
    const at = Date.now();
    const markets = kucoinPerpMarkets(contracts, tickers, at);
    if (!markets.length) throw new Error('KuCoin 최신 선물 호가 없음');
    return { markets, source: { ...source, ok: true, count: markets.length, at } };
  } catch (error) {
    return { markets: [], source: { ...source, at: Date.now(), error: error.message } };
  }
}

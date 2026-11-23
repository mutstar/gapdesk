const BASE = 'https://api.bitget.com/api/v2/mix/market/';
const AGE_MS = 45_000;
const UNVERIFIED_BUNDLE = /^(?:10{2,}|[1-9]\d*[MK])(?=[A-Z])/u;

function numeric(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function positive(value) {
  const n = numeric(value);
  return n > 0 ? n : null;
}

function current(time, now) {
  return time !== null && time > now - AGE_MS && time <= now + 5000;
}

async function request(path, fetcher) {
  const response = await fetcher(BASE + path + '?productType=USDT-FUTURES', {
    headers: {accept: 'application/json'}, cache: 'no-store', signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw Error('Bitget HTTP ' + response.status);
  const body = await response.json();
  if (body.code !== '00000' || !Array.isArray(body.data)) throw Error('Bitget 선물 응답 오류');
  return body;
}

function openContract(c, now) {
  const symbol = c.baseCoin;
  if (typeof symbol !== 'string' || !symbol || symbol.includes('|') || UNVERIFIED_BUNDLE.test(symbol)) return false;
  if (c.symbol !== symbol + 'USDT' || c.quoteCoin !== 'USDT' || !c.supportMarginCoins?.includes('USDT')) return false;
  if (c.symbolType !== 'perpetual' || c.symbolStatus !== 'normal' || c.isRwa !== 'NO') return false;
  if (positive(c.deliveryTime) || positive(c.launchTime) > now) return false;
  return ![c.offTime, c.limitOpenTime].some(value => positive(value) && Number(value) <= now);
}

export async function loadBitgetPerps(fetcher = fetch) {
  const source = {id: 'bitget-perps', venue: 'bitget', name: 'Bitget', ok: false, count: 0, at: Date.now()};
  try {
    const [contracts, tickers, funding] = await Promise.all([
      request('contracts', fetcher),
      request('tickers', fetcher),
      request('current-fund-rate', fetcher).catch(() => null)
    ]);
    const now = Date.now();
    const tickerMap = new Map(tickers.data.map(row => [row.symbol, row]));
    const fundingRows = current(numeric(funding?.requestTime), now) ? funding.data : [];
    const fundingMap = new Map(fundingRows.map(row => [row.symbol, row]));
    const markets = [];
    for (const c of contracts.data) {
      if (!openContract(c, now)) continue;
      const t = tickerMap.get(c.symbol);
      const time = numeric(t?.ts);
      if (!current(time, now)) continue;
      const ask = positive(t.askPr), bid = positive(t.bidPr);
      const askSize = positive(t.askSz), bidSize = positive(t.bidSz);
      const step = positive(c.sizeMultiplier), minQty = positive(c.minTradeNum);
      if (!ask || !bid || ask < bid || !step || !minQty || (!askSize && !bidSize)) continue;
      const rate = fundingMap.get(c.symbol);
      const next = positive(rate?.nextUpdate);
      const mark = positive(t.markPrice);
      const holdings = numeric(t.holdingAmount);
      const fee = numeric(c.takerFeeRate);
      markets.push({
        id: 'bitget:perp:' + c.symbol, venue: 'bitget', name: 'Bitget', kind: 'PERP',
        symbol: c.baseCoin, contract: c.symbol, quote: 'USDT', ask, bid, time, askSize, bidSize,
        step, minQty, minNotional: positive(c.minTradeUSDT), maxQty: positive(c.maxMarketOrderQty),
        tradeFee: fee !== null && fee >= 0 && fee < 1 ? fee : null,
        fundingRate: numeric(rate?.fundingRate) ?? numeric(t.fundingRate),
        intervalHours: positive(rate?.fundingRateInterval) ?? positive(c.fundInterval),
        nextFundingAt: next > now ? next : null,
        openInterestUsdt: holdings !== null && holdings >= 0 && mark ? holdings * mark : null
      });
    }
    return {markets, source: {...source, ok: markets.length > 0, count: markets.length, at: now}};
  } catch (error) {
    return {markets: [], source: {...source, error: String(error.message ?? error)}};
  }
}

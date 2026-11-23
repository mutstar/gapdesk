const FUTURES = 'https://fapi.binance.com/fapi/v1';
const SPOT = 'https://data-api.binance.vision/api/v3';
const FX_PAIR = 'USDCUSDT';
const bundle = /^(?:10+|[1-9]\d*[KMB])(?=\p{L})/u;
const anchors = new Map();
const metadata = new Map();
const valuations = new Map();
const interests = new Map();
let interestRequestTimes = [];
let nextAnchorBatch = 0;

function numeric(value) {
  if (value == null || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function fresh(time, now, maxAge = 45000) {
  return Number.isSafeInteger(time) && time <= now + 5000 && now - time < maxAge;
}
async function json(url, ttl = 0, timeout = 6000) {
  const cached = metadata.get(url);
  if (cached && Date.now() < cached.expires) return cached.value;
  const response = await fetch(url, {cache: 'no-store', signal: AbortSignal.timeout(timeout)});
  if (!response.ok) throw Error('Binance HTTP ' + response.status);
  const value = await response.json();
  if (ttl) metadata.set(url, {value, expires: Date.now() + ttl});
  return value;
}
function cryptoContract(c, now) {
  return c?.status === 'TRADING' && c.contractType === 'PERPETUAL' && c.underlyingType === 'COIN' &&
    c.underlyingSubType?.includes('Crypto') && c.quoteAsset === 'USDT' && c.marginAsset === 'USDT' &&
    c.orderTypes?.includes('MARKET') && c.onboardDate <= now && c.deliveryDate > now &&
    typeof c.baseAsset === 'string' && /^[\p{L}\p{N}]+$/u.test(c.baseAsset) && !bundle.test(c.baseAsset) &&
    c.symbol === c.baseAsset + 'USDT' && c.pair === c.symbol;
}
function anchorIds(contract, body, now) {
  if (body?.symbol !== contract || !fresh(numeric(body.time), now, 20 * 60000)) return [];
  const ids = [];
  for (const entry of body.constituents ?? []) {
    if (!(numeric(entry.weight) > 0) || !(numeric(entry.price) > 0)) continue;
    if (entry.exchange === 'bitget' && entry.symbol === contract ||
        entry.exchange === 'kucoin' && entry.symbol === contract.slice(0, -4) + '-USDT') {
      ids.push(entry.exchange + ':' + entry.symbol);
    }
  }
  return [...new Set(ids)];
}
// Index membership verifies the exact spot listing behind a futures contract. Collect
// a small tranche per refresh; markets without a confirmed anchor stay unmatched.
async function collectAnchors(markets) {
  const now = Date.now();
  if (now >= nextAnchorBatch) {
    nextAnchorBatch = now + 29000;
    const pending = markets.filter(m => (anchors.get(m.contract)?.expires ?? 0) <= now).slice(0, 8);
    await Promise.all(pending.map(async ({contract}) => {
      try {
        const body = await json(FUTURES + '/constituents?symbol=' + encodeURIComponent(contract), 0, 2200);
        anchors.set(contract, {ids: anchorIds(contract, body, Date.now()), expires: now + 3600000});
      } catch {
        anchors.set(contract, {ids: [], expires: now + 300000});
      }
    }));
  }
  for (const m of markets) {
    const entry = anchors.get(m.contract);
    m.spotAnchorIds = entry && entry.expires > now ? entry.ids : [];
  }
}

export async function loadBinancePerps() {
  const source = {id: 'binance-perps', venue: 'binance', name: 'Binance 선물', at: Date.now(), ok: false, count: 0};
  try {
    const [info, books, marks, schedule, fxTicker, fxInfo] = await Promise.all([
      json(FUTURES + '/exchangeInfo', 60000), json(FUTURES + '/ticker/bookTicker'),
      json(FUTURES + '/premiumIndex').catch(() => []), json(FUTURES + '/fundingInfo', 60000).catch(() => null),
      json(SPOT + '/ticker/24hr?symbol=' + FX_PAIR),
      json(SPOT + '/exchangeInfo?symbol=' + FX_PAIR, 60000)
    ]);
    const now = Date.now(), time = numeric(fxTicker.closeTime);
    const ask = numeric(fxTicker.askPrice), bid = numeric(fxTicker.bidPrice);
    const pair = fxInfo?.symbols?.find(p => p.symbol === FX_PAIR && p.status === 'TRADING' && p.isSpotTradingAllowed);
    if (!pair || fxTicker.symbol !== FX_PAIR || !fresh(time, now) || !(bid > 0 && ask >= bid)) {
      throw Error('Binance USDC/USDT 환산 호가 대기');
    }
    const fx = {bid, ask, time};
    const bySymbol = new Map(books.map(t => [t.symbol, t]));
    const premiums = new Map(marks.map(t => [t.symbol, t]));
    const intervals = new Map((schedule ?? []).map(f => [f.symbol, numeric(f.fundingIntervalHours)]));
    const markets = [];
    for (const c of info.symbols) {
      if (!cryptoContract(c, now)) continue;
      const filters = new Map(c.filters.map(f => [f.filterType, f]));
      const restriction = filters.get('POSITION_RISK_CONTROL')?.positionControlSide;
      if (restriction && restriction !== 'NONE') continue;
      const lot = filters.get('MARKET_LOT_SIZE'), baseLot = filters.get('LOT_SIZE');
      const minNotional = numeric(filters.get('MIN_NOTIONAL')?.notional);
      const minQty = Math.max(Number(lot?.minQty), Number(baseLot?.minQty));
      const maxQty = Math.min(Number(lot?.maxQty), Number(baseLot?.maxQty));
      const steps = [Number(lot?.stepSize), Number(baseLot?.stepSize)];
      const step = Math.max(...steps);
      if (!(minQty > 0 && maxQty >= minQty && step > 0 && minNotional > 0) ||
          !steps.every(s => s === 0 || s > 0 && Math.abs(step / s - Math.round(step / s)) < 1e-8)) continue;
      const ticker = bySymbol.get(c.symbol), time = numeric(ticker?.time);
      if (!fresh(time, now)) continue;
      const ask = numeric(ticker.askPrice), bid = numeric(ticker.bidPrice);
      const askSize = numeric(ticker.askQty), bidSize = numeric(ticker.bidQty);
      if (!(bid > 0 && ask >= bid && (askSize > 0 || bidSize > 0))) continue;
      const premium = premiums.get(c.symbol);
      const rate = fresh(numeric(premium?.time), now) ? premium : null;
      if (rate && numeric(rate.markPrice) > 0) {
        valuations.set(c.symbol, {price: Number(rate.markPrice), time: Number(rate.time)});
      }
      const interval = intervals.get(c.symbol);
      markets.push({id: 'binance:perp:' + c.symbol, venue: 'binance', name: 'Binance', kind: 'PERP',
        symbol: c.baseAsset, contract: c.symbol, quote: 'USDT', ask, bid, time, askSize, bidSize,
        step, minQty, maxQty, minNotional, tradeFee: null, openInterestUsdt: null, spotAnchorIds: [],
        fundingRate: numeric(rate?.lastFundingRate), nextFundingAt: rate?.nextFundingTime > now ? rate.nextFundingTime : null,
        intervalHours: interval > 0 ? interval : Array.isArray(schedule) && !intervals.has(c.symbol) ? 8 : null});
    }
    await collectAnchors(markets);
    return {markets, fx, source: {...source, count: markets.length, ok: markets.length > 0, at: Date.now()}};
  } catch (error) {
    return {markets: [], fx: null, source: {...source, error: String(error?.message ?? error)}};
  }
}

// Binance publishes OI per instrument, in base units. Fetch it only for visible
// leaders and value it at an exchange-time-matched mark. Failed reads share the cap.
export async function enrichBinanceInterest(rows) {
  const now = Date.now(), legs = new Map();
  for (const row of rows) {
    if (!fresh(row.time, now)) continue;
    for (const leg of [row.buy, row.sell]) {
      if (leg?.kind !== 'PERP' || leg.id !== 'binance:perp:' + leg.contract) continue;
      const mark = valuations.get(leg.contract);
      if (!mark || !fresh(mark.time, now) || Math.abs(mark.time - row.time) > 30000) continue;
      if (!legs.has(leg.contract)) {
        if (legs.size === 8) continue;
        legs.set(leg.contract, []);
      }
      legs.get(leg.contract).push({leg, rowTime: row.time});
    }
  }
  interestRequestTimes = interestRequestTimes.filter(at => now - at < 30000);
  await Promise.all([...legs].map(async ([contract, updates]) => {
    let cached = interests.get(contract);
    if (!cached || now - cached.at >= 30000) {
      if (interestRequestTimes.length >= 8) return;
      interestRequestTimes.push(now);
      const response = json(FUTURES + '/openInterest?symbol=' + encodeURIComponent(contract), 0, 1300)
        .catch(() => null);
      cached = {at: now, response};
      interests.set(contract, cached);
    }
    const interest = await cached.response;
    const time = numeric(interest?.time), quantity = numeric(interest?.openInterest);
    const mark = valuations.get(contract), at = Date.now();
    if (interest?.symbol !== contract || !fresh(time, at) || quantity === null || quantity < 0 ||
        !fresh(mark.time, at) || Math.abs(mark.time - time) > 30000) return;
    const usdt = quantity * mark.price;
    if (!Number.isFinite(usdt)) return;
    for (const {leg, rowTime} of updates) {
      if (fresh(rowTime, at) && Math.abs(time - rowTime) <= 30000) leg.openInterestUsdt = usdt;
    }
  }));
}

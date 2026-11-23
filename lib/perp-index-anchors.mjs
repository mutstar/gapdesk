const endpoint = 'https://api.bitget.com/api/v3/market/index-components?symbol=';

// Spot pairs are explicit members of the futures index. The similarly named
// BITGET_FUTURE constituent refers to a derivative and cannot establish a CA.
async function indexSpotIds(market, fetcher) {
  const response = await fetcher(endpoint + encodeURIComponent(market.contract), {
    headers: {accept: 'application/json'}, cache: 'no-store', signal: AbortSignal.timeout(2200)
  });
  if (!response.ok) throw Error('Bitget index HTTP ' + response.status);
  const body = await response.json();
  const age = Date.now() - Number(body.requestTime);
  if (body.code !== '00000' || body.data?.symbol !== market.contract ||
      !Number.isFinite(age) || age < -5000 || age >= 45000 || !Array.isArray(body.data.componentList)) return [];
  const ids = new Set();
  for (const entry of body.data.componentList) {
    if (entry.spotPair !== market.symbol + '/USDT' || !(Number(entry.weight) > 0 && Number(entry.equivalentPrice) > 0)) continue;
    if (entry.exchange === 'BITGET') ids.add('bitget:' + entry.spotPair.replace('/', ''));
    if (entry.exchange === 'KUCOIN') ids.add('kucoin:' + entry.spotPair.replace('/', '-'));
  }
  return [...ids];
}

export function createBitgetAnchorLookup() {
  const cache = new Map();
  let lastContract = '', nextBatch = 0;
  return async function attach(markets, fetcher) {
    const now = Date.now();
    if (markets.length && now >= nextBatch) {
      nextBatch = now + 30000;
      const pending = markets.filter(m => !(cache.get(m.contract)?.expires > now))
        .sort((a,b) => a.contract.localeCompare(b.contract));
      const split = pending.findIndex(m => m.contract.localeCompare(lastContract) > 0);
      const rotated = split < 1 ? pending : [...pending.slice(split), ...pending.slice(0,split)];
      const batch = rotated.slice(0,8);
      if (batch.length) lastContract = batch.at(-1).contract;
      await Promise.all(batch.map(async m => {
        try {
          const ids = await indexSpotIds(m, fetcher);
          cache.set(m.contract, {ids, expires: now + 3600000});
        } catch {
          cache.set(m.contract, {ids: [], expires: now + 300000});
        }
      }));
    }
    for (const m of markets) {
      const entry = cache.get(m.contract);
      m.spotAnchorIds = entry?.expires > Date.now() ? entry.ids : [];
    }
  };
}

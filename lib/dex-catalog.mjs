import { NATIVE } from './assets.js';

const networks = [
  { chain: 1, slug: 'ethereum', name: 'Ethereum', stable: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
  { chain: 56, slug: 'bsc', name: 'BNB Chain', stable: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d' },
  { chain: 8453, slug: 'base', name: 'Base', stable: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
  { chain: 42161, slug: 'arbitrum', name: 'Arbitrum', stable: '0xaf88d065e77c8cc2239327c5edb3a432268e5831' },
];
const byId = new Map(networks.map(n => [n.chain, n]));
const addressPattern = /^0x[0-9a-f]{40}$/;
const catalogCache = new Map();
const poolCache = new Map();
const extraDecimals = new Map();
const PRICE_LIFETIME = 90_000;
const CATALOG_INTERVAL = 55_000;
const CATALOG_MAX_AGE = 12 * 3600_000;
const BATCH_SIZE = 30;
const ROTATION_BATCHES = 4;

const key = (chain, token) => chain + ':' + token;
function positive(x) { const n = Number(x); return Number.isFinite(n) && n > 0 ? n : null; }
function decimals(x) { return Number.isInteger(x) && x >= 0 && x <= 36 ? x : null; }
async function json(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6500) });
  if (!r.ok) throw Error('HTTP ' + r.status);
  return r.json();
}
async function chainCatalog(n) {
  const old = catalogCache.get(n.chain);
  if (old && Date.now() - old.time < CATALOG_INTERVAL) return { ...old, ok: true };
  try {
    const data = await json('https://li.quest/v1/tokens?chains=' + n.chain);
    const tokens = data.tokens?.[n.chain];
    if (!Array.isArray(tokens) || !tokens.length) throw Error('목록 없음');
    const list = [];
    for (const t of tokens) {
      const token = String(t.address).toLowerCase();
      if (Number(t.chainId) !== n.chain || !addressPattern.test(token) || !t.symbol) continue;
      list.push({ token, chain: n.chain, symbol: String(t.symbol), decimals: decimals(t.decimals), usd: positive(t.priceUSD) });
    }
    if (!list.length) throw Error('유효한 컨트랙트 없음');
    const record = { list, time: Date.now() };
    catalogCache.set(n.chain, record);
    return { ...record, ok: true };
  } catch {
    if (old && Date.now() - old.time < CATALOG_MAX_AGE) return { ...old, ok: false };
    return { list: [], time: 0, ok: false };
  }
}

// Currency networks explicitly published together by one exchange identify fungible listings.
// An equal ticker or a repeat contract address on another chain is insufficient.
function aliases(cexMarkets) {
  const edges = new Map(), info = new Map();
  function root(k) {
    while (edges.has(k)) {
      const p = edges.get(k), g = edges.get(p);
      if (g) edges.set(k, g);
      k = p;
    }
    return k;
  }
  function join(a, b) {
    const x = root(a), y = root(b);
    if (x !== y) edges.set(x < y ? y : x, x < y ? x : y);
  }
  join(key(1, NATIVE), key(8453, NATIVE));
  join(key(1, NATIVE), key(42161, NATIVE));
  for (const m of cexMarkets) {
    let first = null;
    for (const n of m.networks ?? []) {
      const chain = Number(n.chain), token = String(n.token).toLowerCase();
      if (!byId.has(chain) || !addressPattern.test(token)) continue;
      if (token === NATIVE && String(m.symbol).toUpperCase() !== (chain === 56 ? 'BNB' : 'ETH')) continue;
      const k = key(chain, token);
      if (first) join(first, k); else first = k;
      const previous = info.get(k) ?? { chain, token, symbol: m.symbol, ask: Infinity, bid: 0 };
      if (m.tradeEnabled !== false && positive(m.ask)) previous.ask = Math.min(previous.ask, Number(m.ask));
      if (m.tradeEnabled !== false && positive(m.bid)) previous.bid = Math.max(previous.bid, Number(m.bid));
      info.set(k, previous);
    }
  }
  return { root, info };
}

function interleaveBatches(markets) {
  const chainBatches = new Map(networks.map(n => [n.chain, []]));
  for (const m of markets) {
    if (m.token === NATIVE) continue;
    const batches = chainBatches.get(m.chain);
    if (!batches.length || batches.at(-1).length === BATCH_SIZE) batches.push([]);
    batches.at(-1).push(m);
  }
  const lengths = [...chainBatches.values()].map(x => x.length);
  const jobs = [];
  for (let i = 0; i < Math.max(...lengths); i++) {
    for (const batches of chainBatches.values()) if (batches[i]) jobs.push(batches[i]);
  }
  return jobs;
}

function readPool(pair, index, observedAt, stablePrices) {
  const chain = networks.find(n => n.slug === pair.chainId)?.chain;
  if (!chain || !pair.pairAddress || !pair.dexId) return [];
  const base = String(pair.baseToken?.address).toLowerCase();
  const quote = String(pair.quoteToken?.address).toLowerCase();
  const pool = String(pair.pairAddress).toLowerCase();
  if (!/^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(pool)) return []; // V4 pool ids can be bytes32
  const price = positive(pair.priceUsd), nativePrice = positive(pair.priceNative);
  const usdPerUSDC = stablePrices.get(chain);
  if (!price || !usdPerUSDC) return [];
  const prices = [[base, price / usdPerUSDC]];
  if (nativePrice) prices.push([quote, price / nativePrice / usdPerUSDC]);
  const result = [];
  for (const [token, mark] of prices) {
    const asset = index.get(key(chain, token));
    if (!asset || !positive(mark)) continue;
    const id = asset.id + ':' + pool;
    result.push({ ...asset, id, name: pair.dexId + ' · ' + byId.get(chain).name, pool,
      dexId: String(pair.dexId), ask: mark, bid: mark, time: observedAt, referenceOnly: false,
      liquidityUSD: positive(pair.liquidity?.usd), reference: 'pool' });
  }
  return result;
}

export async function loadDex(cexMarkets, cursor = 0, targets = []) {
  const { root, info } = aliases(cexMarkets);
  const sources = [], index = new Map(), stablePrices = new Map();
  const current = Math.max(0, Math.trunc(Number(cursor) || 0)) % 1000000000;
  // Keep full (logo-heavy) upstream responses out of memory concurrently.
  for (const n of networks) {
    const data = await chainCatalog(n);
    const fresh = Date.now() - data.time < PRICE_LIFETIME;
    const anchor = fresh ? data.list.find(t => t.token === n.stable)?.usd : null;
    if (anchor) stablePrices.set(n.chain, anchor);
    for (const t of data.list) {
      const k = key(n.chain, t.token);
      const price = anchor && t.usd ? t.usd / anchor : null;
      index.set(k, { id: 'dex:' + k, venue: 'dex', kind: 'DEX', chain: n.chain, token: t.token,
        symbol: t.symbol, decimals: t.decimals, identity: 'chain:' + root(k), name: n.name + ' DEX',
        ask: price, bid: price, time: data.time, referenceOnly: true, reference: 'catalog' });
    }
    sources.push({ id: 'catalog-' + n.chain, name: n.name + ' DEX 목록', ok: data.ok, time: data.time, count: data.list.length });
  }
  for (const [k, n] of info) {
    if (index.has(k)) continue;
    index.set(k, { id: 'dex:' + k, venue: 'dex', kind: 'DEX', chain: n.chain, token: n.token,
      symbol: n.symbol, decimals: n.token === NATIVE ? 18 : (extraDecimals.get(k) ?? null),
      identity: 'chain:' + root(k), name: byId.get(n.chain).name + ' DEX', ask: null, bid: null,
      time: 0, referenceOnly: true, reference: 'exchange-contract' });
  }
  const markets = [...index.values()].sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const jobs = interleaveBatches(markets);
  const firstBatch = jobs.length ? current % jobs.length : 0;
  const fair = Array.from({ length: Math.min(ROTATION_BATCHES, jobs.length) }, (_, i) => jobs[(firstBatch + i) % jobs.length]);
  const ranked = [];
  for (const [k, n] of info) {
    const m = index.get(k);
    if (!m || m.token === NATIVE) continue;
    const prices = [m.ask, n.ask, n.bid].filter(positive);
    if (prices.length < 2) continue;
    const gap = Math.max(...prices) / Math.min(...prices) - 1;
    if (gap > 0) ranked.push({ m, gap });
  }
  ranked.sort((a, b) => b.gap - a.gap);
  const priority = new Map();
  for (const { m } of ranked) {
    if (!priority.has(m.chain)) priority.set(m.chain, []);
    const bucket = priority.get(m.chain);
    if (bucket.length < BATCH_SIZE) bucket.push(m);
  }
  const requests = [];
  const add = (arr, detail) => {
    if (!arr.length) return;
    const slug = byId.get(arr[0].chain).slug, tokens = arr.map(x => x.token).join(',');
    requests.push(json('https://api.dexscreener.com/' + (detail ? 'token-pairs/v1/' : 'tokens/v1/') + slug + '/' + tokens)
      .then(records => {
        if (!Array.isArray(records)) throw Error('풀 목록 미수신');
        const at = Date.now();
        for (const pair of records) for (const p of readPool(pair, index, at, stablePrices)) poolCache.set(p.id, p);
        return { size: arr.length, detail };
      }));
  };
  for (const id of targets.slice(0,2)) {
    const parts=id.split(':');
    if(parts.length===4 && parts[0]==='dex') {
      const asset=index.get(key(Number(parts[1]),parts[2]));
      if(asset) add([asset],true);
    }
  }
  fair.forEach(arr => add(arr, false));
  [...priority.values()].forEach(arr => add(arr, false));
  // Full multi-pool read for the strongest live dislocation AND a fair rotating token.
  if (ranked.length) add([ranked[0].m], true);
  if (jobs.length) {
    const fullCount = jobs.reduce((n, job) => n + job.length, 0);
    const idx = Math.floor(current / ROTATION_BATCHES) % fullCount;
    let left = idx;
    for (const batch of jobs) {
      if (left < batch.length) { add([batch[left]], true); break; }
      left -= batch.length;
    }
  }
  const results = await Promise.allSettled(requests);
  const ok = results.filter(x => x.status === 'fulfilled');
  const asOf = Date.now(), pools = [];
  for (const [id, p] of poolCache) {
    const asset = index.get(key(p.chain, p.token));
    if (asOf - p.time >= PRICE_LIFETIME || !asset) { poolCache.delete(id); continue; }
    pools.push({ ...p, identity: asset.identity, decimals: asset.decimals });
  }
  // LI.FI may route a CEX-listed token absent from its bulk curated directory.
  // Resolve exact token decimals only where an actual fresh pool was observed.
  const missing = new Map();
  for (const p of pools) if (p.decimals === null) missing.set(key(p.chain, p.token), p);
  const missingList = [...missing.values()];
  const picks = [...missingList].sort((a, b) => {
    const score = p => {
      const n = info.get(key(p.chain, p.token));
      if (!n || !positive(p.ask)) return 0;
      const marks = [p.ask, n.ask, n.bid].filter(positive);
      return Math.max(...marks) / Math.min(...marks);
    };
    return score(b) - score(a);
  }).slice(0, 2);
  if (missingList.length) picks.push(missingList[Math.floor(current / ROTATION_BATCHES) % missingList.length]);
  await Promise.all([...new Set(picks)].map(async p => {
    try {
      const t = await json('https://li.quest/v1/token?chain=' + p.chain + '&token=' + p.token);
      if (Number(t.chainId) === p.chain && String(t.address).toLowerCase() === p.token && decimals(t.decimals) !== null) {
        const k = key(p.chain, p.token); extraDecimals.set(k, t.decimals); index.get(k).decimals = t.decimals;
      }
    } catch { /* Missing decimals disqualify executable quotes, not token discovery. */ }
  }));
  for (const p of pools) p.decimals = index.get(key(p.chain, p.token)).decimals;
  sources.push({ id: 'dex-pools', name: 'DEX Screener 풀', ok: ok.length > 0, time: asOf, count: pools.length });
  const scannedContracts = ok.reduce((n, x) => n + x.value.size, 0);
  return { markets: markets.concat(pools), sources, nextCursor: current + ROTATION_BATCHES,
    poolCoverage: { contracts: markets.length, observedPools: new Set(pools.map(p => p.chain + ':' + p.pool)).size,
      requestedBatches: requests.length, receivedBatches: ok.length, scannedContracts, totalBatches: jobs.length,
      rotationBatches: fair.length, rotationStart: firstBatch, observedAt: asOf } };
}

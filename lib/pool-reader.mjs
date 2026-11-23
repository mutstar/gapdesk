// Read-only spot observations. The amount-specific route quote still determines eligibility.
import { CHAINS } from './assets.js';
import { depthFactory } from './pool-depth.mjs';
export { poolFill } from './pool-depth.mjs';

const MULTICALL = '0xca11bde05977b3631167028862be2a173976ca11';
const ADDRESS = /^0x[0-9a-f]{40}$/;
const METHODS = {
  token0: '0dfe1681', token1: 'd21220a7', decimals: '313ce567', reserves: '0902f1ac',
  slot0: '3850c7bd', liquidity: '1a686502', stable: '22be3de1', factory: 'c45a0155', fee: 'ddca3f43', spacing: 'd0c93a7c', bitmap:'5339c296',
};
const metadata = new Map();
const precisions = new Map();
const cooldowns = new Map();
// Canonical quote assets in priority order. Symbols alone cannot identify an anchor.
const quoteAssets = {
  1: ['0xdac17f958d2ee523a2206206994597c13d831ec7','0x6b175474e89094c44da98b954eedeac495271d0f','0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'],
  56: ['0x55d398326f99059ff775485246999027b3197955','0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'],
  8453: ['0x4200000000000000000000000000000000000006'],
  42161: ['0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9','0xff970a61a04b1ca14834a43f5de4533ebddb5cc8','0x82af49447d8a07e3bd95bd0d56f35241523fbab1'],
};
const key = (chain, address) => chain + ':' + address;
const word = n => BigInt(n).toString(16).padStart(64, '0');
const numberAt = (data, offset) => Number(BigInt('0x' + data.slice(offset, offset + 64)));
const validDecimals = n => Number.isInteger(n) && n >= 0 && n <= 36;
const positive = n => Number.isFinite(n) && n > 0;

// Only recognized constant-product / concentrated liquidity deployments use these price formulas.
export function poolType(entry) {
  if (![entry.pool, entry.base, entry.quote].every(s => ADDRESS.test(String(s).toLowerCase()))) return null;
  if (entry.base.toLowerCase() === entry.quote.toLowerCase()) return null;
  const dex = String(entry.dexId).toLowerCase();
  const tags = [dex, ...(Array.isArray(entry.labels) ? entry.labels : [])].join(' ').toLowerCase();
  if (/v4|algebra|infinity|twamm|weighted/.test(tags)) return null;
  if (Number(entry.chain) === 8453 && /^(aerodrome|aero)$/.test(dex)) return 'aerodrome';
  if (/stable/.test(tags)) return null;
  if (entry.protocol === 'v2' || entry.protocol === 'v3') return entry.protocol;
  if (!/^(uniswap|pancakeswap|sushiswap)(?:[-_]?v[23])?$/.test(dex)) return null;
  if (/v3/.test(tags)) return 'v3';
  if (/v2/.test(tags)) return 'v2';
  return 'probe';
}

function encode(calls) {
  const heads = [], bodies = [];
  let offset = calls.length * 32;
  for (const [target, calldata] of calls) {
    heads.push(word(offset));
    const padded = calldata.padEnd(Math.ceil(calldata.length/64)*64,'0');
    bodies.push(target.slice(2).padStart(64, '0') + word(1) + word(96) + word(calldata.length/2) + padded);
    offset += 128 + padded.length/2;
  }
  return '0x82ad56cb' + word(32) + word(calls.length) + heads.join('') + bodies.join('');
}

function decode(hex, count) {
  if (typeof hex !== 'string' || !/^0x[0-9a-f]*$/i.test(hex)) throw Error('invalid Multicall3 response');
  const data = hex.slice(2), array = numberAt(data, 0) * 2;
  if (numberAt(data, array) !== count) throw Error('incomplete Multicall3 response');
  const start = array + 64;
  return Array.from({ length: count }, (_, i) => {
    const tuple = start + 2 * numberAt(data, start + i * 64);
    if (!numberAt(data, tuple)) return '';
    const lengthAt = tuple + 2 * numberAt(data, tuple + 64);
    const length = numberAt(data, lengthAt), end = lengthAt + 64 + length * 2;
    if (!Number.isSafeInteger(end) || end > data.length) throw Error('truncated Multicall3 subcall');
    return data.slice(lengthAt + 64, end);
  });
}

async function rpc(url, method, params, signal) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal,
  });
  if (response.status === 429 || response.status === 503) {
    const retry = response.headers.get('retry-after');
    const until = retry && !Number.isNaN(Number(retry)) ? Date.now() + Number(retry) * 1000 : Date.parse(retry || '');
    cooldowns.set(url, Math.max(Date.now() + 2000, until || 0));
  }
  if (!response.ok) throw Error('RPC HTTP ' + response.status);
  const result = await response.json();
  if (result.error || result.result == null) {
    if (/rate limit|too many requests/i.test(result.error?.message || '')) cooldowns.set(url, Date.now() + 2000);
    throw Error(String(result.error?.message || 'empty RPC result').slice(0, 160));
  }
  return result.result;
}

function pause(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    function abort() { clearTimeout(timer); reject(signal.reason); }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function priceToken(chain, asset, other, ratio, blockTime, options) {
  if (!asset || !positive(ratio)) return null;
  if (other === CHAINS[chain].usdc) return { mark: ratio, time: blockTime };
  const reference = options.assets.get(key(chain, other));
  const now = Date.now();
  if (!reference || !positive(reference.ask) || !positive(reference.bid) || !positive(reference.time) ||
      now - reference.time > options.anchorMaxAgeMs || reference.time > now + 5000) return null;
  const mark = ratio * ((reference.bid + reference.ask) / 2);
  return positive(mark) ? { mark, time: Math.min(reference.time, blockTime) } : null;
}

function planBatch(entries, assets, chain) {
  const calls = [], indices = new Map();
  function add(address, method, argument='') {
    const id = address + method + argument;
    if (!indices.has(id)) {
      indices.set(id, calls.length);
      calls.push([address, METHODS[method]+argument]);
    }
    return indices.get(id);
  }
  const plans = entries.map(entry => {
    const { pool, base, quote } = entry;
    const cached = metadata.get(key(chain, pool));
    // Metadata is immutable for these AMM factories. A changed registry tuple must be revalidated.
    const match = cached && cached.pair === [base, quote].sort().join('/');
    const type = match ? cached.type : poolType(entry);
    const plan = { entry, cached: match ? cached : null, type };
    // Only factory.getPair/getPool discoveries carry protocol. API-provided DEX labels alone aren't evidence.
    const factory = depthFactory(chain,entry.dexId,entry.protocol);
    if (factory && entry.protocol === type) {
      plan.expectedFactory = factory;
      if (plan.cached?.factory !== factory) plan.factory = add(pool,'factory');
      if (type === 'v3' && (!plan.cached?.spacing || !Number.isInteger(plan.cached.fee))) {
        plan.fee = add(pool,'fee'); plan.spacing = add(pool,'spacing');
      }
      if (type === 'v3' && Number.isInteger(plan.cached?.wordIndex)) {
        plan.wordIndex = plan.cached.wordIndex;
        plan.bitmap = add(pool,'bitmap',word(BigInt.asUintN(256,BigInt(plan.wordIndex))));
      }
    }
    if (!match) {
      plan.token0 = add(pool, 'token0'); plan.token1 = add(pool, 'token1');
    }
    if (type !== 'v3') plan.reserves = add(pool, 'reserves');
    if (type === 'aerodrome') plan.stable = add(pool, 'stable');
    if (type === 'aerodrome' || type === 'probe' || type === 'v3') {
      plan.slot0 = add(pool, 'slot0'); plan.liquidity = add(pool, 'liquidity');
    }
    for (const [name, address] of [['base', base], ['quote', quote]]) {
      const id = key(chain, address);
      const known = precisions.get(id) ?? assets.get(id)?.decimals ??
        (address === CHAINS[chain].usdc ? CHAINS[chain].decimals : undefined);
      if (validDecimals(known)) plan[name + 'Decimals'] = known;
      else plan[name + 'Call'] = add(address, 'decimals');
    }
    return plan;
  });
  return { calls, plans };
}

function inspect(plan, results, chain) {
  const { pool, base, quote } = plan.entry;
  const pair = [base, quote].sort().join('/');
  const addressAt = i => /^[0]{24}[0-9a-f]{40}$/i.test(results[i]) ? '0x' + results[i].slice(24).toLowerCase() : null;
  const token0 = plan.cached?.token0 ?? addressAt(plan.token0);
  const token1 = plan.cached?.token1 ?? addressAt(plan.token1);
  if (!token0 || !token1 || [token0, token1].sort().join('/') !== pair) return null;
  for (const [name, token] of [['base', base], ['quote', quote]]) {
    if (validDecimals(plan[name + 'Decimals'])) continue;
    const raw = results[plan[name + 'Call']];
    if (raw?.length !== 64) return null;
    const decimals = numberAt(raw, 0);
    if (!validDecimals(decimals)) return null;
    plan[name + 'Decimals'] = decimals;
    precisions.set(key(chain, token), decimals);
  }
  let ratio, type;
  const reserves = results[plan.reserves], slot0 = results[plan.slot0], liquidity = results[plan.liquidity];
  if (slot0?.length >= 64 * 6 && liquidity?.length === 64 && numberAt(liquidity, 0) > 0) {
    const sqrt = numberAt(slot0, 0);
    ratio = (sqrt / 2 ** 96) ** 2;
    type = 'v3';
  } else if (reserves?.length === 64 * 3) {
    ratio = numberAt(reserves, 64) / numberAt(reserves, 0);
    type = plan.type === 'aero-stable' ? 'aero-stable' : 'v2';
    if (plan.type === 'aerodrome') {
      const stable = results[plan.stable];
      if (stable !== word(0) && stable !== word(1)) return null;
      if (stable === word(1)) type = 'aero-stable';
    }
  } else return null;
  if (!positive(ratio)) return null;
  const factory = plan.factory != null ? addressAt(plan.factory) : plan.cached?.factory;
  const fee = plan.fee != null && results[plan.fee]?.length === 64 ? numberAt(results[plan.fee],0) : plan.cached?.fee;
  const spacing = plan.spacing != null && results[plan.spacing]?.length === 64 ? numberAt(results[plan.spacing],0) : plan.cached?.spacing;
  const meta={pair,type,token0,token1,factory,fee,spacing};
  metadata.set(key(chain, pool), meta);
  if (factory && factory === plan.expectedFactory && type === plan.entry.protocol) {
    const raw = (data, index=0) => BigInt('0x'+data.slice(index*64,(index+1)*64));
    const state = {chain,pool,dexId:plan.entry.dexId,protocol:type,token0,token1,
      decimals0:token0===base?plan.baseDecimals:plan.quoteDecimals,decimals1:token1===base?plan.baseDecimals:plan.quoteDecimals};
    if (type === 'v2') {
      state.feePpm = String(state.dexId).toLowerCase().startsWith('uniswap') ? 3000 : 2500;
      plan.depth = {...state,reserve0:String(raw(reserves)),reserve1:String(raw(reserves,1))};
    } else if (type === 'v3' && Number.isInteger(fee) && fee>=0 && fee<1000000 && Number.isInteger(spacing) && spacing>0 && spacing<=16384) {
      const tick = Number(BigInt.asIntN(24,raw(slot0,1)));
      if (slot0.length>=64*7 && Math.abs(tick)<=887272 && raw(slot0,6)===1n) {
        plan.depth = {...state,feePpm:fee,tickSpacing:spacing,tick,sqrtPriceX96:String(raw(slot0)),liquidity:String(raw(liquidity))};
        meta.wordIndex=Math.floor(tick/spacing/256);
        if (meta.wordIndex===plan.wordIndex && results[plan.bitmap]?.length===64)
          Object.assign(plan.depth,{wordIndex:meta.wordIndex,bitmap:'0x'+results[plan.bitmap]});
      }
    }
  }
  const human = (token0 === base ? ratio : 1 / ratio) * 10 ** (plan.baseDecimals - plan.quoteDecimals);
  if (!positive(human)) return null;
  if (type !== 'aero-stable') return human;
  // Marginal exchange rate on x^3*y + x*y^3 = k, x/y in human units.
  const r = human <= 1 ? human : 1 / human;
  const derivative = r * (3 + r * r) / (1 + 3 * r * r);
  return human <= 1 ? derivative : 1 / derivative;
}

async function readChain(chain, entries, options, markets) {
  const coverage = { chain, registered: entries.length, supported: 0, attempted: 0, read: 0, priced: 0,
    failed: 0, unpriced: 0, depthPools: 0, usdcDepthPools: 0, block: null, time: 0, complete: false, error: null };
  const jobs = [];
  for (const entry of entries) {
    if (poolType(entry)) jobs.push({ ...entry, pool: entry.pool.toLowerCase(), base: entry.base.toLowerCase(), quote: entry.quote.toLowerCase() });
  }
  coverage.supported = jobs.length;
  if (!jobs.length) { coverage.complete = entries.length === 0; return coverage; }
  // A USDC settlement pool can arrive before or after the dependent token pool.
  // Both are from this chain's pinned block. Re-emit the dependent when its route changes.
  const bridges = new Map(), dependents = new Map();
  function publish(batch) {
    const changed = new Set(batch), newAnchors = new Set();
    markets.push(...batch);
    for (const market of batch) {
      if (!market.depth) continue;
      coverage.depthPools++;
      const other = market.token === market.depth.token0 ? market.depth.token1 : market.depth.token0;
      if (other === CHAINS[chain].usdc) {
        coverage.usdcDepthPools++;
        bridges.set(market.token, [...(bridges.get(market.token) ?? []), market.depth]);
        newAnchors.add(market.token);
      } else {
        if (!dependents.has(other)) dependents.set(other, []);
        dependents.get(other).push(market);
        market.depthBridges = bridges.get(other) ?? [];
        if (market.depthBridges.length) coverage.usdcDepthPools++;
      }
    }
    for (const anchor of newAnchors) {
      for (const dependent of dependents.get(anchor) ?? []) {
        if (!dependent.depthBridges.length) coverage.usdcDepthPools++;
        dependent.depthBridges = bridges.get(anchor);
        changed.add(dependent);
      }
    }
    if (changed.size) options.onMarkets?.(Array.from(changed, market => market.depthBridges ? {...market} : market));
  }
  const url = options.rpcs?.[chain] ?? CHAINS[chain].rpc;
  let nextRequest = 0;
  async function reserveRequest() {
    const now = Date.now(), start = Math.max(now, nextRequest, cooldowns.get(url) || 0);
    nextRequest = start + options.intervalMs;
    await pause(start - now, options.signal);
    options.signal.throwIfAborted();
    if ((cooldowns.get(url) || 0) > Date.now()) await reserveRequest();
  }
  try {
    await reserveRequest();
    const head = await options.rpc(url, 'eth_getBlockByNumber', ['latest', false], options.signal);
    if (!/^0x[0-9a-f]+$/i.test(head.number) || !/^0x[0-9a-f]+$/i.test(head.timestamp)) throw Error('invalid block header');
    coverage.block = Number(BigInt(head.number));
    coverage.time = Number(BigInt(head.timestamp)) * 1000;
    if (Date.now() - coverage.time > options.blockMaxAgeMs || coverage.time > Date.now() + 5000) throw Error('stale block');
    let cursor = 0;
    async function lane() {
      while (cursor < jobs.length && !options.signal.aborted) {
        const chunk = jobs.slice(cursor, cursor += options.batchSize);
        const { calls, plans } = planBatch(chunk, options.assets, chain);
        try {
          await reserveRequest();
          coverage.attempted += chunk.length;
          const data = await options.rpc(url, 'eth_call', [{ to: MULTICALL, data: encode(calls) }, head.number], options.signal);
          const results = decode(data, calls.length);
          const batch = [];
          for (const plan of plans) {
            const ratio = inspect(plan, results, chain);
            if (!ratio) continue;
            coverage.read++;
            const { base, quote, pool, dexId } = plan.entry;
            const anchors = [CHAINS[chain].usdc, ...quoteAssets[chain]];
            const baseRank = anchors.indexOf(base), quoteRank = anchors.indexOf(quote);
            // When neither side is a preferred anchor retain the registry's base/quote direction.
            const invert = baseRank >= 0 && (quoteRank < 0 || baseRank < quoteRank);
            const token = invert ? quote : base, other = invert ? base : quote;
            const asset = options.assets.get(key(chain, token));
            const quotePrice = priceToken(chain, asset, other, invert ? 1 / ratio : ratio, coverage.time, options);
            if (!quotePrice) continue;
            batch.push({ ...asset, id: asset.id + ':' + pool, name: dexId + ' · ' + CHAINS[chain].name, dexId, pool,
              decimals: invert ? plan.quoteDecimals : plan.baseDecimals, ask: quotePrice.mark, bid: quotePrice.mark,
              time: quotePrice.time, block: coverage.block, blockTime: coverage.time, referenceOnly: false, reference: 'pool',
              ...(plan.depth ? {depth:{...plan.depth,block:coverage.block,time:coverage.time}} : {}) });
            coverage.priced++;
          }
          publish(batch);
        } catch (error) { coverage.error = error.message; }
      }
    }
    await Promise.all(Array.from({ length: options.concurrency }, lane));
    if (options.signal.aborted) coverage.error = 'scan deadline';
  } catch (error) { coverage.error = error.message; }
  coverage.failed = coverage.supported - coverage.read;
  coverage.unpriced = coverage.read - coverage.priced;
  coverage.complete = coverage.registered === coverage.priced;
  return coverage;
}

// One row per pool/token. Each chain's calls use its own pinned head and source timestamp.
export async function readPools(entries, assets, config = {}) {
  const options = {
    rpc, timeoutMs: 23000, blockMaxAgeMs: 45000, anchorMaxAgeMs: 90000, batchSize: 100,
    concurrency: 3, intervalMs: 150, ...config,
  };
  const timeout = AbortSignal.timeout(options.timeoutMs);
  options.signal = config.signal ? AbortSignal.any([config.signal, timeout]) : timeout;
  options.assets = new Map((assets instanceof Map ? [...assets.values()] : assets).map(a => [key(a.chain, a.token.toLowerCase()), a]));
  if (!Number.isInteger(options.batchSize) || options.batchSize <= 0 || !Number.isInteger(options.concurrency) || options.concurrency <= 0) {
    throw Error('invalid RPC batch configuration');
  }
  const markets = [], grouped = new Map(Object.keys(CHAINS).map(id => [Number(id), new Map()]));
  for (const entry of entries) {
    const chain = Number(entry.chain);
    if (grouped.has(chain)) grouped.get(chain).set(String(entry.pool).toLowerCase(), entry);
  }
  const coverage = await Promise.all([...grouped].map(([chain, distinct]) => readChain(chain, [...distinct.values()], options, markets)));
  return { markets, coverage, at: Date.now() };
}

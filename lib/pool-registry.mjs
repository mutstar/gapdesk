import { mkdirSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const slugs = new Map([[1, 'ethereum'], [56, 'bsc'], [8453, 'base'], [42161, 'arbitrum']]);
const address = /^0x[0-9a-f]{40}$/;
const poolAddress = /^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const zero = '0x' + '0'.repeat(40);
const batchSize = 30;
const defaultCache = fileURLToPath(new URL('../.sites-runtime/pool-registry-v1.json', import.meta.url));
const lower = value => String(value ?? '').toLowerCase();
const key = (chain, token) => chain + ':' + token;

function poolEntry(chain, pair, tokens, now) {
  const pool = lower(pair.pairAddress), base = lower(pair.baseToken?.address), quote = lower(pair.quoteToken?.address);
  if (pair.chainId !== slugs.get(chain) || !poolAddress.test(pool) || !address.test(base) || !address.test(quote) ||
      base === quote || !(tokens.has(base) || tokens.has(quote)) || typeof pair.dexId !== 'string' || !pair.dexId) return;
  const liquidityUSD = Number(pair.liquidity?.usd);
  return { chain, pool, dexId: pair.dexId, base, quote, labels: Array.isArray(pair.labels) ? pair.labels.filter(x => typeof x === 'string') : [],
    liquidityUSD: liquidityUSD > 0 && Number.isFinite(liquidityUSD) ? liquidityUSD : null, lastSeen: now };
}

async function fetchBatch(chain, tokens, detail) {
  const resource = detail ? 'token-pairs/v1/' : 'tokens/v1/';
  const url = 'https://api.dexscreener.com/' + resource + slugs.get(chain) + '/' + tokens.join(',');
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5500) });
  if (!res.ok) {
    const err = new Error('DEX Screener HTTP ' + res.status);
    const retry = Number(res.headers.get('retry-after'));
    if (res.status === 429) err.backoffMs = retry > 0 ? retry * 1000 : 60_000;
    throw err;
  }
  const rows = await res.json();
  if (!Array.isArray(rows)) throw Error('Invalid DEX Screener pool response');
  return rows;
}

function batchesByChain(universe, eligible) {
  const jobs = [];
  const lists = [...slugs.keys()].map(chain => [chain, []]);
  const addresses = new Map(lists);
  for (const [id, {chain, token}] of universe) if (eligible(id)) addresses.get(chain).push(token);
  for (let i = 0; lists.some(([, list]) => i < list.length); i += batchSize) {
    for (const [chain, list] of lists) if (list.length > i) jobs.push({ chain, tokens: list.slice(i, i + batchSize) });
  }
  return jobs;
}

// PC collector only. The cache contains public pool metadata and discovery timestamps.
export function createPoolRegistry({ cacheFile = defaultCache, request = fetchBatch, intervalMs = 1200,
    refreshMs = 60 * 60_000, detailRefreshMs = 24 * 3600_000, detailLimit = 24, now = Date.now } = {}) {
  let checked = new Map(), detailChecked = new Map(), pools = new Map(), universe = new Map(), failed = new Map();
  let running = null, backoffUntil = 0, diskError = false, detailsAllowed = true;
  try {
    const saved = JSON.parse(readFileSync(cacheFile, 'utf8'));
    if (saved.version === 1) {
      checked = new Map(saved.checked);
      detailChecked = new Map(saved.detailChecked ?? []);
      pools = new Map(saved.pools.map(p => [key(p.chain, p.pool), p]));
    }
  } catch { /* A missing or invalid cache is rebuilt by the next discovery pass. */ }

  async function persist() {
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      const tmp = cacheFile + '.' + process.pid + '.tmp';
      await writeFile(tmp, JSON.stringify({ version: 1, checked: [...checked], detailChecked: [...detailChecked], pools: [...pools.values()] }));
      await rename(tmp, cacheFile);
      diskError = false;
    } catch { diskError = true; }
  }

  function snapshot() {
    const t = now(), entries = [], withPool = new Set();
    let checkedContracts = 0, detailContracts = 0;
    for (const id of universe.keys()) {
      if (t - (checked.get(id) ?? -Infinity) < refreshMs) checkedContracts++;
      if (t - (detailChecked.get(id) ?? -Infinity) < detailRefreshMs) detailContracts++;
    }
    for (const [id, p] of pools) {
      if (t - p.lastSeen >= Math.max(refreshMs, detailRefreshMs) * 2) { pools.delete(id); continue; }
      const base = key(p.chain, p.base), quote = key(p.chain, p.quote);
      if (!universe.has(base) && !universe.has(quote)) continue;
      entries.push(p);
      if (universe.has(base)) withPool.add(base);
      if (universe.has(quote)) withPool.add(quote);
    }
    return { entries, coverage: { contracts: universe.size, checkedContracts, detailContracts, contractsWithPools: withPool.size,
      registeredPools: entries.length, failedContracts: [...failed.keys()].filter(k => universe.has(k)).length,
      running: !!running, cacheWritable: !diskError } };
  }

  async function discover(jobs) {
    const active = new Set();
    let completed = 0, lastSave = 0;
    async function run({chain, tokens, detail = false}) {
      try {
        const rows = await request(chain, tokens, detail), t = now(), requested = new Set(tokens);
        for (const pair of rows) {
          const p = poolEntry(chain, pair, requested, t);
          if (p) pools.set(key(chain, p.pool), p);
        }
        for (const token of tokens) {
          const id = key(chain, token);
          checked.set(id, t);
          if (detail) detailChecked.set(id, t);
          failed.delete(id);
        }
      } catch (err) {
        const t = now();
        if (err?.backoffMs) backoffUntil = Math.max(backoffUntil, t + err.backoffMs);
        for (const token of tokens) failed.set(key(chain, token), t + Math.max(30_000, err?.backoffMs || 0));
      }
      completed++;
    }
    for (const job of jobs) {
      if (active.size >= 4) await Promise.race(active);
      if (backoffUntil > now() || (job.detail && !detailsAllowed)) break;
      const task = run(job).finally(() => active.delete(task));
      active.add(task);
      if (completed - lastSave >= 24) {
        lastSave = completed;
        await persist();
      }
      if (intervalMs) await delay(intervalMs);
    }
    await Promise.all(active);
    await persist();
  }

  function start(markets, { allowDetails = true } = {}) {
    detailsAllowed = allowDetails;
    universe = new Map();
    for (const m of markets) {
      const chain = Number(m.chain), token = lower(m.token);
      if (slugs.has(chain) && address.test(token) && token !== zero) universe.set(key(chain, token), { chain, token });
    }
    const t = now();
    for (const [id, at] of checked) if (!universe.has(id) && t - at > detailRefreshMs * 2) checked.delete(id);
    for (const [id, at] of detailChecked) if (!universe.has(id) && t - at > detailRefreshMs * 2) detailChecked.delete(id);
    for (const [id, retryAt] of failed) if (!universe.has(id) && t > retryAt) failed.delete(id);
    if (!running && t >= backoffUntil) {
      const jobs = batchesByChain(universe, id => t - (checked.get(id) ?? -Infinity) >= refreshMs && (failed.get(id) ?? 0) <= t);
      // Bulk token responses can omit alternative venues. Between catalog sweeps,
      // enumerate each address's token-pairs endpoint in a resumable round robin.
      if (!jobs.length && detailLimit && allowDetails) {
        const due = [...universe.keys()].filter(id => t - (detailChecked.get(id) ?? -Infinity) >= detailRefreshMs && (failed.get(id) ?? 0) <= t);
        due.sort((a,b) => (detailChecked.get(a) ?? 0) - (detailChecked.get(b) ?? 0));
        for (const id of due.slice(0, detailLimit)) {
          const { chain, token } = universe.get(id);
          jobs.push({ chain, tokens: [token], detail: true });
        }
      }
      if (jobs.length) running = discover(jobs).finally(() => { running = null; });
    }
    return snapshot();
  }
  return { start, snapshot, idle: () => running ?? Promise.resolve() };
}

let collectorRegistry;
export function startRegistry(markets, options) {
  collectorRegistry ??= createPoolRegistry();
  return collectorRegistry.start(markets, options);
}

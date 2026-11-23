// Owner-private read-only data producer. Its launcher passes the Site credential on stdin.
import {gzipSync} from 'node:zlib';
import {setTimeout as sleep} from 'node:timers/promises';
import {poolValuationAssets} from '../lib/pool-anchors.mjs';
import {prepareScan} from '../lib/universe.mjs';
import {readIndexedPools} from '../lib/indexed-pools.mjs';
import {poolType,readPools} from '../lib/pool-reader.mjs';
import {startFactoryRegistry} from '../lib/factory-registry.mjs';
import {startRegistry} from '../lib/pool-registry.mjs';

const site = new URL('https://dokdo-gapdesk.awakeant23.chatgpt.site');
const interval = 30_000;
let service = '';
for await (const part of process.stdin) service += part.toString();
service = service.trim();
if (!service) throw Error('Missing Site credential on stdin');

async function siteFetch(path, options = {}) {
  const url = new URL(path, site);
  if (url.origin !== site.origin) throw Error('Origin mismatch');
  const response = await fetch(url, {...options, redirect:'error', signal:AbortSignal.timeout(9000),
    headers:{...options.headers, 'OAI-Sites-Authorization':'Bearer ' + service}});
  if (response.status === 401 || response.status === 403) throw Error('access-expired');
  if (!response.ok) throw Error('Site HTTP ' + response.status);
  return response.json();
}

let current, cursor = '', poolCursor = 0, checking = false, stopped = false;
let pending, publishing = false;
const qualified = new Map();
let retryWithIndex = new Set(), allowDetails = true;
const poolKey = p => p.chain + ':' + p.pool;
function failed(error) {
  if (error.message === 'access-expired') stopped = true;
  console.error(new Date().toISOString(), error.message);
}
// A slow upload cannot delay the market clock. Keep only the newest waiting revision.
async function publish(snapshot) {
  pending = {...snapshot,rows:[...qualified.values()].filter(r => r.expires > Date.now()).sort((a,b) => b.profit-a.profit)};
  if (publishing) return;
  publishing = true;
  try {
    while (pending && !stopped) {
      const update = pending;
      pending = null;
      try {
        await siteFetch('/api/relay', {method:'POST', headers:{'content-type':'application/gzip'},
          body:gzipSync(JSON.stringify(update),{level:3})});
      } catch (error) { failed(error); }
    }
  } finally { publishing = false; }
}
async function tick(slot) {
  const {amount:budget,min:floor,maxImpact=1} = await siteFetch('/api/settings');
  if (!Number.isFinite(budget) || !Number.isFinite(floor)) throw Error('Invalid monitor settings');
  const poolPass = async (markets,cex) => {
    const valuation = poolValuationAssets(markets,cex);
    const index = startRegistry(markets,{allowDetails});
    const factories = startFactoryRegistry(markets);
    const known = new Map(index.entries.map(p => [poolKey(p),p]));
    for (const p of factories.entries) {
      const k = poolKey(p), listed = known.get(k);
      known.set(k,listed ? {...listed,protocol:p.protocol} : p);
    }
    const entries = [...known.values()];
    const registry = {...index.coverage,registeredPools:entries.length,factories:factories.coverage};
    const remaining = slot + interval - Date.now() - 2300;
    const options = {timeoutMs:Math.max(1,Math.min(24000,remaining))};
    const indexedEntries = index.entries.filter(p => !poolType(p) || retryWithIndex.has(poolKey(p)));
    const [chain, indexed] = await Promise.all([
      readPools(entries, valuation, {...options,anchorMaxAgeMs:45000}),
      readIndexedPools(indexedEntries, valuation, options),
    ]);
    allowDetails = indexed.coverage.every(c => c.attempted === c.registered && !c.error) && chain.coverage.every(c => c.attempted === c.supported);
    const chainPriced = new Set(chain.markets.map(poolKey));
    retryWithIndex = new Set(entries.filter(p => poolType(p) && !chainPriced.has(poolKey(p))).map(poolKey));
    const combined = new Map(indexed.markets.map(p => [poolKey(p), p]));
    for (const p of chain.markets) combined.set(poolKey(p), p);
    return {markets:[...combined.values()],coverage:chain.coverage,indexedReads:indexed.coverage,
      registry:{...registry,pricedPools:combined.size,pricedContracts:new Set([...combined.values()].map(p=>p.chain+':'+p.token)).size}};
  };
  const {snapshot,verify} = await prepareScan({budget,floor,maxImpact,cursor,poolCursor,limit:10,startedAt:slot,poolPass});
  const sameConfig = current?.budget === budget && current?.floor === floor && current?.maxImpact === maxImpact;
  if (!sameConfig) qualified.clear();
  const eligible = new Set(snapshot.eligible);
  for (const [id,row] of qualified) if (!eligible.has(id) || row.expires <= Date.now()) qualified.delete(id);
  const batch = snapshot.attempted;
  current = Object.assign(snapshot, {floor,intervalMs:interval,tested:0,attempted:[],verificationPending:!checking && batch.length>0});
  poolCursor = current.poolCursor;
  void publish(current);
  if (checking || !batch.length) return;
  checking = true;
  cursor = current.nextCursor;
  try {
    const origin = current;
    void verify().then(rows => {
      if (current.budget !== budget || current.floor !== floor || current.maxImpact !== maxImpact) return;
      const possible = new Set(current.eligible);
      for (const id of batch) qualified.delete(id);
      for (const row of rows) if (possible.has(row.id) && row.expires > Date.now()) qualified.set(row.id,row);
      if (current === origin) Object.assign(current,{tested:batch.length,attempted:batch,verificationPending:false});
      void publish(current);
    }).catch(failed).finally(() => {checking=false;});
  } catch (error) {checking=false;throw error;}
}
while (!stopped) {
  const slot = Math.floor(Date.now()/interval)*interval;
  try { await tick(slot); } catch (error) { failed(error); }
  if (!stopped) await sleep(Math.max(0,(Math.max(slot,Math.floor(Date.now()/interval)*interval) + interval) - Date.now()));
}

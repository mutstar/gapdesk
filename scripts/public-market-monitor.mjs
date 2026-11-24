// Owner-private read-only data producer. Its launcher passes the Site credential on stdin.
import {fileURLToPath} from 'node:url';
import {createSpikeTracker} from '../lib/venue-spikes.mjs';
import {createSignalOutbox} from '../lib/signal-outbox.mjs';
import {observationFrame,sameSettings} from '../lib/observation-window.mjs';
import {isFreshQualified,matchesQualifiedSettings} from '../lib/quote-freshness.mjs';
import {gzipSync} from 'node:zlib';
import {setTimeout as sleep} from 'node:timers/promises';
import {poolValuationAssets} from '../lib/pool-anchors.mjs';
import {prepareScan} from '../lib/universe.mjs';
import {createIndexedPoolReader,readIndexedPools} from '../lib/indexed-pools.mjs';
import {recentV4Pools} from '../lib/v4-discovery.mjs';
import {readWideFiles,wideMarkets} from '../lib/wide-markets.mjs';
import {poolType,readPools} from '../lib/pool-reader.mjs';
import {startFactoryRegistry} from '../lib/factory-registry.mjs';
import {startRegistry} from '../lib/pool-registry.mjs';
import {dexVenues,networks} from '../lib/dex-venues.mjs';
import {mkdirSync} from 'node:fs';
import {createMoveAlgoStreams} from '../lib/move-algo-streams.mjs';
import {createCosmosStarkStreams} from '../lib/cosmos-stark-streams.mjs';
import {createMultiversxSwaps} from '../lib/multiversx-swaps.mjs';
import {createMinswapLedger} from '../lib/minswap-ledger.mjs';
import {createXrplBooks} from '../lib/xrpl-book-closes.mjs';
import {createHypercoreTrades} from '../lib/hypercore-trades.mjs';
import {createHydrationArchive} from '../lib/hydration-swap-archive.mjs';
import {createVenueExportStream} from '../lib/venue-export-stream.mjs';
import {createStellarStream} from '../lib/stellar-ledger-trades.mjs';
import {createSolanaWatcher} from '../lib/solana-swaps.mjs';
import {openWatchRegistry} from '../lib/watch-registry.mjs';
import {createEventWatcher} from '../lib/pool-event-stream.mjs';
import {createKeyResolver} from '../lib/v4-pool-keys.mjs';
import {eventPrices} from '../lib/event-prices.mjs';
import {createVenueMonitor} from '../lib/venue-observations.mjs';

const site = new URL('https://dokdo-gapdesk.awakeant23.chatgpt.site');
const interval = 30_000;
mkdirSync(new URL('../.sites-runtime/',import.meta.url),{recursive:true});
const watch=openWatchRegistry(fileURLToPath(new URL('../.sites-runtime/watch-pools.sqlite',import.meta.url)));
const venues=createVenueMonitor({registry:watch});
const eventWatcher=createEventWatcher(watch);
const solanaWatcher=createSolanaWatcher(watch);
const chainReaders=[
  createMoveAlgoStreams(watch),createCosmosStarkStreams(watch),createStellarStream(watch),
  createHypercoreTrades(watch),createHydrationArchive(watch),createVenueExportStream(watch),
  createMultiversxSwaps(watch),createXrplBooks(watch),createMinswapLedger(watch),
];
const resolveKeys=createKeyResolver(watch);
const chainSlug=new Map(Object.entries(networks).map(([slug,id])=>[id,slug]));
const seeded=new Set();
const readNewPools=createIndexedPoolReader({intervalMs:500});
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
const tracker=await createSpikeTracker({cacheFile:fileURLToPath(new URL('../.sites-runtime/venue-baselines.sqlite',import.meta.url))});
const outbox=await createSignalOutbox(fileURLToPath(new URL('../.sites-runtime/signal-outbox/',import.meta.url)),
  body=>siteFetch('/api/signal-batches',{method:'POST',headers:{'content-type':'application/gzip'},body}),failed);
// A slow upload cannot delay the market clock. Keep only the newest waiting revision.
async function publish(snapshot) {
  pending = {...snapshot,rows:[...qualified.values()].filter(r => matchesQualifiedSettings(r,snapshot.budget,snapshot.floor,snapshot.maxImpact)).sort((a,b) => b.profit-a.profit)};
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
// Keep the smaller observation channel independent of full catalogue uploads.
let queuedBook, sendingBook=false, lastBook, activeSlot=0;
async function sendBook(frame){
  queuedBook=frame;
  if(sendingBook)return;
  sendingBook=true;
  try{
    while(queuedBook && !stopped){
      const next=queuedBook;
      queuedBook=null;
      try{
        await siteFetch('/api/observations',{method:'POST',headers:{'content-type':'application/gzip'},
          body:gzipSync(JSON.stringify(next),{level:1})});
      }catch(error){failed(error)}
    }
  }finally{sendingBook=false}
}
let sendingSwaps=false;
async function publishSwaps(){
  if(sendingSwaps||stopped)return;
  sendingSwaps=true;
  try{
    for(let batch=watch.spikes.pending();batch.length&&!stopped;batch=watch.spikes.pending()){
      await siteFetch('/api/signal-batches',{method:'POST',headers:{'content-type':'application/gzip'},
        body:gzipSync(JSON.stringify({kind:'swap-spikes',spikes:batch}),{level:1})});
      watch.ackSpikes(batch.map(s=>s.id));
    }
  }catch(error){failed(error)}finally{sendingSwaps=false}
}
async function tick(slot) {
  void publishSwaps();
  void venues.refresh();
  const {amount:budget,min:floor,maxImpact=1} = await siteFetch('/api/settings');
  if (!Number.isFinite(budget) || !Number.isFinite(floor)) throw Error('Invalid monitor settings');
  let seq=0, latest;
  const config={budget,floor,maxImpact};
  activeSlot=slot;
  const progress=frame=>{
    latest={...observationFrame(frame,frame.complete),seq:++seq};
    // A precision check for the preceding slot can finish during this scan.
    if(latest.complete && (!lastBook||lastBook.startedAt<=slot))lastBook=latest;
    if(activeSlot!==slot)return;
    const previous=!latest.complete && sameSettings(lastBook,config) && lastBook.startedAt<slot &&
      Date.now()-lastBook.at<120000 ? lastBook : undefined;
    void sendBook({...latest,previous});
  };
  progress({...config,startedAt:slot,at:Date.now(),complete:false,futures:{rows:[]}});
  const poolPass = async (markets,cex,onMarkets) => {
    const valuation = poolValuationAssets(markets,cex);
    watch.spikes.setAssets(valuation.map(a=>({...a,slug:chainSlug.get(a.chain)})));
    const index = startRegistry(markets,{allowDetails});
    const factories = startFactoryRegistry(markets);
    const known = new Map(index.entries.map(p => [poolKey(p),p]));
    for (const p of factories.entries) {
      const k = poolKey(p), listed = known.get(k);
      known.set(k,listed ? {...listed,protocol:p.protocol} : p);
    }
    const entries = [...known.values()];
    const discovered=[];
    for(const p of entries){
      const id=poolKey(p),chain=chainSlug.get(p.chain);
      if(seeded.has(id)||!chain)continue;
      const venue=dexVenues.find(v=>v.chains.includes(chain)&&v.ids.includes(p.dexId))?.id;
      discovered.push({chain,pool:p.pool,venue,tokens:[p.base,p.quote]});
    }
    if(discovered.length){
      watch.commit(discovered);
      for(const p of discovered)seeded.add(networks[p.chain]+':'+p.pool);
    }
    const registry = {...index.coverage,registeredPools:entries.length,factories:factories.coverage};
    const remaining = slot + interval - Date.now() - 2300;
    const options = {onMarkets,timeoutMs:Math.max(1,Math.min(24000,remaining))};
    const indexedEntries = index.entries.filter(p => !poolType(p) || retryWithIndex.has(poolKey(p)));
    const [chain, indexed, newPools] = await Promise.all([
      readPools(entries, valuation, {...options,anchorMaxAgeMs:45000}),
      readIndexedPools(indexedEntries, valuation, options),
      recentV4Pools(valuation).then(pools=>readNewPools(pools,valuation,{...options,timeoutMs:Math.max(1,Math.min(3500,slot+interval-Date.now()-2300))})),
    ]);
    allowDetails = indexed.coverage.every(c => c.attempted === c.registered && !c.error) && chain.coverage.every(c => c.attempted === c.supported);
    const chainPriced = new Set(chain.markets.map(poolKey));
    retryWithIndex = new Set(entries.filter(p => poolType(p) && !chainPriced.has(poolKey(p))).map(poolKey));
    const combined = new Map(indexed.markets.map(p => [poolKey(p), p]));
    for(const p of newPools.markets)if(!(combined.get(poolKey(p))?.time>=p.time))combined.set(poolKey(p),p);
    for (const p of chain.markets) combined.set(poolKey(p), p);
    const indexedVenues=venues.snapshot();
    const eventMarkets=eventPrices(eventWatcher.swaps(),watch,valuation,factories.entries);
    eventMarkets.push(...solanaWatcher.markets(watch.symbolFor));
    indexedVenues.markets.push(...eventMarkets);
    const byVenue=new Map();
    for(const m of indexedVenues.markets){
      if(!byVenue.has(m.dexId))byVenue.set(m.dexId,{pools:new Set(),time:0});
      const stats=byVenue.get(m.dexId);
      stats.pools.add(poolKey(m));stats.time=Math.max(stats.time,m.time);
    }
    for(const source of indexedVenues.sources){
      const stats=byVenue.get(source.id.slice('venue-dex-'.length));
      if(stats)Object.assign(source,{ok:true,count:stats.pools.size,time:stats.time,lastLive:Math.max(source.lastLive,stats.time)});
    }
    onMarkets?.(indexedVenues.markets);
    return {markets:[...combined.values()],venueMarkets:indexedVenues.markets,venueSources:indexedVenues.sources,coverage:chain.coverage,indexedReads:indexed.coverage,
      registry:{...registry,watchPools:indexedVenues.watchPools,eventPricedPools:new Set(eventMarkets.map(poolKey)).size,pricedPools:combined.size,pricedContracts:new Set([...combined.values()].map(p=>p.chain+':'+p.token)).size}};
  };
  const wide=readWideFiles();
  const {snapshot,verify,signalData} = await prepareScan({budget,floor,maxImpact,cursor,poolCursor,limit:10,startedAt:slot,poolPass,onProgress:progress,signals:true,
    extraCex:async native=>wideMarkets(await wide,native),
    previousCandidates:current?new Set(current.eligible):null});
  const sameConfig = current?.budget === budget && current?.floor === floor && current?.maxImpact === maxImpact;
  if (!sameConfig) qualified.clear();
  const eligible = new Set(snapshot.eligible);
  for (const [id,row] of qualified) if (!eligible.has(id) || !isFreshQualified(row)) qualified.delete(id);
  const batch = snapshot.attempted;
  snapshot.poolCoverage={...snapshot.poolCoverage,registry:{...snapshot.poolCoverage?.registry,
    reportedAt:Date.now(),eventStreams:[...eventWatcher.coverage(),solanaWatcher.coverage(),...chainReaders.flatMap(source=>source.coverage())],
    swapReceipts:watch.spikes.receipts()}};
  current = Object.assign(snapshot, {floor,intervalMs:interval,tested:0,attempted:[],verificationPending:!checking && batch.length>0});
  progress({...current,complete:true});
  poolCursor = current.poolCursor;
  void publish(current);
  const frame={startedAt:slot,at:snapshot.at,budget,floor,maxImpact,signalGaps:signalData.gaps,signalMarketIds:signalData.marketIds,entryChecks:[],
    spikes:await tracker.observe(signalData.samples,{at:slot,config:JSON.stringify([budget,floor,maxImpact])})};
  await outbox.put(frame);
  if (checking || !batch.length) return;
  checking = true;
  cursor = current.nextCursor;
  try {
    const origin = current;
    const entryChecks=[];
    void verify(check=>{
      const {id,match,cycle,checkedAt,status,profit}=check;
      entryChecks.push({id,match,cycle,checkedAt,status,profit});
      origin.routeChecks=[...origin.routeChecks,check];
      progress({...origin,complete:true});
    }).then(async rows => {
      const record=outbox.put({...frame,entryChecks}).catch(failed);
      if (current.budget !== budget || current.floor !== floor || current.maxImpact !== maxImpact) return;
      const possible = new Set(current.eligible);
      for (const id of batch) qualified.delete(id);
      for (const row of rows) if (possible.has(row.id) && isFreshQualified(row)) qualified.set(row.id,row);
      if (current === origin) Object.assign(current,{tested:batch.length,attempted:batch,verificationPending:false});
      void publish(current);
      await record;
    }).catch(failed).finally(() => {checking=false;});
  } catch (error) {checking=false;throw error;}
}
function pollSwaps(){
  if(stopped)return;
  for(const source of chainReaders)void source.refresh().catch(failed);
  void solanaWatcher.refresh().catch(failed);
  void eventWatcher.refresh().then(()=>resolveKeys(eventWatcher.swaps())).catch(failed);
  void publishSwaps();
}
pollSwaps();
const swapClock=setInterval(pollSwaps,4000);
swapClock.unref();
while (!stopped) {
  const slot = Math.floor(Date.now()/interval)*interval;
  try { await tick(slot); } catch (error) { failed(error); }
  if (!stopped) await sleep(Math.max(0,(slot + interval) - Date.now()));
}

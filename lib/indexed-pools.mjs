import {comparablePoolSide,reportedEmptyPool} from './pool-anchors.mjs';
import {poolVenueName} from './v4-pool.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {CHAINS, NATIVE} from './assets.js';

const slugs = new Map([[1,'ethereum'],[56,'bsc'],[8453,'base'],[42161,'arbitrum']]);
const address = /^0x[0-9a-f]{40}$/;
const poolId = /^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const lower = x => String(x ?? '').toLowerCase();
const key = (chain, token) => chain + ':' + token;
const positive = n => Number.isFinite(n) && n > 0;
const maxAge = 45_000;
const wrapped = new Map([[1,'0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'],[56,'0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'],[8453,'0x4200000000000000000000000000000000000006'],[42161,'0x82af49447d8a07e3bd95bd0d56f35241523fbab1']]);
const stable = new Map([[1,'0xdac17f958d2ee523a2206206994597c13d831ec7'],[56,'0x55d398326f99059ff775485246999027b3197955'],[42161,'0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9']]);

function asOf(headers) {
  const received = Date.now();
  const published = Date.parse(headers.get('date') || '');
  const age = Number(headers.get('age') || 0);
  return Math.min(received, Number.isFinite(published) ? published : received, received - Math.max(0,age) * 1000);
}

function observe(pair, entry, assets, at) {
  const {chain, pool, dexId, base, quote} = entry;
  const anchors = [CHAINS[chain].usdc, stable.get(chain), NATIVE, wrapped.get(chain)];
  const baseRank = anchors.indexOf(base), quoteRank = anchors.indexOf(quote);
  const inverse = baseRank >= 0 && (quoteRank < 0 || baseRank < quoteRank);
  const target = inverse ? quote : base, anchor = inverse ? base : quote;
  const asset = assets.get(key(chain,target)), reference = assets.get(key(chain,anchor));
  const ratio = Number(pair.priceNative);
  if (!asset || reportedEmptyPool(pair.liquidity?.usd) || !comparablePoolSide(chain,target,anchor) || !positive(ratio) || !Number.isFinite(at) || Date.now()-at > maxAge) return null;
  let factor = 1, time = at;
  if (anchor !== CHAINS[chain].usdc) {
    if (!reference || !(reference.ask>0 && reference.bid>0) || !positive(reference.time) ||
        Date.now()-reference.time > maxAge || reference.time > Date.now()+5000) return null;
    factor = (reference.ask + reference.bid)/2;
    time = Math.min(at,reference.time);
  }
  const mark = factor * (inverse ? 1/ratio : ratio);
  if (!positive(mark)) return null;
  return {...asset, id:asset.id+':'+pool, name:poolVenueName(dexId,pool,CHAINS[chain].name), pool,dexId,ask:mark,bid:mark,
    time,referenceOnly:false,reference:'indexed-pool',liquidityUSD:positive(Number(pair.liquidity?.usd))?Number(pair.liquidity.usd):null};
}

// Each instance retains only the scheduling cursor and rate-limit state between cycles.
export function createIndexedPoolReader({fetchImpl=fetch,intervalMs=295} = {}) {
  let nextRequest = 0, backoffUntil = 0, cursor = 0;
  return async function read(entries, assets, {timeoutMs=22000,signal:external,onMarkets} = {}) {
    const stop = AbortSignal.timeout(Math.max(1,Math.ceil(timeoutMs)));
    const signal = external ? AbortSignal.any([stop,external]) : stop;
    const assetIndex = new Map((assets instanceof Map ? [...assets.values()] : assets).map(a=>[key(a.chain,lower(a.token)),a]));
    const chains = new Map([...slugs.keys()].map(chain=>[chain,new Map()]));
    for (const entry of entries) {
      const chain = Number(entry.chain), pool = lower(entry.pool), base = lower(entry.base), quote = lower(entry.quote);
      if (chains.has(chain) && poolId.test(pool) && address.test(base) && address.test(quote) && base!==quote) {
        chains.get(chain).set(pool,{...entry,chain,pool,base,quote});
      }
    }
    const jobs = [], markets = [], stats = new Map();
    for (const [chain,pools] of chains) {
      stats.set(chain,{chain,registered:pools.size,attempted:0,returned:0,priced:0,contracts:0,time:0,error:null});
      const list = [...pools.values()].sort((a,b)=>a.pool.localeCompare(b.pool));
      for (let i=0;i<list.length;i+=30) jobs.push({chain,batch:list.slice(i,i+30)});
    }
    const count = jobs.length, start = count ? cursor%count : 0;
    let launched = 0;
    const active = new Set();
    async function request({chain,batch}) {
      const c = stats.get(chain), lookup = new Map(batch.map(e=>[e.pool,e]));
      c.attempted += batch.length;
      try {
        const url = 'https://api.dexscreener.com/latest/dex/pairs/'+slugs.get(chain)+'/'+[...lookup.keys()].join(',');
        const res = await fetchImpl(url,{headers:{accept:'application/json'},cache:'no-store',signal});
        if (res.status===429) {
          const retry=res.headers.get('retry-after');
          const until=retry&&Number.isFinite(Number(retry))?Date.now()+Number(retry)*1000:Date.parse(retry||'');
          backoffUntil=Math.max(backoffUntil,until||Date.now()+60000,Date.now()+1000);
        }
        if (!res.ok) throw Error('HTTP '+res.status);
        const at=asOf(res.headers), payload=await res.json();
        if (payload.pairs!==null && !Array.isArray(payload.pairs)) throw Error('invalid pair response');
        const observed = [];
        for (const p of payload.pairs??[]) {
          const id=lower(p.pairAddress), entry=lookup.get(id);
          if (!entry || p.chainId!==slugs.get(chain) || p.dexId!==entry.dexId)continue;
          const base=lower(p.baseToken?.address),quote=lower(p.quoteToken?.address);
          const sameOrder=base===entry.base&&quote===entry.quote;
          if(!sameOrder&&!(entry.initialized&&base===entry.quote&&quote===entry.base))continue;
          lookup.delete(id);
          c.returned++;
          const mark=observe(p,sameOrder?entry:{...entry,base,quote},assetIndex,at);
          if (mark) {observed.push(mark);c.priced++;c.time=c.time?Math.min(c.time,mark.time):mark.time;}
        }
        markets.push(...observed);
        if (observed.length) onMarkets?.(observed);
      } catch (e) { c.error=signal.aborted?'scan deadline':String(e.message); }
    }
    while (launched<count && !signal.aborted && Date.now()>=backoffUntil) {
      if (active.size>=4) await Promise.race(active);
      const wait=nextRequest-Date.now();
      if (wait>0) try {await delay(wait,undefined,{signal});} catch {break;}
      if (signal.aborted||Date.now()<backoffUntil) break;
      nextRequest=Date.now()+intervalMs;
      const task=request(jobs[(start+launched++)%count]).finally(()=>active.delete(task));
      active.add(task);
    }
    await Promise.all(active);
    if (count) cursor=(start+launched)%count;
    const coverage=[...stats.values()].map(c=>{
      if (c.attempted<c.registered && !c.error) c.error=Date.now()<backoffUntil?'rate-limit cooldown':'scan deadline';
      c.contracts=new Set(markets.filter(m=>m.chain===c.chain).map(m=>m.token)).size;
      return {...c,complete:c.priced===c.registered};
    });
    return {markets,coverage,at:Date.now()};
  };
}
export const readIndexedPools = createIndexedPoolReader();

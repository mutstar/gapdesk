// Background factory discovery for the local collector. A successful zero address is a checked lookup.
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { CHAINS, NATIVE } from './assets.js';

const defaultFile = fileURLToPath(new URL('../.sites-runtime/factory-pools.json', import.meta.url));
const multicall = '0xca11bde05977b3631167028862be2a173976ca11';
const wrapped = { 1:'0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',56:'0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  8453:'0x4200000000000000000000000000000000000006',42161:'0x82af49447d8a07e3bd95bd0d56f35241523fbab1' };
// https://developers.uniswap.org/docs/protocols/v2/deployments
// https://developers.uniswap.org/docs/protocols/v3/deployments
const uniV2 = {1:'0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f',56:'0x8909dc15e40173ff4699343b6eb8132c65e18ec6',
  8453:'0x8909dc15e40173ff4699343b6eb8132c65e18ec6',42161:'0xf1d7cc64fb4452f05c498126312ebe29f30fbcf9'};
const uniV3 = {1:'0x1f98431c8ad98523631ae4a59f267346ea31f984',56:'0xdb1d10011ad0ff90774d0c6bb92e5c5c8b4461f7',
  8453:'0x33128a8fc17869897dce68ed026d694621f6fdfd',42161:'0x1f98431c8ad98523631ae4a59f267346ea31f984'};
// PancakeSwap's @pancakeswap/v2-sdk FACTORY_ADDRESS and developer.pancakeswap.finance/contracts/v3/addresses
const pancakeV2 = '0xca143ce32fe78f1f7019d7d551a6402fc5350c73', pancakeV3 = '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865';
const key = (chain, token) => chain + ':' + token;
const word = n => BigInt(n).toString(16).padStart(64, '0');
const addressWord = a => a.slice(2).padStart(64,'0');
const readNumber = (s,i) => Number(BigInt('0x'+s.slice(i,i+64)));
const address = /^0x[0-9a-f]{40}$/;

function lookups(chain, tokens) {
  const anchors = [wrapped[chain],CHAINS[chain].usdc];
  const venues = [['uniswap',uniV2[chain],uniV3[chain],[100,500,3000,10000]]];
  if (chain === 56) {
    anchors.push('0x55d398326f99059ff775485246999027b3197955');
    venues.push(['pancakeswap',pancakeV2,pancakeV3,[100,500,2500,10000]]);
  }
  const calls = [];
  for (const base of tokens) for (const quote of anchors) {
    if (base === quote) continue;
    const args = addressWord(base) + addressWord(quote);
    for (const [dexId,v2,v3,fees] of venues) {
      calls.push({base,quote,dexId,protocol:'v2',to:v2,data:'e6a43905'+args});
      for (const fee of fees) calls.push({base,quote,dexId,protocol:'v3',to:v3,data:'1698ee82'+args+word(fee)});
    }
  }
  return calls;
}

// aggregate((address,bytes)[]) reverts as a group on a failed factory read.
// Each official factory returns exactly one ABI-encoded address.
async function lookup(chain, calls) {
  const heads = [], tails = [];
  let offset = calls.length * 32;
  for (const call of calls) {
    heads.push(word(offset));
    const data = call.data.padEnd(64*Math.ceil(call.data.length/64),'0');
    const tail = addressWord(call.to) + word(64) + word(call.data.length/2) + data;
    tails.push(tail); offset += tail.length / 2;
  }
  const data = '0x252dba42' + word(32) + word(calls.length) + heads.join('') + tails.join('');
  const r = await fetch(CHAINS[chain].rpc,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(8000),
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{to:multicall,data},'latest']})});
  if (!r.ok) {
    const error = Error('Factory RPC '+r.status), retry = r.headers.get('retry-after');
    if (r.status === 429 || r.status === 503) error.backoff = Math.max(30000, Number(retry)*1000 || Date.parse(retry)-Date.now() || 0);
    throw error;
  }
  const response = await r.json();
  if (response.error || !response.result) throw Error(String(response.error?.message || 'Factory RPC empty result'));
  const raw = response.result.slice(2), array = readNumber(raw,64)*2, start = array+64;
  if (readNumber(raw,array) !== calls.length) throw Error('Incomplete factory response');
  return calls.map((_, i) => {
    const len = start + readNumber(raw,start+64*i)*2;
    const result = raw.slice(len+64,len+128);
    if (readNumber(raw,len) !== 32 || !/^0{24}[0-9a-f]{40}$/i.test(result)) throw Error('Malformed factory address');
    return '0x' + result.slice(24).toLowerCase();
  });
}

export function createFactoryRegistry({cacheFile=defaultFile,request=lookup,refreshMs=3600000,intervalMs=240,now=Date.now}={}) {
  let checked = new Map(), pools = new Map(), universe = new Map(), running = null, cacheWritable = true;
  const retry = new Map(), blocked = new Map();
  try {
    const saved = JSON.parse(readFileSync(cacheFile,'utf8'));
    if (saved.version === 1) {
      checked = new Map(saved.checked);
      pools = new Map(saved.pools.map(p => [key(p.chain,p.pool),p]));
    }
  } catch { /* First run or unreadable cache. */ }
  let save = Promise.resolve(), lastSave = 0;
  function persist(force = false) {
    if (!cacheFile || (!force && now()-lastSave < 5000)) return save;
    lastSave = now();
    save = save.then(async () => {
      const tmp = cacheFile + '.' + process.pid + '.tmp';
      try {
        await mkdir(dirname(cacheFile),{recursive:true});
        await writeFile(tmp,JSON.stringify({version:1,checked:[...checked],pools:[...pools.values()]}));
        await rename(tmp,cacheFile); cacheWritable = true;
      } catch { cacheWritable = false; }
    });
    return save;
  }
  function snapshot() {
    const entries = [], covered = new Set();
    let checkedContracts = 0, failedContracts = 0;
    const t = now();
    for (const id of universe.keys()) {
      if (checked.has(id) && t-checked.get(id)<refreshMs) checkedContracts++;
      if (retry.has(id)) failedContracts++;
    }
    for (const pool of pools.values()) {
      const left = key(pool.chain,pool.base), right = key(pool.chain,pool.quote);
      if (!universe.has(left) && !universe.has(right)) continue;
      entries.push(pool);
      if (universe.has(left)) covered.add(left);
      if (universe.has(right)) covered.add(right);
    }
    return {entries,coverage:{contracts:universe.size,checkedContracts,contractsWithPools:covered.size,registeredPools:entries.length,
      failedContracts,running:!!running,cacheWritable}};
  }
  async function discover(chain, tokens) {
    // Cap encoded request size by the number of factory lookups per token.
    const chunkSize = chain === 56 ? 20 : 60;
    for (let i=0; i<tokens.length; i+=chunkSize) {
      if ((blocked.get(chain) || 0)>now()) break;
      const chunk=tokens.slice(i,i+chunkSize), calls=lookups(chain,chunk), begin=now();
      try {
        const results=await request(chain,calls);
        if (results.length!==calls.length || results.some(p=>!address.test(p))) throw Error('Invalid pool address responses');
        for (let j=0;j<results.length;j++) {
          const pool=results[j]; if (pool===NATIVE) continue;
          const {base,quote,protocol,dexId}=calls[j];
          pools.set(key(chain,pool),{chain,pool,base,quote,dexId,protocol,labels:[protocol]});
        }
        for (const token of chunk) {const id=key(chain,token);checked.set(id,now());retry.delete(id);}
      } catch (err) {
        const backoff=err.backoff || (/limit|too many/i.test(err.message)?30000:0), after=now()+Math.max(30000,backoff);
        for (const token of chunk) retry.set(key(chain,token),after);
        if (backoff) blocked.set(chain,after);
      }
      await persist();
      if (intervalMs>now()-begin) await sleep(intervalMs-now()+begin);
    }
  }
  function start(markets) {
    const t=now();
    universe = new Map();
    for (const m of markets) {
      const chain=Number(m.chain);
      if (!CHAINS[chain]) continue;
      let token=String(m.token).toLowerCase();
      if (token===NATIVE) token=wrapped[chain];
      if (address.test(token)) universe.set(key(chain,token),{chain,token});
    }
    if (!running) {
      const due = new Map();
      for (const [id,{chain,token}] of universe) {
        if ((blocked.get(chain)||0)>t || (retry.get(id)||0)>t || (checked.has(id) && t-checked.get(id)<refreshMs)) continue;
        if (!due.has(chain)) due.set(chain,[]);
        due.get(chain).push(token);
      }
      if (due.size) running=Promise.all([...due].map(([chain,tokens])=>discover(chain,tokens)))
        .then(()=>persist(true)).finally(()=>{running=null;});
    }
    return snapshot();
  }
  return {start,snapshot,idle:()=>running??Promise.resolve()};
}

let singleton;
export function startFactoryRegistry(markets) {
  singleton ??= createFactoryRegistry();
  return singleton.start(markets);
}

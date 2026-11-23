import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPoolRegistry } from '../lib/pool-registry.mjs';

const addr = n => '0x' + n.toString(16).padStart(40, '0');
const asset = (chain, i) => ({ chain, token: addr(i) });
const pair = (chainId, token, pool = addr(999)) => ({ chainId, dexId:'uniswap', labels:['v3'],
  pairAddress:pool, baseToken:{address:token}, quoteToken:{address:addr(400)}, liquidity:{usd:'2300'} });

async function sandbox(t) {
  const dir = await mkdtemp(join(tmpdir(), 'gapdesk-registry-'));
  t.after(() => rm(dir, { recursive:true, force:true }));
  return join(dir, 'registry.json');
}

test('full catalog is deduplicated, interleaved and persisted without treating pool discovery as a price observation', async t => {
  const cacheFile = await sandbox(t), calls = [];
  const markets = [...Array.from({length:31}, (_,i)=>asset(1,i+1)), asset(56,1), asset(1,1), asset(1,0), asset(999,2)];
  const request = async (chain,tokens) => {
    calls.push([chain,tokens]);
    const slug = chain === 1 ? 'ethereum' : 'bsc';
    const p = pair(slug,tokens[0],addr(Number(tokens[0])+1000));
    return [p,p,pair('base',tokens[0]),pair(slug,addr(777),addr(888))];
  };
  const r = createPoolRegistry({cacheFile,request,intervalMs:0});
  assert.equal(r.start(markets).coverage.contracts,32);
  r.start(markets);
  await r.idle();
  assert.deepEqual(calls.map(([c,x])=>[c,x.length]),[[1,30],[56,1],[1,1]]);
  const {entries,coverage} = r.snapshot();
  assert.equal(coverage.checkedContracts,32);
  assert.equal(coverage.contractsWithPools,3);
  assert.equal(coverage.registeredPools,3);
  assert.equal(entries[0].liquidityUSD,2300);
  assert.equal(entries[0].ask,undefined);
  const restart = createPoolRegistry({cacheFile,request,intervalMs:0,detailLimit:0});
  assert.equal(restart.start(markets).entries.length,3);
  assert.equal(calls.length,3);
});

test('backoff retains earlier discoveries, retries missing contracts and removes obsolete pool mappings', async t => {
  const cacheFile = await sandbox(t);
  await writeFile(cacheFile,'damaged cache');
  const markets = [asset(1,1),asset(56,2)];
  let clock = 1_000_000, fail = true, calls = 0;
  const request = async (chain,tokens) => {
    calls++;
    if (fail && chain === 56) throw Object.assign(Error('rate limited'),{backoffMs:60_000});
    return [pair(chain===1?'ethereum':'bsc',tokens[0])];
  };
  const r = createPoolRegistry({cacheFile,request,intervalMs:0,now:()=>clock,refreshMs:100_000,detailRefreshMs:200_000,detailLimit:0});
  r.start(markets); await r.idle();
  assert.equal(r.snapshot().coverage.checkedContracts,1);
  assert.equal(r.snapshot().coverage.failedContracts,1);
  r.start(markets); await r.idle();
  assert.equal(calls,2);
  clock += 60_001; fail = false;
  r.start(markets); await r.idle();
  assert.equal(r.snapshot().coverage.checkedContracts,2);
  assert.equal(r.snapshot().coverage.failedContracts,0);
  assert.deepEqual(r.start([markets[1]]).entries.map(p=>p.chain),[56]);
  clock += 400_001;
  assert.equal(r.snapshot().entries.length,0);
});

test('token-pairs sweeps discover venues omitted in bulk responses and resume by contract', async t => {
  const cacheFile = await sandbox(t), markets = [asset(1,1),asset(1,2)], seen = [];
  const request = async (chain,tokens,detail) => {
    if (!detail) return [pair('ethereum',tokens[0])];
    seen.push(tokens[0]);
    return [pair('ethereum',tokens[0],addr(900+seen.length))];
  };
  const options = {cacheFile,request,intervalMs:0,detailLimit:1};
  const r = createPoolRegistry(options);
  r.start(markets); await r.idle();
  r.start(markets,{allowDetails:false}); await r.idle();
  assert.equal(r.snapshot().coverage.detailContracts,0);
  r.start(markets); await r.idle();
  assert.equal(r.snapshot().coverage.detailContracts,1);
  const next = createPoolRegistry(options);
  next.start(markets); await next.idle();
  assert.deepEqual(seen,[addr(1),addr(2)]);
  assert.equal(next.snapshot().entries.length,3);
});

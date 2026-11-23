import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NATIVE } from '../lib/assets.js';
import { createFactoryRegistry } from '../lib/factory-registry.mjs';

const address = n => '0x'+n.toString(16).padStart(40,'0');
const weth = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
test('checks every token and fee, resumes cached zero results, deduplicates native addresses', async t => {
  const dir=await mkdtemp(join(tmpdir(),'gapdesk-factory-')),file=join(dir,'factory.json');
  t.after(async()=>{await unlink(file);await rmdir(dir);});
  const calls=[];
  const request=async(chain, batch)=>{
    calls.push(...batch.map(c=>({...c,chain})));
    return batch.map(c=>c.base===address(1) && c.quote===weth && c.protocol==='v2'?address(99):NATIVE);
  };
  const registry=createFactoryRegistry({cacheFile:file,request,intervalMs:0});
  const markets=[{chain:1,token:address(1)},{chain:1,token:NATIVE},{chain:1,token:weth},{chain:56,token:address(2)}];
  const first=registry.start(markets);
  assert.equal(first.coverage.running,true);
  assert.equal(first.coverage.contracts,3);
  await registry.idle();
  const result=registry.snapshot();
  assert.equal(result.coverage.checkedContracts,3);
  assert.equal(result.entries[0].pool,address(99));
  assert.equal(calls.filter(c=>c.base===address(1)).length,10);
  assert.equal(calls.filter(c=>c.base===address(2)).length,30);
  assert.equal(calls.filter(c=>c.base===weth).length,5);
  assert.ok(calls.every(c=>c.base!==c.quote && c.base!==NATIVE && c.quote!==NATIVE));
  const resumed=createFactoryRegistry({cacheFile:file,intervalMs:0,request:()=>assert.fail('fresh cache should be reused')});
  assert.deepEqual(resumed.start(markets).entries,result.entries);
  assert.equal(resumed.snapshot().coverage.checkedContracts,3);
  assert.equal(resumed.snapshot().coverage.running,false);
});

test('partial RPC responses do not count as checked and can be retried after backoff', async () => {
  let clock=1000,fail=true;
  const registry=createFactoryRegistry({cacheFile:null,intervalMs:0,now:()=>clock,request:async(_chain,calls)=>fail?[]:calls.map(()=>NATIVE)});
  const markets=[{chain:8453,token:address(111)}];
  registry.start(markets); await registry.idle();
  assert.equal(registry.snapshot().coverage.checkedContracts,0);
  assert.equal(registry.snapshot().coverage.failedContracts,1);
  assert.equal(registry.start(markets).coverage.running,false);
  clock+=31000;fail=false;
  registry.start(markets);await registry.idle();
  assert.equal(registry.snapshot().coverage.checkedContracts,1);
  assert.equal(registry.snapshot().coverage.failedContracts,0);
  assert.equal(registry.snapshot().entries.length,0);
});

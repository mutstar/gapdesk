import test from 'node:test';
import assert from 'node:assert/strict';
import {poolFill,depthFactory} from '../lib/pool-depth.mjs';
import {CHAINS} from '../lib/assets.js';

const addr=n=>'0x'+n.toString(16).padStart(40,'0'), A=addr(9), B=addr(10), USDC=CHAINS[1].usdc;
const Q96=1n<<96n;
function fixture(patch={}, at=Date.now()) {
  const depth={chain:1,pool:addr(100),protocol:'v2',dexId:'uniswap',feePpm:3000,token0:A,token1:USDC,
    decimals0:18,decimals1:6,reserve0:String(100000n*10n**18n),reserve1:String(1000000n*10n**6n),time:at,block:123,...patch};
  return {chain:1,pool:depth.pool,token:A,depth,time:at,blockTime:at,block:123};
}
test('V2 returns fee-adjusted amount in either direction, with correct token units and impact cutoff',()=>{
  const m=fixture(),buy=poolFill(m,'buy',1000,1), sell=poolFill(m,'sell',100,1);
  assert.equal(buy.output,Number(1000n*997n*100000n*10n**18n/(1000000n*1000n+1000n*997n))/1e18);
  assert.equal(sell.output,Number(100n*997n*1000000n*10n**6n/(100000n*1000n+100n*997n))/1e6);
  assert.ok(Math.abs(buy.spotPrice-10)<1e-12);
  assert.ok(Math.abs(buy.effectivePrice-1000/buy.output)<1e-12);
  assert.ok(buy.impactPct>0.39 && buy.impactPct<0.41);
  assert.equal(poolFill(m,'buy',1000,0.38),null);
  assert.deepEqual(buy.pools,[m.pool]);
});
test('USDC conversion requires real same-block depth on the opposite token',()=>{
  const t=Date.now(),m=fixture({token1:B},t);
  assert.equal(poolFill(m,'buy',100),null);
  const conversion=fixture({token0:B,token1:USDC,decimals0:6,decimals1:6,reserve0:'1000000000000',reserve1:'2000000000000',pool:addr(101)},t).depth;
  m.depthBridges=[{...conversion,block:124}];
  assert.equal(poolFill(m,'buy',1000),null);
  m.depthBridges=[conversion];
  const b=poolFill(m,'buy',1000);
  assert.deepEqual(b.pools,[conversion.pool,m.pool]);
  assert.ok(Math.abs(b.spotPrice-20)<1e-12);
  assert.ok(b.impactPct>0.6);
  const s=poolFill(m,'sell',b.output);
  assert.deepEqual(s.pools,[m.pool,conversion.pool]);
  assert.ok(s.output<1000);
});
test('V3 applies integer rounding and rejects trades crossing an unknown tick boundary',()=>{
  // Equal ERC-20 decimals. Tick 5 sits strictly inside the [0,10] tick cell.
  const sqrt=79247971040445709311708648151n,L=1000000000000000n;
  const m=fixture({protocol:'v3',feePpm:500,decimals0:6,tick:5,tickSpacing:10,sqrtPriceX96:String(sqrt),liquidity:String(L)});
  const net=1000n*10n**6n*999500n/1000000n;
  const next=sqrt+net*Q96/L;
  const expected=L*Q96*(next-sqrt)/next/sqrt;
  const buy=poolFill(m,'buy',1000),sell=poolFill(m,'sell',1000);
  assert.equal(buy.output,Number(expected)/1e6);assert.ok(sell.output>0);
  assert.equal(poolFill(m,'buy',1e6,100),null);
  assert.equal(poolFill(m,'sell',1e6,100),null);
  const boundary=fixture({...m.depth,tick:0,sqrtPriceX96:String(Q96)},m.blockTime);
  assert.equal(poolFill(boundary,'sell',1),null);
  assert.ok(poolFill(boundary,'buy',1));
});
test('unknown venues and fees, unsupported curves, stale observations and malformed state fail closed',()=>{
  assert.equal(depthFactory(56,'pancakeswap','v2'),'0xca143ce32fe78f1f7019d7d551a6402fc5350c73');
  assert.equal(depthFactory(56,'aerodrome','v2'),null);
  for(const patch of [{dexId:'other'},{feePpm:2500},{protocol:'stable'},{reserve0:'???'},{reserve1:'0'}]) {
    assert.equal(poolFill(fixture(patch),'buy',1000),null);
  }
  assert.equal(poolFill(fixture({},Date.now()-50000),'buy',1000),null);
  assert.equal(poolFill(fixture(),'buy',Infinity),null);
  assert.equal(poolFill(fixture(),'buy',1e-10),null);
});

test('a current pinned bitmap widens depth only to the next initialized tick or known word edge',()=>{
  const common={protocol:'v3',feePpm:500,decimals0:6,tick:5,tickSpacing:10,
    sqrtPriceX96:'79247971040445709311708648151',liquidity:'1000000000000000'};
  const bitmap=bits=>'0x'+bits.toString(16).padStart(64,'0');
  assert.equal(poolFill(fixture(common),'buy',1e6,1),null);
  assert.ok(poolFill(fixture({...common,wordIndex:0,bitmap:bitmap(0n)}),'buy',1e6,1));
  assert.equal(poolFill(fixture({...common,wordIndex:1,bitmap:bitmap(0n)}),'buy',1e6,1),null);
  assert.equal(poolFill(fixture({...common,wordIndex:0,bitmap:bitmap(2n)}),'buy',1e6,1),null);
  assert.equal(poolFill(fixture({...common,wordIndex:0,bitmap:bitmap(0n)}),'sell',1e6,100),null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readPool} from '../lib/dex-catalog.mjs';
import {eventPrices} from '../lib/event-prices.mjs';
import {comparablePoolSide,reportedEmptyPool} from '../lib/pool-anchors.mjs';
import {CHAINS} from '../lib/assets.js';

const chain=42161, weth='0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
const logx='0x59062301fb510f4ea2417b67404cb16d31e604ba',pool='0x6fa9a96507dbf2d3550b670d93ca198d3453d028';
const now=Date.now(), usdc=CHAINS[chain].usdc;
const prices=new Map([[weth,1695],[logx,0.00003654],[usdc,1]].map(([token,mark])=>[chain+':'+token,{token,chain,id:'dex:'+token,ask:mark,bid:mark,time:now,decimals:18}]));
const pair={chainId:'arbitrum',pairAddress:pool,dexId:'uniswap',baseToken:{address:logx},quoteToken:{address:weth},priceNative:'0.0000000000000000008862',priceUsd:'0.000000000000001533'};
const read=p=>readPool(p,prices,now,new Map([[chain,{usd:1,time:now}]]),prices);
test('a reported empty LOGX pool cannot supply WETH marks and missing liquidity is distinct from zero',()=>{
  assert.deepEqual(read({...pair,liquidity:{usd:0}}),[]);
  assert.deepEqual(read(pair).map(m=>m.token),[logx]);
  const inverted={...pair,baseToken:pair.quoteToken,quoteToken:pair.baseToken,priceNative:String(1/Number(pair.priceNative))};
  assert.deepEqual(read(inverted).map(m=>m.token),[logx]);
  assert.equal(reportedEmptyPool(null),false);assert.equal(reportedEmptyPool('0.00'),true);
  const direct=read({...pair,baseToken:{address:weth},quoteToken:{address:usdc},priceNative:'1900'});
  assert.equal(direct.find(m=>m.token===weth).ask,1900);
});
test('swap-derived marks retain the altcoin side and do not invert its external valuation into the settlement side',()=>{
 const swap={protocol:'v4',chain:'arbitrum',pool,rawRatio:0.0000000000000000008862,time:now};
 const rows=eventPrices([swap],{identity:()=>({token0:logx,token1:weth})},[...prices.values()],[],now);
 assert.deepEqual(rows.map(m=>m.token),[logx]);
 assert.equal(comparablePoolSide(1,'0xdac17f958d2ee523a2206206994597c13d831ec7',logx),false);
});

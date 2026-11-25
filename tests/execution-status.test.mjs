import test from 'node:test';
import assert from 'node:assert/strict';
import {executionStatus,routePath} from '../lib/execution-status.mjs';

const now=1_000_000;
const quote={budget:1000,buyKind:'DEX',sellKind:'DEX',from:1,to:1,buyGas:1,sellGas:1,
  approvalGas:0.4,depositGas:0,bridgeGas:0,gasPriceFrom:1000,gasPriceTo:1000};
const wallet={1:{at:now-1,usdc:1000,eth:0.01}};
const flags={at:now,withdraw:true,deposit:true};
const group=(row,balances=wallet,address='owner')=>executionStatus(row,address,balances,now).group;

test('start requires recent wallet funds and enough gas for both legs together',()=>{
  assert.equal(group(quote),'ready');
  assert.equal(group(quote,wallet,''),'unverified');
  assert.equal(group(quote,{1:{...wallet[1],at:now-45000}}),'unverified');
  assert.equal(group(quote,{1:{...wallet[1],usdc:999}}),'blocked');
  assert.equal(group(quote,{1:{...wallet[1],eth:0.0015}}),'blocked');
});
test('withdrawal follows the buying venue; a CEX deposit alone is not a withdrawal',()=>{
  const manual={...quote,buy:'Bitget',buyKind:'CEX',buyTransfer:flags};
  assert.equal(group(manual,{},''),'manual');
  assert.equal(group({...manual,sellKind:'CEX',sellTransfer:flags}),'manual');
  assert.equal(group({...manual,buyTransfer:{...flags,withdraw:false}}),'blocked');
  assert.equal(group({...manual,buyTransfer:{...flags,at:now-45000}}),'blocked');
  assert.equal(group({...quote,sellKind:'CEX',sellTransfer:flags,depositGas:0.3}),'ready');
  assert.equal(group({...quote,sellKind:'CEX',sellTransfer:{...flags,deposit:null}}),'blocked');
});
test('different networks need a verified bridge and gas on both networks',()=>{
  const cross={...quote,to:8453};
  assert.equal(group(cross),'blocked');
  assert.equal(group({...cross,bridge:'Relay'}),'unverified');
  assert.equal(group({...cross,bridge:'Relay'},{...wallet,8453:{at:now,eth:1}}),'ready');
  assert.match(routePath(1,8453,'Relay',80),/Relay → Base · 약 2분/);
  assert.match(routePath(1,8453,null,0),/브릿지 미확인/);
  assert.match(routePath(1,'1',null,0),/동일 체인/);
});

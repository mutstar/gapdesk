import test from 'node:test';
import assert from 'node:assert/strict';
import {events} from '../lib/pool-event-stream.mjs';
import {openWatchRegistry} from '../lib/watch-registry.mjs';

const bytes=n=>BigInt.asUintN(256,BigInt(n)).toString(16).padStart(64,'0');
const topic=n=>'0x'+bytes(n),address=n=>'0x'+bytes(n).slice(24);
function log(emitter,signature,indexed,data){
  return {address:emitter,topics:[signature,...indexed.map(topic)],data:'0x'+data.map(bytes).join('')};
}
function decode(chain,logs,registry){
  return events({chain},[{header:{number:123,timestamp:1700000000},logs}],registry?.poolVenue);
}
const clManager='0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b',binManager='0xc697d2898e0d09264376196696c51d7abbbaa4a9';
const cl='0x04206ad2b7c0f463bff3dd4f33c5735b0f2957a351e4f79763a4fa9e775dd237';
const bin='0x3e8aae37f890eb1f9d63dd4d2062f3f0be757848a0f0760e4f3e53dad556e861';
test('Infinity CL and Bin scope pool IDs to their own chain and manager and preserve both same-block fills',()=>{
  const init=log(clManager,'0x426cc62fe6a33a40ba2788c2c87a9c34ee4582b95bc9fa5a7bb7ae70b750b99c',[500,0,8],[0,100,0,2n**96n,0]);
  const clSwap=log(clManager,cl,[500,20],[100,-100,2n**97n,50,0,100,42]);
  const binSwap=log(binManager,bin,[800,20],[-100,300,500,100,42]);
  const p=decode('bsc',[init,clSwap,binSwap,binSwap,{...clSwap,address:binManager},{...binSwap,address:clManager}]);
  assert.deepEqual(p.ticks.map(x=>[x.pool,x.rawRatio]),[[topic(500),4],[topic(800),3],[topic(800),3]]);
  assert.deepEqual(p.pools.find(x=>x.pool===topic(500)).tokens,[address(0),address(8)]);
  assert.equal(decode('ethereum',[clSwap,binSwap]).ticks.length,0);
});
test('Maverick and Fluid require known venues and accept discovered official factory pools across batches',()=>{
  const factory='0x0a7e848aca42d879ef06507fca0e7b33a0a63c1e',dex=address(999);
  const created=log(factory,'0x848331e408557f4b7eb6561ca1c18a3ac43004fbe64b8b5bce613855cfdf22d2',[],[999,0,1,1,2,60,0,3,5,1,0]);
  const mav='0x103ed084e94a44c8f5f6ba8e3011507c41063177e29949083c439777d8d63f60';
  const buy=log(dex,mav,[],[1,2,50,1,0,0,50,100]),sell=log(dex,mav,[],[2,1,100,0,0,0,100,50]);
  assert.equal(decode('base',[{...created,address:address(444)},buy]).ticks.length,0);
  const reg=openWatchRegistry(':memory:');
  try{
    reg.commit(decode('base',[created]).pools);
    assert.deepEqual(decode('base',[buy,sell],reg).ticks.map(x=>[x.venue,x.rawRatio]),[['maverick',2],['maverick',2]]);
    const deployed=log('0x91716c4eda1fb55e84bf8b4c7085f84285c19085','0x80d4769bbf5966f1c91cdab7c477bd8f74016bd5f5ed3ad18af6b32e29f6da7f',[999,1],[]);
    const fill=log(dex,'0xdc004dbca4ef9c966218431ee5d9133d337ad018dd5b5c5493722803f75c64f7',[],[0,90,30,25]);
    assert.equal(decode('arbitrum',[fill],reg).ticks.length,0);
    assert.equal(decode('arbitrum',[deployed,fill],reg).ticks[0].rawRatio,3);
  }finally{reg.close()}
});
test('official vault and broker fills use CA ordering and isolate multi-asset routes',()=>{
  const b='0x0874b2d545cb271cdbda4e093020c452328b24af12382ed62c4d00f5c26709db',vault='0xba1333333333a1ba1108e8412f11850a5c319ba9';
  const forward=log(vault,b,[500,2,3],[100,300,0,0]);
  const reverse=log(vault,b,[500,3,2],[300,100,0,0]);
  const other=log(vault,b,[500,2,4],[100,500,0,0]);
  const swaps=decode('base',[forward,reverse,other,{...forward,address:address(77)}]).ticks;
  assert.deepEqual(swaps.map(x=>x.rawRatio),[3,3,5]);assert.equal(swaps[0].series,swaps[1].series);assert.notEqual(swaps[0].series,swaps[2].series);
  const t='0xe7b046415cac9de47940c3087e06db13a0e058ccf53ac5f0edd49ebb4c2c3a6f',broker='0x777a8255ca72412f0d706dc03c9d1987306b4cad';
  const pair=log(broker,t,[88,22,3],['0x22d9db95e6ae61c104a7b6f6c78d7993b94ec901',2,300,100]);
  assert.equal(decode('celo',[pair,log(broker,t,[88,22,3],[17,2,300,100])]).ticks.length,1);
  assert.deepEqual(decode('celo',[pair]).ticks.map(x=>[x.pool,x.rawRatio]),[[topic(88),3]]);
  const bancor=log('0xeef417e1d5cc832e619ae18d2f140de2999dd4fb','0x5c02c2bb2d1d082317eb23916ca27b3e7c294398b60061a2ad54f1c3c018c318',[111,3,2],[300,100,0,0,0,22]);
  assert.equal(decode('ethereum',[bancor]).ticks[0].pool,bancor.address);
  assert.equal(decode('ethereum',[bancor]).ticks[0].rawRatio,3);
});
test('Ambient distinguishes pool type indices and SyncSwap known pools accept swaps without standard Sync',()=>{
  const emitter='0xaaaaaaaacb71bf2c8cae522ea5fa455571a74106',signature='0x5d7a6c346454f5c536b7f52655e780f6db27b15b489f80f2dbb288c9e4f366bd';
  const croc=(idx,x,y)=>log(emitter,signature,[2,3],[idx,1,1,100,0,0,0,0,x,y]);
  const ticks=decode('scroll',[croc(1,-30,90),croc(2,30,-90),croc(2,30,90)]).ticks;
  assert.deepEqual(ticks.map(x=>x.rawRatio),[3,3]);assert.notEqual(ticks[0].series,ticks[1].series);
  const swap=log(address(23),'0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',[4,5],[20,0,0,60]);
  assert.equal(decode('scroll',[swap]).ticks.length,0);
  assert.deepEqual(decode('scroll',[swap],{poolVenue:()=> 'syncswap'}).ticks.map(x=>[x.series,x.rawRatio]),[['fill',3]]);
});

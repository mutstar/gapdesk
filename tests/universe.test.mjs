import test from 'node:test';
import assert from 'node:assert/strict';
import {discover,queueSlice} from '../lib/universe.mjs';
import {qualify} from '../lib/qualification.mjs';
import {NATIVE,CHAINS} from '../lib/assets.js';
import {steps} from '../lib/wallet.js';
const token='0x'+'1'.repeat(40),other='0x'+'2'.repeat(40),wallet='0x'+'3'.repeat(40);
const net=(chain=8453,addr=token)=>({chain,token:addr,decimals:6,tokenDecimals:6,deposit:true,withdraw:true,minOut:0,minIn:0,fee:0,rate:0});
const book=(price,size=1e6)=>({asks:[[price,size]],bids:[[price,size]],time:Date.now(),fee:0,step:.000001,min:1});
const cex=(id,price,n)=>({id,name:id,symbol:'ACE',pair:'ACE-USDT',kind:'CEX',venue:id,quote:'USDT',ask:price,bid:price,time:Date.now(),networks:n});
const dex=(id,price,chain=8453,addr=token)=>({id,name:id,symbol:'ACE',kind:'DEX',venue:'dex',chain,token:addr,decimals:6,pool:id,ask:price,bid:price,time:Date.now()});
test('raw ACE halt and namesake remain visible without qualifying',()=>{
 const cheap=dex('pool',1),otherAsset=dex('namesake',50,1,other),halt={...cex('halt',100,[net()]),observationOnly:true,venue:'bithumb',depositOpen:false,withdrawOpen:false};
 const u=discover([cheap,otherAsset,halt],1000,0);
 assert.equal(u.summaries[0].gap,9900);assert.equal(u.summaries[0].halt,true);assert.equal(u.candidates.length,0);
});
test('every persistent candidate receives verification time despite a permanent outlier',()=>{
 const items=Array.from({length:17},(_,i)=>({id:'pair'+i}));let cursor='',visited=new Set();
 for(let i=0;i<10;i++){const q=queueSlice(items,cursor);q.batch.forEach(x=>visited.add(x.id));cursor=q.next}
 assert.equal(visited.size,items.length);
});
test('exact budget and required sides are rechecked with depth, fees, and both FX legs',async()=>{
 const buy=cex('a',10,[net()]),sell=cex('b',12,[net()]),p={buy,sell};
 const io={nets:async m=>m.networks,book:async m=>({...book(m.ask),fx:book(1)})};
 const run=(f=5,override={})=>qualify(p,1000,f,wallet,{}, {...io,...override});
 assert.equal((await run()).profit,200);
 assert.equal(await run(201),null);
 assert.equal(await run(5,{nets:async m=>m===sell?[{...net(),deposit:false}]:[net()]}),null);
 assert.equal(await run(5,{book:async m=>book(m.ask,1)}),null);
 assert.equal(await run(5,{book:async m=>({...book(m.ask),fx:book(m===sell?1.3:1)})}),null);
 assert.equal(await run(5,{nets:async m=>m===buy?[{...net(),fee:49}]:[net()]}),null);
});
test('cross-chain non-native asset uses exact token, decimals and route quote at each step',async()=>{
 const b=dex('one',10),s=dex('two',14,56,other),seen=[];
 const io={gas:async()=>0,quote:async(a,z,src,dst,input)=>{
   seen.push({a,z,src,dst,input});const i=seen.length;return {fromDecimals:6,toDecimals:i===3?18:6,minimum:['100000000','99000000','1300000000000000000000'][i-1],tool:'dex',gas:0,duration:10}}};
 const result=await qualify({buy:b,sell:s},1000,5,wallet,{8453:1700,56:550},io);
 assert.equal(result.profit,300);assert.deepEqual(seen.map(x=>x.src),[CHAINS[8453].usdc,token,other]);
 assert.deepEqual(steps(result).map(x=>x.output),[token,other,CHAINS[56].usdc]);
 assert.equal(steps(result)[2].amount,'99000000');
 const unavailable={...io,quote:async(a,z)=>{if(a!==z)throw Error('no bridge');return {fromDecimals:6,toDecimals:6,minimum:'100000000',tool:'dex',gas:0,duration:0}}};
 assert.equal(await qualify({buy:b,sell:s},1000,5,wallet,{},unavailable),null);
});

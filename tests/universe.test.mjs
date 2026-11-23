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
 assert.equal(u.summaries[0].gap,null);assert.equal(u.summaries[0].halt,true);assert.equal(u.candidates.length,0);
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
test('strict spot qualification requires one chain and one issued CA even when a bridge quotes a conversion',async()=>{
 function deep(m){
  const stable=CHAINS[m.chain],now=Date.now(),reserve=1000000n;
  return {...m,time:now,block:99,blockTime:now,depth:{chain:m.chain,pool:m.pool,block:99,time:now,dexId:'uniswap',protocol:'v2',feePpm:3000,
   token0:m.token,token1:stable.usdc,decimals0:6,decimals1:stable.decimals,reserve0:String(reserve*1000000n),
   reserve1:String(reserve*BigInt(m.ask)*10n**BigInt(stable.decimals))}};
 }
 const b=deep(dex('one',10)),s=deep(dex('two',14)),seen=[];
 const io={gas:async()=>0,quote:async(a,z,src,dst,input)=>{
   seen.push({a,z,src,dst,input});const buy=src===CHAINS[a].usdc;
   return {fromChain:a,toChain:z,fromToken:src,toToken:dst,inputUnits:input,at:Date.now(),fromDecimals:6,toDecimals:6,
     minimum:buy?'100000000':'1390000000',tool:'dex',gas:0,duration:10}}};
 for(const t of [deep(dex('otherCA',14,8453,other)),deep(dex('otherChain',14,56,token))]){
   assert.equal(await qualify({buy:b,sell:t},1000,5,wallet,{},io),null);
 }
 assert.equal(seen.length,0);
 const result=await qualify({buy:b,sell:s},1000,5,wallet,{},io);
 assert.equal(result.profit,390);assert.deepEqual(result.match,{chain:8453,token});
 assert.deepEqual(seen.map(x=>x.src),[CHAINS[8453].usdc,token]);
 const poorMinimum={...io,quote:async(...args)=>{const q=await io.quote(...args);return q.toToken===CHAINS[8453].usdc?{...q,minimum:'1300000000'}:q}};
 assert.equal(await qualify({buy:b,sell:s},1000,5,wallet,{},poorMinimum),null);
 assert.equal(await qualify({buy:b,sell:{...s,depth:undefined}},1000,5,wallet,{},io),null);
 assert.deepEqual(steps(result).map(x=>x.output),[token,CHAINS[8453].usdc]);
});

test('RAIN namesakes on the same chain never form a spread even with deposits open',()=>{
 const buy=cex('KuCoin',.00327,[net(42161,token)]),sell=cex('Bitget',60.96,[net(42161,other)]);
 const {summaries:[row],candidates}=discover([buy,sell],1000,1);
 assert.equal(row.gap,null);assert.equal(row.buy,'');assert.equal(row.sell,'');
 assert.match(row.status,/컨트랙트 불일치/);assert.equal(candidates.length,0);
});
test('selects the next valid pair when an extreme venue cannot receive or send on the matching network',()=>{
 const buy=cex('cheap',1,[net()]),safe=cex('open',1.05,[net()]);
 const halted=cex('closed',60,[{...net(),deposit:false,depositOpen:false},net(56,other)]);
 const row=discover([buy,halted,safe],1000,1).summaries[0];
 assert.equal(row.buy,'cheap');assert.equal(row.sell,'open');assert.ok(Math.abs(row.gap-5)<1e-7);
 const blocked=discover([buy,halted],1000,1).summaries[0];
 assert.equal(blocked.gap,null);assert.match(blocked.status,/공통 네트워크 입금 중단/);
 assert.equal(discover([{...buy,networks:[{...net(),withdraw:false}]},safe],1000,1).summaries[0].gap,null);
 assert.equal(discover([buy,{...safe,networks:[{...net(),deposit:null}]}],1000,1).summaries[0].gap,null);
 assert.equal(discover([buy,{...safe,networkTime:Date.now()-46000}],1000,1).summaries[0].gap,null);
 assert.equal(discover([buy,{...safe,networks:[{...net(),minIn:2000}]}],1000,1).summaries[0].gap,null);
});

test('different ticker aliases meet only at a shared chain and contract; no CA or native placeholder never pairs',()=>{
 const x={...cex('X',1,[net()]),symbol:'XYZ'},y={...cex('Y',1.3,[net()]),symbol:'OTHER'};
 const scan=discover([x,y],1000,1);
 assert.equal(scan.summaries.length,1);assert.deepEqual(scan.summaries[0].aliases,['OTHER','XYZ']);
 assert.deepEqual(scan.summaries[0].match,{chain:8453,token});assert.ok(scan.candidates.length);
 for(const n of [[],[net(8453,NATIVE)],[net(8453,'bogus')]]){
   const r=discover([{...x,networks:n},{...y,networks:n}],1000,1,1,true);
   assert.equal(r.candidates.length,0);assert.equal(r.signalData.gaps.length,0);
 }
});

test('two chain-specific deposit addresses remain separate qualification candidates for the same venue pair',()=>{
 const chains=[net(),net(1,other)];
 const scan=discover([cex('X',1,chains),cex('Y',1.1,chains)],1000,1,1,true);
 assert.equal(scan.candidates.length,2);assert.equal(new Set(scan.candidates.map(c=>c.id)).size,2);
 assert.deepEqual(scan.signalData.gaps.map(c=>c.id).sort(),scan.candidates.map(c=>c.id).sort());
});

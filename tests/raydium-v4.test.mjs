import assert from 'node:assert/strict';
import test from 'node:test';
import {createSolanaWatcher,solanaActivities} from '../lib/solana-swaps.mjs';

const amm='675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',spl='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const pool='EP2ib6dYdEeqD8MfE2ezHCxX3kP3K2eLKkirfPm5eyMx',usdc='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const token='EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
function blockFor(tag,count){
  const accounts=Array(count).fill('other'),vault=count===8?3:count-13,user=count===8?5:count-3;
  accounts[0]=spl;accounts[1]=pool;accounts[vault]='base';accounts[vault+1]='quote';accounts[user]='sender';accounts[user+1]='receiver';
  const meta={transactionIndex:7,isCommitted:true};
  return {header:{number:123,timestamp:1800000000},instructions:[
    {...meta,instructionAddress:[2,0],programId:amm,d8:tag+'47d00100000000',accounts},
    {...meta,instructionAddress:[2,0,0],programId:spl,d8:'0x0347d00100000000',data:'3RUEY8AykGu5',accounts:['sender','base']},
    {...meta,instructionAddress:[2,0,1],programId:spl,d8:'0x03c81fae00000000',data:'3nw1m1tkYbbV',accounts:['quote','receiver']},
  ],tokenBalances:[{transactionIndex:7,account:'base',postMint:token,postDecimals:9},{transactionIndex:7,account:'quote',postMint:usdc,postDecimals:6}]};
}
test('AMM V4 legacy and compact instructions price the pool from actual user transfers',()=>{
  for(const [tag,count] of [['0x09',17],['0x0b',18],['0x10',8],['0x11',8]]){
    const b=blockFor(tag,count),{ticks}=solanaActivities([b]);
    assert.equal(ticks.length,1);assert.equal(ticks[0].protocol,'V4');assert.equal(ticks[0].pool,pool);
    assert.deepEqual(ticks[0].tokens,[token,usdc]);assert.equal(ticks[0].rawRatio,(11411400/1e6)/(118855/1e9));
    b.instructions[2].accounts[1]='settlement';assert.equal(solanaActivities([b]).ticks.length,0);
  }
  assert.equal(solanaActivities([blockFor('0x03',17)]).pools.length,0);
});
test('the normal Solana subscription requests byte tags and publishes a Raydium V4 market',async()=>{
  const b=blockFor('0x10',8);
  const registry={cursor:()=>122,commit:()=>{}};
  const watcher=createSolanaWatcher(registry,async(url,options)=>{
    if(url.endsWith('/head'))return Response.json({number:123});
    const query=JSON.parse(options.body),v=query.instructions.find(i=>i.programId.includes(amm));
    assert.deepEqual(v.d1,['0x09','0x0b','0x10','0x11']);
    assert.ok(v.transactionTokenBalances&&v.isCommitted&&v.innerInstructions);
    return new Response(JSON.stringify(b)+'\n');
  },()=>b.header.timestamp*1000);
  await watcher.refresh();
  assert.equal(watcher.coverage().processed,123);
  assert.equal(watcher.markets(()=>null)[0].name,'Raydium V4 · Solana');
});

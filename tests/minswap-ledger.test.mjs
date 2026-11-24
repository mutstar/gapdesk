import test from 'node:test';
import assert from 'node:assert/strict';
import {createMinswapLedger} from '../lib/minswap-ledger.mjs';

const poolScript='ea07b733d932129c378af627436e7cbc2ef0bf96e0036bb51b3bde6b';
const orderScript='c3e28c36c3447315ba5a56f33da6a6ddc1770a876a8d9f0cb3a97c4c';
const batcher='1eae96baf29e27682ea3f815aba361a0c6059d45e4bfbe95bbd2f44a';
const policy='f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c';
const hash=n=>n.toString(16).padStart(64,'0'),lp=hash(40),timestamp=1795492641;
function sample(id) {
  const asset=(p,n)=>({fields:[{bytes:p},{bytes:n}]});
  function pool(ra,rb) {
    return {payment_addr:{cred:poolScript},tx_hash:hash(30),tx_index:1,
      asset_list:[{policy_id:policy,asset_name:'4d5350',quantity:'1'},{policy_id:policy,asset_name:lp,quantity:'1'}],
      inline_datum:{value:{fields:[{},asset('',''),asset('e'.repeat(56),'01'),{int:100},{int:ra},{int:rb},0,0,0,0]}}};
  }
  const order={payment_addr:{cred:orderScript},tx_hash:hash(33),tx_index:0,
    inline_datum:{value:{fields:[0,0,0,0,0,asset(policy,lp),{constructor:0}]}}};
  const spend=(script_hash,utxo)=>({valid_contract:true,script_hash,input:{redeemer:{datum:{value:{constructor:0}}}},
    spends_input:utxo?{tx_hash:utxo.tx_hash,tx_index:utxo.tx_index}:null});
  const p=pool(2000,1000),q=pool(2100,960);
  return {tx_hash:hash(id),block_height:40,block_hash:hash(40),tx_timestamp:timestamp,tx_block_index:id,
    inputs:[p,order],outputs:[q],plutus_contracts:[spend(poolScript,p),spend(orderScript,order),spend(batcher)]};
}
function fixture() {
  const details=Array.from({length:6},(_,i)=>sample(i));
  details[1].inputs.push(details[1].inputs[1]); // multi-order batch
  details[2].inputs[1].inline_datum.value.fields[6].constructor=4; // liquidity deposit
  details[3].plutus_contracts[0].valid_contract=false;
  details[4].outputs[0].asset_list=[];
  details[5].inputs[1].inline_datum.value.fields[6].constructor=3;
  const ticks=[],state={cursor:{height:39,hash:hash(39),observed:0},omit:false};
  const registry={cursor:()=>state.cursor,commit(_p,_key,next,swaps=[]){state.cursor=next;ticks.push(...swaps)}};
  const request=async(url,opts)=>{
    const path=new URL(url).pathname.split('/').at(-1);
    if (path==='tip') return Response.json([{block_height:42,hash:hash(42)}]);
    if (path==='blocks') return Response.json([{block_height:40,hash:hash(40),parent_hash:hash(39),block_time:timestamp}]);
    if (path==='credential_txs') return Response.json(details.map(d=>({tx_hash:d.tx_hash,block_height:d.block_height})));
    const ids=JSON.parse(opts.body)._tx_hashes;
    return Response.json(details.filter(d=>ids.includes(d.tx_hash)&&!(state.omit&&d.tx_block_index===1)).reverse());
  };
  return {ticks,state,request,registry};
}

test('emits only single-order exact-in/out from the authenticated Minswap validator state transitions',async()=>{
  const {ticks,request,registry}=fixture(),watcher=createMinswapLedger(registry,request);
  await watcher.refresh();
  assert.deepEqual(ticks.map(t=>t.seq),[0,5]);
  assert.equal(ticks[0].rawRatio,960/2100);
  assert.equal(ticks[0].pool,policy+'.'+lp);
  assert.equal(watcher.coverage()[0].processed,40);
  await createMinswapLedger(registry,request).refresh();
  assert.equal(ticks.length,2);
});

test('incomplete Cardano details retry the same range without partial observations',async()=>{
  const {ticks,state,request,registry}=fixture(),watcher=createMinswapLedger(registry,request);
  state.omit=true;
  await watcher.refresh();
  assert.match(watcher.coverage()[0].error,/Missing Cardano transaction/);
  assert.equal(state.cursor.height,39);
  assert.equal(ticks.length,0);
  state.omit=false;
  await watcher.refresh();
  assert.equal(ticks.length,2);
});

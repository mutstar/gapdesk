import test from 'node:test';
import assert from 'node:assert/strict';

const coin='0xc27a719105a987b4c34116223cae8bd8f4b5def4';
const solMint='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

async function fixture(run) {
  const original=globalThis.fetch;
  const state={closed:false,old:false,wrong:false};
  const pair=(base,quote='USDT')=>({baseCoin:base,quoteCoin:quote,symbol:base+quote,quantityPrecision:'3',takerFeeRate:'0.002',minTradeUSDT:'1',status:state.closed?'offline':'online'});
  const token=symbol=>({coin:symbol,chains:[
    {chain:'BEP20',contractAddress:symbol==='ACE'?coin:null,withdrawable:'true',rechargeable:state.closed?'false':'true',needTag:'false',withdrawFee:'1',extraWithdrawFee:'0',withdrawMinScale:'3',withdrawStep:'0',minDepositAmount:'1',minWithdrawAmount:'2'},
    {chain:'SOL',contractAddress:solMint,withdrawable:'false',rechargeable:'true',needTag:'false',minDepositAmount:'1'}
  ]});
  globalThis.fetch=async url=>{
    const u=new URL(url),path=u.pathname,p=u.searchParams;
    if(u.hostname.includes('bithumb')){
      const data=path.includes('assetsstatus')?{ACE:{deposit_status:0,withdrawal_status:0}}:
        {timestamp:Date.now(),ACE:{order_currency:'ACE',asks:[{price:'130'}],bids:[{price:'120'}]},USDC:{order_currency:'USDC',asks:[{price:'1400'}],bids:[{price:'1300'}]}};
      return Response.json({status:'0000',data});
    }
    if(u.hostname.includes('kucoin'))return new Response('',{status:503});
    const pairs=[pair('ACE'),pair('USDC'),pair('FAKE'),pair('BNB')];
    let data;
    if(path.endsWith('/public/symbols'))data=p.has('symbol')?pairs.filter(x=>x.symbol===p.get('symbol')):pairs;
    else if(path.endsWith('/public/coins'))data=p.has('coin')?[token(state.wrong?'WRONG':p.get('coin'))]:pairs.map(v=>token(v.baseCoin));
    else if(path.endsWith('/market/tickers'))data=pairs.map(v=>({symbol:v.symbol,ts:Date.now(),askPr:v.baseCoin==='USDC'?'1.1':'11',bidPr:v.baseCoin==='USDC'?'1':'10'}));
    else if(path.endsWith('/orderbook'))data={ts:Date.now()-(state.old?80000:0),asks:[['12','1']],bids:[['11','1']]};
    else throw new Error('unexpected '+url);
    return Response.json({code:'00000',data});
  };
  try{const adapter=await import('../lib/cex-catalog.mjs?test='+Math.random());await run(adapter,state)}
  finally{globalThis.fetch=original}
}
test('catalog uses directional FX, retains observation-only markets and never guesses native contract',()=>fixture(async ({loadCex})=>{
  const {markets,sources}=await loadCex();
  const ace=markets.find(m=>m.id==='bitget:ACEUSDT');
  assert.equal(ace.ask,11);
  assert.equal(ace.bid,10/1.1);
  assert.equal(ace.networks[0].token,coin);
  assert.equal(ace.networks[1].token,solMint);
  assert.equal(markets.find(m=>m.id==='bitget:FAKEUSDT').networks.some(n=>n.chain===56),false);
  assert.equal(markets.find(m=>m.id==='bitget:BNBUSDT').networks.some(n=>n.chain===56),true);
  const krw=markets.find(m=>m.id==='bithumb:KRW-ACE');
  assert.equal(krw.ask,0.1);
  assert.equal(krw.depositOpen,false);
  assert.equal(krw.observationOnly,true);
  assert.equal(sources.find(s=>s.id==='kucoin').ok,false);
}));
test('projected opportunity requires a fresh target book, FX book, pair and network identity',()=>fixture(async ({loadCex,freshBook,freshNetworks},state)=>{
  const {markets}=await loadCex(),ace=markets.find(m=>m.id==='bitget:ACEUSDT');
  const book=await freshBook(ace);
  assert.deepEqual(book.fx.bids[0],[11,1]);
  assert.equal(book.fee,0.002);
  state.closed=true;
  assert.equal((await freshNetworks(ace))[0].deposit,false);
  await assert.rejects(freshBook(ace));
  state.closed=false;state.old=true;
  await assert.rejects(freshBook(ace));
  state.wrong=true;
  await assert.rejects(freshNetworks(ace));
  await assert.rejects(freshBook(markets.find(m=>m.venue==='bithumb')));
}));

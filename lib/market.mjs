import {CHAINS,DIAMOND,NATIVE} from './assets.js';
const probeAddress = '0x0000000000000000000000000000000000000001';
const KU = 'https://api.kucoin.com';
const BG = 'https://api.bitget.com';
const dexConfig = [{id:'base',chain:8453,name:'Base DEX'}, {id:'arb',chain:42161,name:'Arbitrum DEX'}];
export const MAX_AGE = 45000;
const cache = new Map();
async function json(url,ttl=0){
  const old = cache.get(url);
  if(old && Date.now()-old.time < ttl) return old.value;
  const r = await fetch(url,{signal:AbortSignal.timeout(8500),headers:{accept:'application/json'}});
  if(!r.ok) throw Error('피드 응답 '+r.status);
  const j = await r.json();
  if(j.code && !['200000','00000'].includes(String(j.code))) throw Error('피드 응답 오류');
  if(ttl) cache.set(url,{time:Date.now(),value:j});
  return j;
}
function numeric(x){
  if(x===null || x===undefined || x==='') throw Error('수치 누락');
  const n=Number(x); if(!Number.isFinite(n)||n<0) throw Error('수치 오류'); return n;
}
function ageOK(t){const age=Date.now()-Number(t);return age>=-5000 && age<MAX_AGE}
export function fill(levels, input, buy){
  let left=input,out=0;
  for(const [p,q] of levels){
    const price=numeric(p),size=numeric(q);if(!price) throw Error('호가 오류');
    const use=Math.min(left,buy?price*size:size);
    out+=buy?use/price:use*price;left-=use;
    if(left<=1e-10) return out;
  }
  throw Error('호가 잔량 부족');
}
async function exchange(id){
  const ku=id==='kucoin';
  const urls=ku?[
    KU+'/api/v1/market/orderbook/level2_20?symbol=ETH-USDC',KU+'/api/v3/currencies/ETH',KU+'/api/v2/symbols/ETH-USDC'
  ]:[BG+'/api/v2/spot/market/orderbook?symbol=ETHUSDC&type=step0&limit=50',BG+'/api/v2/spot/public/coins?coin=ETH',BG+'/api/v2/spot/public/symbols?symbol=ETHUSDC'];
  const [b,c,s]=await Promise.all(urls.map((url,i)=>json(url,[0,12000,60000][i])));
  const book=b.data, asset=ku?c.data:c.data[0], pair=ku?s.data:s.data[0];
  const time=numeric(ku?book.time:book.ts);
  if(!ageOK(time)||!(ku?pair.enableTrading===true:pair.status==='online')) throw Error('호가 지연 또는 거래 중단');
  const networks={};
  for(const c of asset.chains){
    const chain=({base:8453,arbitrum:42161,BASE:8453,ArbitrumOne:42161})[ku?c.chainId:c.chain];
    if(!chain||c.contractAddress) continue;
    networks[chain]={
      deposit:ku?c.isDepositEnabled===true:c.rechargeable==='true',
      withdraw:ku?c.isWithdrawEnabled===true:c.withdrawable==='true',
      fee:numeric(ku?c.withdrawMinFee:c.withdrawFee), rate:numeric(ku?c.withdrawFeeRate:c.extraWithdrawFee),
      minOut:numeric(ku?c.withdrawMinSize:c.minWithdrawAmount),minIn:numeric((ku?c.depositMinSize:c.minDepositAmount)??0),
      decimals:numeric(ku?c.withdrawPrecision:c.withdrawMinScale)
    };
  }
  return {id,name:ku?'KuCoin':'Bitget',kind:'CEX',networks,time,book,ask:numeric(book.asks[0][0]),bid:numeric(book.bids[0][0]),
    fee:ku?0.001*numeric(pair.takerFeeCoefficient):numeric(pair.takerFeeRate),step:ku?numeric(pair.baseIncrement):10**-numeric(pair.quantityPrecision),
    min:numeric(ku?pair.minFunds:pair.minTradeUSDT)};
}
export async function getQuote(from,to,input,output,units,address=probeAddress){
  const q = new URLSearchParams({fromChain:String(from),toChain:String(to),fromToken:input,toToken:output,
    fromAmount:units,fromAddress:address,toAddress:address,slippage:'0.003',integrator:'gapdesk'});
  const j=await json('https://li.quest/v1/quote?'+q);
  const a=j.action,e=j.estimate;
  if(!a||!e||a.fromChainId!==from||a.toChainId!==to||a.fromToken.address.toLowerCase()!==input||a.toToken.address.toLowerCase()!==output||
    BigInt(a.fromAmount)!==BigInt(units)||a.fromAddress.toLowerCase()!==address.toLowerCase()||a.toAddress.toLowerCase()!==address.toLowerCase()||BigInt(e.toAmountMin)<=0n)
    throw Error('견적 경로 불일치');
  const tx=j.transactionRequest;
  if(!tx || tx.to?.toLowerCase()!==DIAMOND || Number(tx.chainId)!==from || !/^0x[0-9a-f]+$/i.test(tx.data) ||
     BigInt(tx.value??0)!==(input===NATIVE?BigInt(units):0n) || (input!==NATIVE && e.approvalAddress?.toLowerCase()!==DIAMOND))
    throw Error('지원하지 않는 지갑 실행 방식');
  if(!Array.isArray(e.gasCosts)||!e.gasCosts.length)throw Error('가스 견적 누락');
  const external=(e.feeCosts||[]).filter(f=>f.included!==true);
  const gas=[...e.gasCosts,...external].reduce((n,g)=>n+numeric(g.amountUSD),0);
  return {fromDecimals:a.fromToken.decimals,toDecimals:a.toToken.decimals,minimum:e.toAmountMin,gas,duration:numeric(e.executionDuration),tool:j.toolDetails?.name||j.tool,tx:j.transactionRequest,approval:e.approvalAddress,at:Date.now()};
}
function ethUnits(x){return (BigInt(Math.floor(x*1e12))*1000000n).toString()}
const ethFloat=x=>Number(BigInt(x))/1e18;
const usdcUnits=x=>String(Math.floor(x*1e6));
function swap(f,buy,amount,address){return getQuote(f.chain,f.chain,buy?CHAINS[f.chain].usdc:NATIVE,buy?NATIVE:CHAINS[f.chain].usdc,buy?usdcUnits(amount):ethUnits(amount),address)}
async function dex(f,budget,address){
  const buy=await swap(f,true,budget,address);
  const quantity=ethFloat(buy.minimum);
  const sell=await swap(f,false,quantity,address);
  return {...f,kind:'DEX',buy,quantity,ask:budget/quantity,bid:Number(sell.minimum)/1e6/quantity,time:buy.at};
}
function networks(v,side){return v.kind==='DEX'?[v.chain]:Object.keys(v.networks).map(Number).filter(c=>v.networks[c][side]);}
function roundDown(x,step){return Math.floor(x/step)*step}
async function route(b,s,budget,threshold,address){
  if(!ageOK(b.time)||!ageOK(s.time))return null;
  if(b.kind==='CEX' && budget<b.min)return null;
  const qty=b.kind==='DEX'?b.quantity:roundDown(fill(b.book.asks,budget/(1+b.fee),true),b.step);
  const src=networks(b,'withdraw'),dst=networks(s,'deposit');
  const choices=src.flatMap(from=>dst.map(to=>({from,to}))).sort((x,y)=>(x.from!==x.to)-(y.from!==y.to));
  let best=null;
  for(const {from,to} of choices){
    try{
      let units=qty,gas=b.buy?.gas??0,bridge=null;
      if(b.kind==='CEX'){
        const n=b.networks[from];if(units<n.minOut)continue;
        units=roundDown(units,10**-n.decimals)-n.fee-units*n.rate;
      }
      if(units<=0)continue;
      const beforeBridge=units;
      if(from!==to){
        bridge=await getQuote(from,to,NATIVE,NATIVE,ethUnits(units),address);
        units=ethFloat(bridge.minimum);gas+=bridge.gas;
      }
      if(s.kind==='CEX' && units<s.networks[to].minIn)continue;
      // One USDC reserve for a separate native deposit transaction and L2 overhead.
      if(s.kind==='CEX' && (b.kind==='DEX'||bridge))gas+=1;
      const sell=s.kind==='DEX'?await swap(s,false,units,address):null;
      const proceeds=sell?Number(sell.minimum)/1e6:fill(s.book.bids,roundDown(units,s.step),false)*(1-s.fee);
      if(s.kind==='CEX' && proceeds<s.min)continue;
      gas+=sell?.gas??0;
      // Estimates use USD gas as USDC at par, with a 10% gas cushion.
      const cost=(gas+(b.kind==='DEX'?0.1:0))*1.1,profit=proceeds-budget-cost;
      if(profit<=0||profit<threshold||!ageOK(b.time)||!ageOK(s.time))continue;
      const r={id:b.id+'-'+s.id,source:b.id,dest:s.id,buy:b.name,sell:s.name,kind:[b.kind,s.kind].sort().join('–'),from,to,
        buyKind:b.kind,sellKind:s.kind,buyGas:b.buy?.gas??0,sellGas:sell?.gas??0,bridgeGas:bridge?.gas??0,buyTool:b.buy?.tool,sellTool:sell?.tool,bridge:bridge?.tool??null,duration:bridge?.duration??0,qty,arrival:units,beforeBridge,
        budget,proceeds,cost,profit,bps:profit/budget*100,expires:Math.min(b.time,s.time)+MAX_AGE};
      if(!best||r.profit>best.profit)best=r;
      if(from===to && best)break;
    }catch{continue}
  }
  return best;
}
export async function scan(budget,threshold,address=probeAddress,only){
  const configs=[['bitget','Bitget'],['kucoin','KuCoin'],...dexConfig.map(x=>[x.id,x.name])];
  const feeds=await Promise.allSettled([exchange('bitget'),exchange('kucoin'),...dexConfig.map(f=>dex(f,budget,address))]);
  const markets=[],sources=[];
  for(let i=0;i<feeds.length;i++){
    const f=feeds[i], [id,name]=configs[i];
    if(f.status==='fulfilled'){markets.push(f.value);sources.push({id,name,ok:true,ask:f.value.ask,bid:f.value.bid,time:f.value.time})}
    else sources.push({id,name,ok:false,reason:'견적 미수신'});
  }
  const jobs=[];let checked=0;
  for(const b of markets)for(const s of markets){
    if(b.id===s.id||only && b.id+'-'+s.id!==only)continue;
    checked++;
    if(s.bid>b.ask && (s.bid/b.ask-1)*budget>=threshold)jobs.push(route(b,s,budget,threshold,address).catch(()=>null));
  }
  const rows=(await Promise.all(jobs)).filter(Boolean).filter(r=>r.expires>Date.now()).sort((a,b)=>b.profit-a.profit);
  return {at:Date.now(),budget,checked,rows,sources};
}
export async function candles(){
 const j=await json(KU+'/api/v1/market/candles?type=1hour&symbol=ETH-USDC',45000);
 return j.data.slice(0,24).reverse().map(c=>({time:Number(c[0])*1000,price:numeric(c[2])}));
}


import {strictContractKey} from './contract-identity.mjs';
import {CHAINS,NATIVE,atomic,chainLabel} from './assets.js';
import {fill,getQuote,MAX_AGE} from './market.mjs';
import {isFreshQuoteAt} from './quote-freshness.mjs';
import {poolFill} from './pool-depth.mjs';
import {quoteImpact} from './quote-impact.mjs';
import {depthRecheckEntries} from './cloud-pool-depth.mjs';
import {freshBook,freshNetworks} from './cex-catalog.mjs';

export const probe='0x0000000000000000000000000000000000000001';
const same=(a,b)=>!!strictContractKey(a)&&strictContractKey(a)===strictContractKey(b);
export function paths(b,s){
 const src=b.kind==='DEX'?[b]:b.networks.filter(n=>n.withdraw===true);
 const dst=s.kind==='DEX'?[s]:s.networks.filter(n=>n.deposit===true);
 return src.flatMap(f=>dst.filter(t=>same(f,t)).map(t=>[f,t]));
}
const down=(n,step)=>{if(!(step>0))throw Error('주문 단위 누락');return Math.floor(n/step)*step};
function bookOrder(book,amount,buy){
 if(!book||!isFreshQuoteAt(book.time)||!Number.isFinite(book.fee)||book.fee<0)throw Error('유효 호가 없음');
 if(buy){
   const qty=down(fill(book.asks,amount/(1+book.fee),true),book.step);
   if(qty<=0||amount/(1+book.fee)<book.min)throw Error('최소 주문 미달');return qty;
 }
 const qty=down(amount,book.step),output=fill(book.bids,qty,false);
 if(qty<=0||output<book.min)throw Error('최소 주문 미달');
 return output*(1-book.fee);
}
export function cexBuy(book,usdc){return bookOrder(book,book.fx?bookOrder(book.fx,usdc,false):usdc,true)}
export function cexSell(book,qty){const quote=bookOrder(book,qty,false);return book.fx?bookOrder(book.fx,quote,true):quote}
function legQuoteTimes(market,fill,routerQuote){
 if(market.kind==='DEX')return [fill?.time,routerQuote?.at];
 const times=[market.book?.time];
 if(market.quote==='USDT'||market.book?.fx)times.push(market.book?.fx?.time);
 return times;
}
const memo= new Map();
async function rpc(chain,method,params){
 const r=await fetch(CHAINS[chain].rpc,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:1,jsonrpc:'2.0',method,params}),signal:AbortSignal.timeout(5000)});
 if(!r.ok)throw Error('RPC 응답 지연');const data=await r.json();if(!/^0x[0-9a-f]+$/i.test(data.result))throw Error('체인 응답 누락');return BigInt(data.result);
}
async function decimals(n){
 if(n.token===NATIVE)return 18;
 if(Number.isInteger(n.tokenDecimals??(n.kind==='DEX'?n.decimals:null)))return n.tokenDecimals??n.decimals;
 const k=n.chain+':'+n.token;if(memo.has(k))return memo.get(k);
 const v=Number(await rpc(n.chain,'eth_call',[{to:n.token,data:'0x313ce567'},'latest']));
 if(!Number.isInteger(v)||v>36)throw Error('토큰 단위 미확인');if(memo.size>15000)memo.clear();memo.set(k,v);return v;
}
async function operatingGas(chain,units,gasPrices){
 if(!units)return 0;
 const price=gasPrices[chain];if(!(price>0))throw Error('가스 토큰 시세 미확인');
 const gp=Number(await rpc(chain,'eth_gasPrice',[]));
 return gp/1e18*units*price+([8453,42161].includes(Number(chain)) ? 0.2 : 0);
}
export async function qualify(pair,budget,floor,address=probe,gasPrices={},io={},maxImpact=1){
 const readBook=io.book||freshBook,readNets=io.nets||freshNetworks,quote=io.quote||getQuote,gas=io.gas||operatingGas;
 let {buy:b,sell:s}=pair;
 if(b.observationOnly||s.observationOnly||b.tradeEnabled===false||s.tradeEnabled===false)return null;
 const buyFill=b.kind==='DEX'?poolFill(b,'buy',budget,maxImpact):null;
 if(b.kind==='DEX'&&!buyFill||s.kind==='DEX'&&!s.depth)return null;
 const prepare=async m=>{
   if(m.kind!=='CEX')return m;
   const [book,networks]=await Promise.all([readBook(m),readNets(m)]);
   return {...m,book,networks:networks.filter(n=>m.networks.some(original=>same(n,original)))};
 };
 [b,s]=await Promise.all([prepare(b),prepare(s)]);
 const deadline=Date.now()+20000;
 const allowed=paths(b,s).filter(([f])=>!pair.match||same(f,pair.match));let belowFloor=0;
 for(const [f,t] of allowed){
   if(Date.now()>deadline)break;
   try{
    const from=f.chain,to=t.chain,bridged=!same(f,t),onchain=b.kind==='DEX'||s.kind==='DEX'||bridged;
    const fd=onchain?await decimals(f):null,td=onchain?await decimals(t):null;
    const started=Date.now();
    let buyQ=null,bridgeQ=null,sellQ=null,gasCosts=0,depositGas=0,approvalGas=0;
    if(b.kind==='DEX')buyQ=await quote(from,from,CHAINS[from].usdc,f.token,atomic(budget,CHAINS[from].decimals),address);
    if(buyQ && (buyQ.fromDecimals!==CHAINS[from].decimals||buyQ.toDecimals!==fd))continue;
    const buyImpact=buyQ?quoteImpact({market:{...b,spotAsk:buyFill.spotPrice},side:'buy',inputUnits:atomic(budget,CHAINS[from].decimals),quote:buyQ,maxImpactPct:maxImpact}):null;
    if(buyQ&&!buyImpact)continue;
    const qty=buyQ?Number(buyQ.minimum)/10**fd:cexBuy(b.book,budget);
    let beforeBridge=qty;
    if(b.kind==='CEX'){
      if(![f.minOut,f.fee,f.rate,f.decimals].every(Number.isFinite)||qty<f.minOut||f.maxOut!=null&&qty>f.maxOut)continue;
      const withdraw=down(qty,10**-f.decimals);if(withdraw<f.minOut)continue;
      beforeBridge=withdraw-f.fee-withdraw*f.rate;
    }
    if(!(beforeBridge>0))continue;
    const bridgeInput=onchain?(buyQ?buyQ.minimum:atomic(beforeBridge,fd)):null;
    if(bridged)bridgeQ=await quote(from,to,f.token,t.token,bridgeInput,address);
    if(bridgeQ && (bridgeQ.fromDecimals!==fd||bridgeQ.toDecimals!==td))continue;
    const sellInput=bridgeQ?.minimum??bridgeInput;
    const arrival=onchain?Number(sellInput)/10**td:beforeBridge;
    if(s.kind==='CEX'&&(!Number.isFinite(t.minIn)||arrival<t.minIn||t.maxIn!=null&&arrival>t.maxIn))continue;
    const sellFill=s.kind==='DEX'?poolFill(s,'sell',arrival,maxImpact):null;
    if(s.kind==='DEX'&&!sellFill)continue;
    if(s.kind==='DEX')sellQ=await quote(to,to,t.token,CHAINS[to].usdc,sellInput,address);
    if(sellQ && (sellQ.fromDecimals!==td||sellQ.toDecimals!==CHAINS[to].decimals))continue;
    const sellImpact=sellQ?quoteImpact({market:{...s,spotBid:sellFill.spotPrice},side:'sell',inputUnits:sellInput,quote:sellQ,maxImpactPct:maxImpact}):null;
    if(sellQ&&!sellImpact)continue;
    const proceeds=sellQ?Number(sellQ.minimum)/10**CHAINS[to].decimals:cexSell(s.book,arrival);
    const buyTimes=legQuoteTimes(b,buyFill,buyQ),sellTimes=legQuoteTimes(s,sellFill,sellQ);
    const times=[...buyTimes,...sellTimes,...(bridgeQ?[bridgeQ.at]:[]),started];
    if(!times.every(at=>isFreshQuoteAt(at)))continue;
    if(Number.isFinite(proceeds)&&(proceeds<budget+floor||proceeds<=budget)){belowFloor++;continue}
    if(buyQ)approvalGas+=await gas(from,80000,gasPrices);
    if(bridgeQ&&f.token!==NATIVE)approvalGas+=await gas(from,80000,gasPrices);
    if(sellQ&&t.token!==NATIVE)approvalGas+=await gas(to,80000,gasPrices);
    if(s.kind==='CEX'&&(buyQ||bridgeQ))depositGas=await gas(to,t.token===NATIVE?42000:120000,gasPrices);
    gasCosts=1.1*((buyQ?.gas||0)+(bridgeQ?.gas||0)+(sellQ?.gas||0)+approvalGas+depositGas);
    const profit=proceeds-budget-gasCosts;
    if(!times.every(at=>isFreshQuoteAt(at)))continue;
    if(!(profit>0&&profit>=floor)){if(Number.isFinite(profit))belowFloor++;continue}
    return {id:pair.id??(b.id+'|'+s.id),symbol:b.symbol,source:b.id,dest:s.id,buy:b.kind==='DEX'?(buyQ.tool+' · '+chainLabel(from)):b.name,
     sell:s.kind==='DEX'?(sellQ.tool+' · '+chainLabel(to)):s.name,buyKind:b.kind,sellKind:s.kind,kind:[b.kind,s.kind].sort().join('–'),from,to,
     match:{chain:from,token:f.token},maxImpact,depthChecks:[['buy',b,buyFill,buyImpact],['sell',s,sellFill,sellImpact]].filter(([, ,fill])=>fill).map(([side,m,fill,impact])=>({
       side,chain:m.chain,pool:m.pool,block:fill.block,method:fill.method,poolImpactPct:fill.impactPct,quoteImpactPct:impact.impactPct,
       entries:depthRecheckEntries(m,fill)
     })),
     buyVenue:b.venue,sellVenue:s.venue,buyPair:b.pair,sellPair:s.pair,buyQuote:b.quote,sellQuote:s.quote,
     fromToken:f.token,toToken:t.token,fromDecimals:fd,toDecimals:td,buyUnits:buyQ?atomic(budget,CHAINS[from].decimals):null,buyMin:buyQ?.minimum,
     bridgeInput,bridgeMin:bridgeQ?.minimum,sellInput,sellMin:sellQ?.minimum,
     buyGas:buyQ?.gas||0,bridgeGas:bridgeQ?.gas||0,sellGas:sellQ?.gas||0,bridge:bridgeQ?.tool||null,duration:bridgeQ?.duration||0,
     gasPriceFrom:gasPrices[from],gasPriceTo:gasPrices[to],approvalGas,depositGas,
     qty,beforeBridge,arrival,budget,cost:gasCosts,profit,bps:profit/budget*100,proceeds,
     buyQuoteAt:Math.min(...buyTimes),sellQuoteAt:Math.min(...sellTimes),expires:Math.min(...times)+MAX_AGE};
   }catch{continue}
 }
 if(allowed.length>0&&belowFloor===allowed.length)io.onBelowFloor?.();
 return null;
}

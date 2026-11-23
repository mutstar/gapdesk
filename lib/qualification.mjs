import {strictContractKey} from './contract-identity.mjs';
import {CHAINS,NATIVE,atomic,chainLabel} from './assets.js';
import {fill,getQuote,MAX_AGE} from './market.mjs';
import {amountText as fmt,checkTime,diagnoseError,QuoteFailure,refuse} from './qualification-evidence.mjs';
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
function bookOrder(book,amount,buy,label,base,quote){
 checkTime(book?.time,label);
 if(!Number.isFinite(book.fee)||book.fee<0||book.fee>=1||!(book.step>0)||!Number.isFinite(book.min))
   refuse('unverified',label+'의 거래 수수료 또는 주문 단위를 확인할 수 없어요.');
 const input=buy?amount/(1+book.fee):down(amount,book.step);
 const levels=buy?book.asks:book.bids;
 if(!Array.isArray(levels)||!levels.length)refuse('depth_unverified',label+'의 호가 잔량이 수신되지 않았어요.');
 let output;
 try{output=fill(levels,input,buy)}catch(error){
   if(error.message!=='호가 잔량 부족')throw error;
   const available=levels.reduce((n,[price,size])=>n+Number(size)*(buy?Number(price):1),0);
   refuse('depth',label+'에서 확인한 잔량 '+fmt(available)+' '+(buy?quote:base)+' · 주문에 필요한 수량 '+fmt(input)+' '+(buy?quote:base));
 }
 const qty=buy?down(output,book.step):input;
 if(!(qty>0))refuse('order_limit',label+'의 주문 단위 '+fmt(book.step)+' '+base+'에 미달해요.');
 if((buy?input:output)<book.min)refuse('order_limit',label+' 주문액 '+fmt(buy?input:output)+' '+quote+' · 최소 주문액 '+fmt(book.min)+' '+quote);
 return buy?qty:output*(1-book.fee);
}
export function cexBuy(book,usdc,market={}){
 const venue=market.name||market.venue||'거래소';
 const input=book?.fx?bookOrder(book.fx,usdc,false,venue+' 환전 호가','USDC','USDT'):usdc;
 return bookOrder(book,input,true,venue+' 매수 호가',market.symbol||'토큰',market.quote||'USDC');
}
export function cexSell(book,qty,market={}){
 const venue=market.name||market.venue||'거래소';
 const proceeds=bookOrder(book,qty,false,venue+' 매도 호가',market.symbol||'토큰',market.quote||'USDC');
 return book?.fx?bookOrder(book.fx,proceeds,true,venue+' 환전 호가','USDC','USDT'):proceeds;
}
function legQuoteTimes(market,fill,routerQuote){
 if(market.kind==='DEX')return [fill?.time,routerQuote?.at];
 const times=[market.book?.time];
 if(market.quote==='USDT'||market.book?.fx)times.push(market.book?.fx?.time);
 return times;
}
function poolEstimate(market,side,input,maxImpact){
 const label=market.name+' '+(side==='buy'?'매수':'매도')+' 풀';
 if(!market.depth)refuse('depth_unverified',label+'의 동일 블록 유동성 자료가 없어요.');
 checkTime(market.time,label+' 가격');
 checkTime(market.depth.time,label+' 블록');
 const estimate=poolFill(market,side,input,maxImpact,pct=>{
   refuse('slippage',label+' 체결가가 기준가보다 '+fmt(pct)+'% 불리해요. 설정 한도는 '+fmt(maxImpact)+'%예요.');
 });
 if(!estimate)refuse('depth_unverified',label+'에서 '+fmt(input)+' '+(side==='buy'?'USDC':market.symbol)+' 전량을 체결할 수 있는 깊이를 확인하지 못했어요.');
 return estimate;
}
function routerEstimate(market,side,pool,inputUnits,quote,maxImpact){
 const buy=side==='buy',label=market.name+' '+(buy?'매수':'매도')+' 라우터';
 checkTime(quote?.at,label);
 const result=quoteImpact({market:{...market,[buy?'spotAsk':'spotBid']:pool.spotPrice},side,inputUnits,quote,maxImpactPct:maxImpact,
   onImpactExceeded:pct=>refuse('slippage',label+' 최소 수령량 기준 체결가가 풀 기준가보다 '+fmt(pct)+'% 불리해요. 설정 한도는 '+fmt(maxImpact)+'%예요.')});
 if(!result)refuse('unverified',label+' 견적과 해당 풀의 토큰·수량을 대조하지 못했어요.');
 return result;
}
function noTransfer(b,s,match){
 const src=b.kind==='CEX'?b.networks:[b],dst=s.kind==='CEX'?s.networks:[s];
 const pairs=src.flatMap(f=>dst.filter(t=>same(f,t)&&(!match||same(match,t))).map(t=>[f,t]));
 if(pairs.length && s.kind==='CEX' && pairs.every(([,t])=>t.depositOpen===false))
   return {code:'deposit_closed',detail:s.name+'에서 일치하는 체인·CA의 입금이 중단됐어요.'};
 if(pairs.length && b.kind==='CEX' && pairs.every(([f])=>f.withdrawOpen===false))
   return {code:'withdraw_closed',detail:b.name+'에서 일치하는 체인·CA의 출금이 중단됐어요.'};
 return {code:'transfer_unverified',detail:'같은 체인·CA에서 매수처 출금과 매도처 입금을 모두 확인하지 못했어요.'};
}
function noFees(book){return {...book,fee:0,fx:book.fx?{...book.fx,fee:0}:null}}
function cexGrossProfit(b,s,budget,f){
 // Replay the exact same ladders and lot sizes, excluding trading/withdrawal fees only.
 // If the larger fee-free order cannot be priced, the cause stays unconfirmed.
 if(b.kind!=='CEX'||s.kind!=='CEX')return null;
 try{
   const qty=down(cexBuy(noFees(b.book),budget,b),10**-f.decimals);
   return cexSell(noFees(s.book),qty,s)-budget;
 }catch{return null}
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
 const stop=diagnosis=>{io.onDiagnosis?.(diagnosis);return null};
 if(b.observationOnly||s.observationOnly||b.tradeEnabled===false||s.tradeEnabled===false)return stop({code:'unverified',detail:'이 마켓은 실행 가능한 거래 조건을 확인하지 못했어요.'});
 let buyFill=null;
 try{
   if(b.kind==='DEX')buyFill=poolEstimate(b,'buy',budget,maxImpact);
   if(s.kind==='DEX'&&!s.depth)refuse('depth_unverified',s.name+' 매도 풀의 동일 블록 유동성 자료가 없어요.');
 }catch(error){return stop(diagnoseError(error,'DEX 풀 견적을 확인하지 못했어요.'))}
 const prepare=async m=>{
   if(m.kind!=='CEX')return m;
   const label=m.name||m.venue||'거래소';
   const [book,networks]=await Promise.all([
     Promise.resolve().then(()=>readBook(m)).catch(error=>{if(error instanceof QuoteFailure)throw error;refuse('unverified',label+'의 정밀 호가와 거래 규칙을 받지 못했어요.')}),
     Promise.resolve().then(()=>readNets(m)).catch(()=>refuse('transfer_unverified',label+'의 체인별 입출금 정보를 받지 못했어요.'))
   ]);
   return {...m,book,networks:networks.filter(n=>m.networks.some(original=>same(n,original)))};
 };
 try{[b,s]=await Promise.all([prepare(b),prepare(s)])}
 catch(error){return stop(diagnoseError(error,'거래소 호가 또는 입출금 정보를 받지 못했어요.'))}
 const deadline=Date.now()+20000;
 const allowed=paths(b,s).filter(([f])=>!pair.match||same(f,pair.match));let belowFloor=0;
 if(!allowed.length)return stop(noTransfer(b,s,pair.match));
 try{
   for(const m of [b,s]){
     if(m.kind!=='CEX')continue;
     checkTime(m.book?.time,(m.name||'거래소')+(m===b?' 매수':' 매도')+' 호가');
     if(m.quote==='USDT'||m.book?.fx)checkTime(m.book?.fx?.time,(m.name||'거래소')+' 환전 호가');
   }
 }catch(error){return stop(diagnoseError(error,'정밀 호가의 기준 시각을 확인하지 못했어요.'))}
 let best=null,bestStage=-1,bestNet=-Infinity;
 for(const [f,t] of allowed){
   if(Date.now()>deadline)break;
   let stage=0,net=-Infinity,fallback='토큰 수량 단위를 확인하지 못했어요.';
   try{
    const from=f.chain,to=t.chain,bridged=!same(f,t),onchain=b.kind==='DEX'||s.kind==='DEX'||bridged;
    const fd=onchain?await decimals(f):null,td=onchain?await decimals(t):null;
    const started=Date.now();
    let buyQ=null,bridgeQ=null,sellQ=null,gasCosts=0,depositGas=0,approvalGas=0;
    stage=1;fallback='매수 라우터에서 요청한 금액의 견적을 받지 못했어요.';
    if(b.kind==='DEX')buyQ=await quote(from,from,CHAINS[from].usdc,f.token,atomic(budget,CHAINS[from].decimals),address);
    if(buyQ && (buyQ.fromDecimals!==CHAINS[from].decimals||buyQ.toDecimals!==fd))refuse('unverified','매수 견적의 토큰 소수점 단위가 일치하지 않아요.');
    const buyImpact=b.kind==='DEX'?routerEstimate(b,'buy',buyFill,atomic(budget,CHAINS[from].decimals),buyQ,maxImpact):null;
    const qty=buyQ?Number(buyQ.minimum)/10**fd:cexBuy(b.book,budget,b);
    let beforeBridge=qty;
    stage=2;
    if(b.kind==='CEX'){
      if(![f.minOut,f.fee,f.rate,f.decimals].every(Number.isFinite))refuse('transfer_unverified',b.name+'의 출금 수수료와 한도를 확인하지 못했어요.');
      const withdraw=down(qty,10**-f.decimals);
      if(!(withdraw>0))refuse('transfer_limit',b.name+' 출금 수량 '+fmt(qty)+' '+b.symbol+'가 출금 단위 '+fmt(10**-f.decimals)+' '+b.symbol+'에 미달해요.');
      if(withdraw<f.minOut||f.maxOut!=null&&qty>f.maxOut)refuse('transfer_limit',b.name+' 출금 수량 '+fmt(qty)+' '+b.symbol+' · '+(withdraw<f.minOut?'최소 '+fmt(f.minOut):'최대 '+fmt(f.maxOut))+' '+b.symbol);
      beforeBridge=withdraw-f.fee-withdraw*f.rate;
      if(!(beforeBridge>0))refuse('fees',b.name+' 출금 수수료 '+fmt(f.fee+withdraw*f.rate)+' '+b.symbol+'를 빼면 전송 가능한 수량이 없어요.');
    }
    if(!(beforeBridge>0))refuse('unverified','유효한 매수 수량을 확인하지 못했어요.');
    const bridgeInput=onchain?(buyQ?buyQ.minimum:atomic(beforeBridge,fd)):null;
    fallback='브리지 견적을 확인하지 못했어요.';
    if(bridged)bridgeQ=await quote(from,to,f.token,t.token,bridgeInput,address);
    if(bridgeQ && (bridgeQ.fromDecimals!==fd||bridgeQ.toDecimals!==td))refuse('unverified','브리지 견적의 토큰 소수점 단위가 일치하지 않아요.');
    const sellInput=bridgeQ?.minimum??bridgeInput;
    const arrival=onchain?Number(sellInput)/10**td:beforeBridge;
    if(s.kind==='CEX'){
      if(!Number.isFinite(t.minIn))refuse('transfer_unverified',s.name+'의 최소 입금량을 확인하지 못했어요.');
      if(arrival<t.minIn||t.maxIn!=null&&arrival>t.maxIn)refuse('transfer_limit',s.name+' 도착 예정 '+fmt(arrival)+' '+s.symbol+' · '+(arrival<t.minIn?'최소 입금 '+fmt(t.minIn):'최대 입금 '+fmt(t.maxIn))+' '+s.symbol);
    }
    stage=3;fallback='매도 라우터에서 도착 수량의 견적을 받지 못했어요.';
    const sellFill=s.kind==='DEX'?poolEstimate(s,'sell',arrival,maxImpact):null;
    if(s.kind==='DEX')sellQ=await quote(to,to,t.token,CHAINS[to].usdc,sellInput,address);
    if(sellQ && (sellQ.fromDecimals!==td||sellQ.toDecimals!==CHAINS[to].decimals))refuse('unverified','매도 견적의 토큰 소수점 단위가 일치하지 않아요.');
    const sellImpact=s.kind==='DEX'?routerEstimate(s,'sell',sellFill,sellInput,sellQ,maxImpact):null;
    const proceeds=sellQ?Number(sellQ.minimum)/10**CHAINS[to].decimals:cexSell(s.book,arrival,s);
    const buyTimes=legQuoteTimes(b,buyFill,buyQ),sellTimes=legQuoteTimes(s,sellFill,sellQ);
    const times=[...buyTimes,...sellTimes,...(bridgeQ?[bridgeQ.at]:[]),started];
    const checkTimes=()=>{
      for(const at of buyTimes)checkTime(at,(b.name||'매수처')+' 매수 견적');
      for(const at of sellTimes)checkTime(at,(s.name||'매도처')+' 매도 견적');
      if(bridgeQ)checkTime(bridgeQ.at,'브리지 견적');
      checkTime(started,'경로 견적');
    };
    checkTimes();
    if(Number.isFinite(proceeds)&&(proceeds<budget+floor||proceeds<=budget)){
      belowFloor++;
      net=proceeds-budget;stage=4;
      const gross=io.onDiagnosis?cexGrossProfit(b,s,budget,f):null;
      const feeCause=Number.isFinite(gross)&&gross>0&&gross>=floor;
      const report=feeCause?'같은 호가에서 수수료 전 '+fmt(gross)+' USDC · 거래·출금 수수료 반영 후 ':
        (onchain?'가스비 차감 전 차익 ':'정밀 호가·수수료 반영 후 차익 ');
      refuse(feeCause?'fees':'below_floor',report+fmt(net)+' USDC · 최소 순차익 '+fmt(floor)+' USDC'+(floor===0?' (양수 필요)':''));
    }
    stage=4;fallback='가스비와 승인 비용을 확인하지 못했어요.';
    if(buyQ)approvalGas+=await gas(from,80000,gasPrices);
    if(bridgeQ&&f.token!==NATIVE)approvalGas+=await gas(from,80000,gasPrices);
    if(sellQ&&t.token!==NATIVE)approvalGas+=await gas(to,80000,gasPrices);
    if(s.kind==='CEX'&&(buyQ||bridgeQ))depositGas=await gas(to,t.token===NATIVE?42000:120000,gasPrices);
    gasCosts=1.1*((buyQ?.gas||0)+(bridgeQ?.gas||0)+(sellQ?.gas||0)+approvalGas+depositGas);
    const profit=proceeds-budget-gasCosts;
    checkTimes();
    if(!Number.isFinite(profit))refuse('unverified','비용을 반영한 예상 순차익을 계산하지 못했어요.');
    if(!(profit>0&&profit>=floor)){
      belowFloor++;stage=5;net=profit;
      refuse('fees','별도 비용 차감 전 '+fmt(proceeds-budget)+' USDC · 가스비 등 '+fmt(gasCosts)+' USDC · 순차익 '+fmt(profit)+' USDC (최소 '+fmt(floor)+' USDC'+(floor===0?', 양수 필요':'')+')');
    }
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
   }catch(error){
     if(stage>bestStage || stage===bestStage&&net>bestNet){
       bestStage=stage;bestNet=net;best=diagnoseError(error,fallback);
     }
   }
 }
 if(belowFloor===allowed.length)io.onBelowFloor?.();
 return stop(best??{code:'unverified',detail:'검증 시간 내에 정밀 견적을 받지 못했어요.'});
}

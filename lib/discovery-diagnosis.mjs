import {strictContractKey,spotRouteId} from './contract-identity.mjs';
import {chainLabel} from './assets.js';
import {QUOTE_MAX_AGE_MS} from './quote-freshness.mjs';

const fmt=new Intl.NumberFormat('ko-KR',{maximumSignificantDigits:5});
const num=value=>fmt.format(value);
const reason=(code,detail)=>({code,detail});
const sideName=buy=>buy?'매수':'매도';

export function priceGap(buy,sell,match,ask,bid,time,diagnosis){
  return {id:spotRouteId(buy.id,sell.id,match),symbol:String(buy.symbol).trim().toUpperCase(),match,kind:'spot_spot',
    buy:{id:buy.id,name:buy.name,kind:buy.kind},sell:{id:sell.id,name:sell.name,kind:sell.kind},
    ask,bid,gap:(bid/ask-1)*100,time,buyQuoteAt:buy.time,sellQuoteAt:sell.time,
    networkAt:[buy.networkTime,sell.networkTime].filter(Number.isFinite).sort((a,b)=>a-b)[0]??null,diagnosis};
}

export function observedDiagnosis(b,s,match,budget,floor,ask,bid){
  const gross=budget*(bid/ask-1);
  if(gross<floor)return reason('gross_below_floor','추가 비용 전 예상 차익 '+num(gross)+' USDC · 목표 '+num(floor)+' USDC');
  // Both best prices bound an order-book fill. Ignore FX fees, lot rounding,
  // depth and gas to keep this an optimistic bound on the quoted prices.
  if(b.kind==='CEX'&&s.kind==='CEX'&&[b.tradeFee,s.tradeFee].every(v=>Number.isFinite(v)&&v>=0&&v<1)){
    const asset=strictContractKey(match);
    const networks=b.networks.filter(n=>n.withdraw===true&&strictContractKey(n)===asset);
    const qty=budget/(1+b.tradeFee)/ask;
    if(networks.length && networks.every(n=>Number.isFinite(n.rate)&&n.rate>=0&&n.rate<1&&Number.isFinite(n.fee)&&n.fee>=0)){
      const arrival=Math.max(0,...networks.map(n=>qty*(1-n.rate)-n.fee));
      const best=arrival*bid*(1-s.tradeFee)-budget;
      if(best<floor||best<=0)return reason('fees','관찰 호가와 공시 거래·출금 수수료 기준 예상 순차익 최대 '+num(best)+' USDC · 목표 '+num(floor)+' USDC');
    }
  }
  return reason('pending','금액별 호가 잔량과 최종 비용 검증 대기');
}

function networkLimits(b,s,from,to,qty){
  if(qty===null)return null;
  const symbol=b.symbol;
  if(b.kind==='CEX'){
    if(![from.minOut,from.fee,from.rate,from.decimals].every(Number.isFinite))
      return reason('transfer_unverified',b.name+' 출금 수수료 또는 수량 조건 미확인');
    const unit=10**-from.decimals;
    qty=Math.floor(qty/unit)*unit;
    if(qty<from.minOut)return reason('transfer_limit',b.name+' 예상 출금 '+num(qty)+' '+symbol+' · 최소 '+num(from.minOut)+' '+symbol);
    if(from.maxOut!=null&&qty>from.maxOut)return reason('transfer_limit',b.name+' 예상 출금 '+num(qty)+' '+symbol+' · 최대 '+num(from.maxOut)+' '+symbol);
    const fee=from.fee+qty*from.rate;
    if(qty<=fee)return reason('fees',b.name+' 예상 출금 '+num(qty)+' '+symbol+' · 출금 수수료 '+num(fee)+' '+symbol);
    qty-=fee;
  }
  if(!(qty>0))return reason('transfer_unverified','도착 수량을 확인할 수 없어요');
  if(s.kind==='CEX'){
    if(!Number.isFinite(to.minIn))return reason('transfer_unverified',s.name+' 최소 입금 수량 미확인');
    if(qty<to.minIn)return reason('transfer_limit',s.name+' 예상 입금 '+num(qty)+' '+s.symbol+' · 최소 '+num(to.minIn)+' '+s.symbol);
    if(to.maxIn!=null&&qty>to.maxIn)return reason('transfer_limit',s.name+' 예상 입금 '+num(qty)+' '+s.symbol+' · 최대 '+num(to.maxIn)+' '+s.symbol);
  }
  return null;
}

// Some venues list more than one transfer record for a contract. A suspension
// is definitive only when every matching record explicitly closes this direction.
export function transferDiagnosis(b,s,key,quantity){
  const from=b.kind==='DEX'?[b]:b.networks.filter(n=>strictContractKey(n)===key);
  const to=s.kind==='DEX'?[s]:s.networks.filter(n=>strictContractKey(n)===key);
  const source=b.kind==='DEX'?from:from.filter(n=>n.withdraw===true);
  const dest=s.kind==='DEX'?to:to.filter(n=>n.deposit===true);
  const chain=chainLabel(key.slice(0,key.indexOf(':')));
  const withdrawClosed=!source.length&&from.length&&from.every(n=>n.withdrawOpen===false);
  const depositClosed=!dest.length&&to.length&&to.every(n=>n.depositOpen===false);
  if(withdrawClosed)return reason('withdraw_closed',chain+' · '+b.name+' 출금 중단'+(depositClosed?' · '+s.name+' 입금 중단':''));
  if(depositClosed)return reason('deposit_closed',chain+' · '+s.name+' 입금 중단');
  if(!source.length)return reason('transfer_unverified',b.name+' 출금 상태·수수료·요건을 모두 확인할 수 없어요');
  if(!dest.length)return reason('transfer_unverified',s.name+' 입금 상태·요건을 모두 확인할 수 없어요');
  let failure;
  for(const f of source)for(const t of dest){
    const issue=networkLimits(b,s,f,t,quantity);
    if(!issue)return null;
    failure=failure&&failure.detail!==issue.detail?reason('transfer_limit','같은 CA의 입출금 조합에서 이 수량의 전송을 확인할 수 없어요'):issue;
  }
  return failure;
}

export function quoteDiagnosis(b,s,now){
  for(const [market,buy] of [[b,true],[s,false]]){
    const side=market.name+' '+sideName(buy);
    if(now-market.time>=QUOTE_MAX_AGE_MS)return reason('stale_quote',side+' 호가가 '+Math.floor((now-market.time)/1000)+'초 지났어요 · 유효 시간 45초');
    if(market.kind==='CEX'&&market.networkTime===0)return reason('transfer_unverified',market.name+' 입출금 상태 시각 미확인');
    if(market.kind==='CEX'&&market.networkTime>0&&now-market.networkTime>=QUOTE_MAX_AGE_MS)
      return reason('stale_network',market.name+' 입출금 상태를 확인한 지 '+Math.floor((now-market.networkTime)/1000)+'초 지났어요');
    if(market.quoteReady===false)return reason('unverified',side+' 호가 또는 환산 시세 미확인');
    if(market.tradeEnabled===false)return reason('market_unavailable',market.name+' 현물 거래 가능 상태 미확인');
  }
  return null;
}

export function dexDiagnosis(m,buy,pct,maxImpact,budget){
  const side=m.name+' '+sideName(buy);
  if(Number.isFinite(pct)&&pct>maxImpact)return reason('slippage',side+' 시 풀 기준가 대비 '+num(pct)+'% 불리 · 한도 '+num(maxImpact)+'% (풀 수수료 포함)');
  return reason('depth_unverified',side+' 풀에서 '+num(budget)+' USDC 기준 체결 수량을 확인할 수 없어요');
}

export function filledSpreadDiagnosis(b,s,ask,bid,budget){
  return reason('slippage',num(budget)+' USDC 기준 '+b.name+' 매수가 '+num(ask)+' · '+s.name+' 매도가 '+num(bid)+' USDC로 가격 차이가 사라져요');
}

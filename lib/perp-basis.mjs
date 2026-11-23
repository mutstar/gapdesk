import {marketContracts,strictContractKey,transferStatus} from './contract-identity.mjs';
import {poolFill} from './pool-depth.mjs';

const positive=n=>Number.isFinite(n)&&n>0;
const fresh=(time,now)=>Number.isSafeInteger(time)&&time<=now+5000&&now-time<45000;

// A lot must be valid on both exchanges, including non-power-of-ten steps.
function commonLot(steps){
  if(!steps.every(positive))return null;
  const places=Math.max(0,...steps.map(n=>{
    const [mantissa,exponent='0']=String(n).split('e');
    return (mantissa.split('.')[1]?.length||0)-Number(exponent);
  }));
  if(places>16)return null;
  const scale=10**places;
  const gcd=(a,b)=>b===0n?a:gcd(b,a%b);
  let lot=1n;
  for(const step of steps){
    const scaled=Math.round(step*scale);
    if(!Number.isSafeInteger(scaled)||scaled<1)return null;
    const n=BigInt(scaled);lot=lot/gcd(lot,n)*n;
  }
  return Number(lot)/scale;
}
function put(map,key,value){
  if(!map.has(key))map.set(key,[]);
  map.get(key).push(value);
}
function leg(m,match){
  if(m.kind==='PERP')return {id:m.id,name:m.display,kind:m.kind,contract:m.contract,fundingRate:m.fundingRate??null,
    intervalHours:m.intervalHours??null,nextFundingAt:m.nextFundingAt??null,openInterestUsdt:m.openInterestUsdt??null};
  return {id:m.id,name:m.name,kind:m.kind,transfer:transferStatus(m,match),contract:m.pair||null,...(m.kind==='DEX'?{chain:m.chain,token:m.token}:{})};
}
function enough(m,side,qty,px){
  if(m.kind==='DEX')return true;
  const size=side==='buy'?m.askSize:m.bidSize;
  return positive(size)&&size>=qty&&(!m.minQty||qty>=m.minQty)&&(!m.maxQty||qty<=m.maxQty)&&
    (!m.minimum||qty*px>=m.minimum);
}
// A reported spot constituent identifies the future's underlying. Each
// constituent must resolve to a published contract on the same network.
function constituentContracts(ids,available){
  if(!Array.isArray(ids)||!ids.length)return [];
  let common;
  for(const id of new Set(ids)){
    const contracts=available.get(id)?.contracts;
    if(!contracts?.length)return [];
    const keys=new Set(contracts.map(strictContractKey));
    common=common?common.filter(c=>keys.has(strictContractKey(c))):contracts;
    if(!common.length)return [];
  }
  return common;
}
function unambiguousContracts(m,now){
  if(m.kind==='CEX'&&!fresh(m.networkTime??m.time,now))return [];
  const unique=new Map();
  const chains=new Set();
  for(const c of marketContracts(m)){
    const key=strictContractKey(c);
    if(!key||unique.has(key))continue;
    if(chains.has(String(c.chain)))return [];
    chains.add(String(c.chain));unique.set(key,c);
  }
  return [...unique.values()];
}
export function perpBasis({spots,marks,feeds,budget,maxImpact,now=Date.now()}){
  const spotContracts=new Map(),anchors=new Map(),fxByVenue=new Map(),groups=new Map(),samples=[],marketIds=[],rows=[];
  for(const m of spots){
    const contracts=unambiguousContracts(m,now);
    spotContracts.set(m.id,contracts);
    if(m.kind==='CEX'){
      anchors.set(m.id,{contracts,time:m.networkTime??m.time});
      if(m.settlementFx)fxByVenue.set(m.venue,m.settlementFx);
    }
  }
  let matched=0,priced=0,compared=0,thin=0;
  for(const feed of feeds){
    const fx=feed.fx||fxByVenue.get(feed.source.venue);
    if(!fx||!fresh(fx.time,now)||!positive(fx.bid)||!(fx.ask>=fx.bid))continue;
    for(const raw of feed.markets){
      if(!fresh(raw.time,now)||!positive(raw.bid)||!(raw.ask>=raw.bid)||!positive(raw.step))continue;
      priced++;
      const contracts=constituentContracts(raw.spotAnchorIds,anchors);
      if(!contracts.length)continue;
      const proofTime=Math.min(...raw.spotAnchorIds.map(id=>anchors.get(id).time));
      const m={...raw,proofTime,ask:raw.ask/fx.bid,bid:raw.bid/fx.ask,time:Math.min(raw.time,fx.time),
        display:feed.source.name?.endsWith('선물')?feed.source.name:raw.name+' 선물',minimum:(raw.minNotional||0)/fx.bid};
      for(const c of contracts)put(groups,strictContractKey(c),m);
      matched++;marketIds.push(m.id);
      const asset=contracts.length===1?strictContractKey(contracts[0]):null;
      const ask=m.askSize*m.ask>=budget?m.ask:null,bid=m.bidSize*m.bid>=budget?m.bid:null;
      if(ask||bid)samples.push({id:m.id,symbol:m.symbol,asset,venue:m.venue,name:m.display,ask,bid,time:m.time});
    }
  }
  for(const m of spots){
    const keys=spotContracts.get(m.id).map(strictContractKey).filter(key=>groups.has(key));
    if(!keys.length||!fresh(m.time,now)||!marks.has(m.id))continue;
    if(m.kind==='CEX'&&(m.tradeEnabled!==true||!positive(m.step)||m.ask<m.bid))continue;
    const fx=fxByVenue.get(m.venue);
    if(m.quote==='USDT'&&(!fx||!fresh(fx.time,now)))continue;
    const q=marks.get(m.id);
    const normalized={...m,proofTime:m.networkTime??m.time,ask:q.buy,bid:q.sell,minimum:m.quote==='USDT'?m.min/fx.bid:m.min,
      time:m.quote==='USDT'?Math.min(m.time,fx.time):m.time};
    for(const key of keys)put(groups,key,normalized);
  }
  const contractsByKey=new Map();
  for(const list of spotContracts.values())for(const c of list)contractsByKey.set(strictContractKey(c),c);
  // Several networks may support this exact hedge. Use the first common
  // identity in a stable order so the spread and history have one row per pair.
  const seen=new Set();
  for(const key of [...groups.keys()].sort()){
   const group=groups.get(key),match=contractsByKey.get(key);
   const derivatives=group.filter(m=>m.kind==='PERP');
   for(const buy of group)for(const sell of buy.kind==='PERP'?group:derivatives){
    if(buy===sell||!positive(buy.ask))continue;
    if(sell.kind!=='DEX'&&!positive(sell.bid))continue;
    if(Math.abs(buy.time-sell.time)>15000)continue;
    const id=buy.id+'|'+sell.id;
    if(seen.has(id))continue;
    seen.add(id);compared++;
    const lot=commonLot([buy,sell].filter(m=>m.kind!=='DEX').map(m=>m.step));
    if(!positive(lot))continue;
    const units=Math.floor(budget/buy.ask/lot);
    if(!Number.isSafeInteger(units)||units<1)continue;
    const qty=units*lot;
    // The full-budget DEX purchase price is conservative after rounding down to the hedge lot.
    const bid=sell.kind==='DEX'?poolFill(sell,'sell',qty,maxImpact)?.effectivePrice:sell.bid;
    if(!(bid>buy.ask))continue;
    if(!enough(buy,'buy',qty,buy.ask)||!enough(sell,'sell',qty,bid)){thin++;continue;}
    const gap=(bid/buy.ask-1)*100, both=buy.kind==='PERP'&&sell.kind==='PERP';
    rows.push({id,match:{chain:match.chain,token:match.token},symbol:(buy.kind==='PERP'?buy:sell).symbol,kind:both?'perp_perp':'perp_spot',
      buy:leg(buy,match),sell:leg(sell,match),ask:buy.ask,bid,gap,qty,notional:qty*buy.ask,time:Math.min(buy.time,sell.time,buy.proofTime,sell.proofTime)});
  }
  }
  rows.sort((a,b)=>b.gap-a.gap||a.id.localeCompare(b.id));
  return {book:{rows,priced,matched,compared,thin},samples,marketIds};
}

import {NATIVE} from './assets.js';
import {poolFill} from './pool-depth.mjs';

const nativeChains={BTC:'bitcoin',ETH:'1',BNB:'56',SOL:'solana',XRP:'xrpl',DOGE:'dogecoin',ADA:'cardano',TRX:'tron',LTC:'litecoin',BCH:'bitcoin-cash'};
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
function leg(m){
  if(m.kind==='PERP')return {id:m.id,name:m.display,kind:m.kind,contract:m.contract,fundingRate:m.fundingRate??null,
    intervalHours:m.intervalHours??null,nextFundingAt:m.nextFundingAt??null,openInterestUsdt:m.openInterestUsdt??null};
  return {id:m.id,name:m.name,kind:m.kind,contract:m.pair||null,...(m.kind==='DEX'?{chain:m.chain,token:m.token}:{})};
}
function enough(m,side,qty,px){
  if(m.kind==='DEX')return true;
  const size=side==='buy'?m.askSize:m.bidSize;
  return positive(size)&&size>=qty&&(!m.minQty||qty>=m.minQty)&&(!m.maxQty||qty<=m.maxQty)&&
    (!m.minimum||qty*px>=m.minimum);
}
export function perpBasis({spots,identityOf,marks,feeds,budget,maxImpact,now=Date.now()}){
  const byVenue=new Map(),nativeIds=new Map(),fxByVenue=new Map(),groups=new Map(),samples=[],marketIds=[],rows=[];
  const identity=new Map(identityOf);
  for(const m of spots){
    if(m.kind!=='CEX')continue;
    put(byVenue,m.venue+':'+m.symbol,m);
    if(m.settlementFx)fxByVenue.set(m.venue,m.settlementFx);
    if(identity.has(m.id)&&m.networks.some(n=>String(n.chain)===nativeChains[m.symbol]&&n.token===NATIVE))
      nativeIds.set(m.symbol,identity.get(m.id));
  }
  let matched=0,priced=0,compared=0,thin=0;
  for(const feed of feeds){
    const fx=feed.fx||fxByVenue.get(feed.source.venue);
    if(!fx||!fresh(fx.time,now)||!positive(fx.bid)||!(fx.ask>=fx.bid))continue;
    for(const raw of feed.markets){
      if(!fresh(raw.time,now)||!positive(raw.bid)||!(raw.ask>=raw.bid)||!positive(raw.step))continue;
      priced++;
      const local=byVenue.get(raw.venue+':'+raw.symbol)||[];
      const evidence=[...local.map(m=>m.id),...(raw.spotAnchorIds||[])].map(id=>identity.get(id)).filter(Boolean);
      if(nativeIds.has(raw.symbol))evidence.push(nativeIds.get(raw.symbol));
      const ids=new Set(evidence);
      if(ids.size>1)continue;
      const asset=ids.size?[...ids][0]:local.length?'local:'+raw.venue+':'+raw.symbol:null;
      if(!asset)continue;
      for(const m of local)if(!identity.has(m.id))identity.set(m.id,asset);
      const m={...raw,ask:raw.ask/fx.bid,bid:raw.bid/fx.ask,time:Math.min(raw.time,fx.time),
        display:feed.source.name?.endsWith('선물')?feed.source.name:raw.name+' 선물',minimum:(raw.minNotional||0)/fx.bid};
      put(groups,asset,m);matched++;marketIds.push(m.id);
      const ask=m.askSize*m.ask>=budget?m.ask:null,bid=m.bidSize*m.bid>=budget?m.bid:null;
      if(ask||bid)samples.push({id:m.id,symbol:m.symbol,asset,venue:m.venue,name:m.display,ask,bid,time:m.time});
    }
  }
  for(const m of spots){
    const asset=identity.get(m.id);
    if(!groups.has(asset)||!fresh(m.time,now)||!marks.has(m.id))continue;
    if(m.kind==='CEX'&&(m.tradeEnabled!==true||!positive(m.step)||m.ask<m.bid))continue;
    const fx=fxByVenue.get(m.venue);
    if(m.quote==='USDT'&&(!fx||!fresh(fx.time,now)))continue;
    const q=marks.get(m.id);
    groups.get(asset).push({...m,ask:q.buy,bid:q.sell,minimum:m.quote==='USDT'?m.min/fx.bid:m.min,
      time:m.quote==='USDT'?Math.min(m.time,fx.time):m.time});
  }
  for(const group of groups.values()){
   const derivatives=group.filter(m=>m.kind==='PERP');
   for(const buy of group)for(const sell of buy.kind==='PERP'?group:derivatives){
    if(buy===sell||!positive(buy.ask))continue;
    if(sell.kind!=='DEX'&&!positive(sell.bid))continue;
    if(Math.abs(buy.time-sell.time)>15000)continue;
    compared++;
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
    rows.push({id:buy.id+'|'+sell.id,symbol:(buy.kind==='PERP'?buy:sell).symbol,kind:both?'perp_perp':'perp_spot',
      buy:leg(buy),sell:leg(sell),ask:buy.ask,bid,gap,qty,notional:qty*buy.ask,time:Math.min(buy.time,sell.time)});
  }
  }
  rows.sort((a,b)=>b.gap-a.gap||a.id.localeCompare(b.id));
  return {book:{rows,priced,matched,compared,thin},samples,marketIds};
}

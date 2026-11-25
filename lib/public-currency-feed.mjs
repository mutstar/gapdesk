import {exchangeContract} from './exchange-contracts.mjs';

const sources=new Map([
  ['htx','https://api.huobi.pro/v2/reference/currencies'],
  ['coinbaseexchange','https://api.exchange.coinbase.com/currencies']
]);
const cached=new Map(),retryAfter=new Map();
export function currencyIndex(venue,body){
  const htx=venue==='htx',records=htx?body?.data:body;
  if(!sources.has(venue)||!Array.isArray(records)||!records.length)throw Error('자산 목록 누락');
  const index=new Map();
  for(const r of records){
    const symbol=htx?r.currency:r.id;
    if(typeof symbol!=='string'||!symbol)continue;
    const key=symbol.toUpperCase();
    if(index.has(key)){index.set(key,[]);continue}
    const nets=new Map();
    for(const n of (htx?r.chains:r.supported_networks)??[]){
      const contract=exchangeContract(venue,htx?n.baseChain:n.id,htx?n.contractAddress:n.contract_address,key);
      if(contract)nets.set(contract.chain+':'+contract.token,{...contract,deposit:false,withdraw:false,depositOpen:null,withdrawOpen:null});
    }
    index.set(key,[...nets.values()]);
  }
  return index;
}
export async function publicCurrencyFeed(venue){
  if(!sources.has(venue))return null;
  const now=Date.now(),old=cached.get(venue);
  if(!(retryAfter.get(venue)>now)){
    retryAfter.set(venue,now+60000);
    try{
      const r=await fetch(sources.get(venue),{signal:AbortSignal.timeout(5000),headers:{accept:'application/json'}});
      if(!r.ok)throw Error('거래소 응답 오류');
      const date=Date.parse(r.headers.get('date')),age=Number(r.headers.get('age')??0);
      const time=Math.min(date,now-age*1000);
      if(!Number.isFinite(time)||date>now+5000||age<0||now-time>=7200000)throw Error('자산 목록 만료');
      const value={index:currencyIndex(venue,await r.json()),time};
      cached.set(venue,value);retryAfter.set(venue,now+300000);return value;
    }catch{/* An expired identity cannot be reused. */}
  }
  return old&&now-old.time<7200000?old:null;
}
export function listingContracts(venue,feed,symbol,quote,pair,now){
  if(!feed||now-feed.time>=7200000||feed.time>now+5000)return [];
  const id=venue==='htx'?(symbol+quote).toLowerCase():venue==='coinbaseexchange'?symbol+'-'+quote:null;
  return id===pair?feed.index.get(symbol.toUpperCase())??[]:[];
}

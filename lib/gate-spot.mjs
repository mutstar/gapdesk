import {createIdentityCache,exchangeContract} from './exchange-contracts.mjs';
const api='https://api.gateio.ws/api/v4/spot/';
const identities=createIdentityCache();
const positive=v=>Number.isFinite(Number(v))&&Number(v)>0?Number(v):null;
let pairCache;

async function feed(path){
  const response=await fetch(api+path,{cache:'no-store',signal:AbortSignal.timeout(8500)});
  if(!response.ok)throw Error('Gate.io HTTP '+response.status);
  const data=await response.json(), now=Date.now();
  if(!Array.isArray(data))throw Error('Gate.io 피드 형식 오류');
  const published=Date.parse(response.headers.get('date')),age=Number(response.headers.get('age')||0);
  const time=Number.isFinite(published)&&Number.isFinite(age)&&age>=0?Math.min(now,published,now-age*1000):0;
  return {data,time};
}
async function pairs(){
  if(pairCache && Date.now()-pairCache.time<60000)return pairCache.data;
  pairCache=await feed('currency_pairs');
  return pairCache.data;
}
function open(global,local){
  if(global===true||local===true)return false;
  return global===false&&local===false?true:null;
}
function networks(coin){
  return (coin?.chains||[]).flatMap(c=>{
    const contract=exchangeContract('gate',c.name,c.addr,coin.currency);
    if(!contract)return [];
    return [{...contract,depositOpen:open(coin.deposit_disabled,c.deposit_disabled),
      withdrawOpen:open(coin.withdraw_disabled,c.withdraw_disabled),deposit:false,withdraw:false}];
  });
}
export async function gateCurrencies(){
  const {data,time}=await feed('currencies').catch(()=>({data:[],time:0}));
  return {coins:new Map(data.map(c=>[c.currency,c])),identity:identities('gate',data,c=>c.currency,networks,time)};
}
export async function loadGateSpot(){
  const [catalog,tickers,{coins,identity}]=await Promise.all([pairs(),feed('tickers'),gateCurrencies()]);
  const books=new Map(tickers.data.map(t=>[t.currency_pair,t]));
  const fx=books.get('USDC_USDT'),fxAsk=positive(fx?.lowest_ask),fxBid=positive(fx?.highest_bid);
  const fxOK=fxBid&&fxAsk>=fxBid&&catalog.some(p=>p.id==='USDC_USDT'&&p.trade_status==='tradable');
  const now=Date.now(), markets=[];
  for(const p of catalog){
    if(!['USDC','USDT'].includes(p.quote)||!p.base||p.id!==p.base+'_'+p.quote||p.id.includes('|'))continue;
    const t=books.get(p.id),coin=coins.get(p.base),a=positive(t?.lowest_ask),b=positive(t?.highest_bid);
    const tradeEnabled=p.trade_status==='tradable'&&coin?.trade_disabled===false&&coin.delisted===false;
    const valid=tradeEnabled&&a&&b&&a>=b&&(p.quote==='USDC'||fxOK);
    const ask=valid?a/(p.quote==='USDT'?fxBid:1):null,bid=valid?b/(p.quote==='USDT'?fxAsk:1):null;
    markets.push({id:'gate:'+p.id,kind:'CEX',venue:'gate',name:'Gate.io',symbol:p.base,pair:p.id,quote:p.quote,
      ask,bid,askSize:positive(t?.lowest_size),bidSize:positive(t?.highest_size),time:tickers.time,
      networks:identity.bySymbol.get(p.base)??[],networkTime:identity.time,tradeEnabled,
      quoteReady:!!valid&&tradeEnabled&&now-tickers.time<45000,
      // The public endpoints omit account fees and chain-specific transfer limits.
      observationOnly:true,tradeFee:null,step:null,min:null});
  }
  return markets;
}

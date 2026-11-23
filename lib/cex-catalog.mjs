const BG = 'https://api.bitget.com/api/v2/spot';
const KU = 'https://api.kucoin.com';
const BH = 'https://api.bithumb.com/public';
const ZERO = '0x0000000000000000000000000000000000000000';
const AGE = 45000;
const cache = new Map();
const names = {bitget:'Bitget',kucoin:'KuCoin',bithumb:'빗썸'};
const networksByVenue = {
  bitget:{ETH:1, ERC20:1, BASE:8453, ArbitrumOne:42161, BEP20:56, BSC:56, Optimism:10, OPTIMISM:10, Polygon:137, POLYGON:137, 'AVAXC-Chain':43114,
    BTC:'bitcoin',SOL:'solana',XRP:'xrpl',DOGE:'dogecoin',LTC:'litecoin',Cardano:'cardano',BCH:'bitcoin-cash',TRX:'tron',TRC20:'tron'},
  kucoin:{eth:1, base:8453, arbitrum:42161, bsc:56,optimism:10,matic:137,avaxc:43114,
    btc:'bitcoin',sol:'solana',xrp:'xrpl',doge:'dogecoin',ltc:'litecoin',ada:'cardano',bchn:'bitcoin-cash',trx:'tron'}
};
const nativeAsset = {1:'ETH',8453:'ETH',42161:'ETH',56:'BNB',10:'ETH',137:'POL',43114:'AVAX',bitcoin:'BTC',solana:'SOL',xrpl:'XRP',dogecoin:'DOGE',litecoin:'LTC',cardano:'ADA','bitcoin-cash':'BCH',tron:'TRX'};

function number(value) {
  if(value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function fresh(time) {
  const age = Date.now()-time;
  return age >= -5000 && age < AGE;
}
async function fetchData(url, ttl=0) {
  const hit = ttl && cache.get(url);
  if(hit && Date.now()-hit.at < ttl) return hit.value;
  const res = await fetch(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(9000),cache:'no-store'});
  if(!res.ok) throw Error('거래소 HTTP '+res.status);
  const json = await res.json();
  if(!['200000','00000','0000'].includes(String(json.code ?? json.status))) throw Error('거래소 피드 오류');
  if(json.data == null) throw Error('거래소 정보 누락');
  if(ttl) cache.set(url,{value:json.data,at:Date.now()});
  return json.data;
}
function parseNetworks(venue, coin, symbol) {
  const ku = venue==='kucoin';
  const out=[];
  for(const c of coin?.chains ?? []) {
    const chain=networksByVenue[venue][ku?c.chainId:c.chain];
    if(!chain) continue;
    const raw=c.contractAddress;
    let token=null;
    if(!raw || raw===ZERO){if(nativeAsset[chain]===symbol)token=ZERO;}
    else if(typeof chain==='number' && /^0x[0-9a-f]{40}$/i.test(raw))token=raw.toLowerCase();
    else if(chain==='solana' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw))token=raw;
    else if(chain==='tron' && /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(raw))token=raw;
    if(!token)continue;
    const noTag=ku?c.needTag===false:c.needTag==='false';
    const minOut=number(ku?c.withdrawMinSize:c.minWithdrawAmount);
    const minIn=number(ku?c.depositMinSize:c.minDepositAmount);
    const fee=number(ku?c.withdrawMinFee:c.withdrawFee);
    const rate=number(ku?c.withdrawFeeRate:c.extraWithdrawFee);
    const decimals=number(ku?c.withdrawPrecision:c.withdrawMinScale);
    const step=ku?0:number(c.withdrawStep);
    const hasDepositFee=ku && [c.depositFeeRate,c.fixedDepositFee,c.depositTierFee].some(v=>v!=null&&v!==''&&Number(v)!==0);
    const depositOpen=ku?c.isDepositEnabled===true:c.rechargeable==='true';
    const withdrawOpen=ku?c.isWithdrawEnabled===true:c.withdrawable==='true';
    // A missing contract can name a native asset only for its verified native symbol.
    // A published positive special withdrawal step would also need size rounding.
    out.push({chain,token,minOut,minIn,fee,rate,decimals,
      deposit:depositOpen && noTag && minIn!==null && !hasDepositFee,
      withdraw:withdrawOpen && noTag && minOut!==null && fee!==null && rate!==null && rate<1 &&
        Number.isInteger(decimals) && decimals<=30 && step===0,
      depositOpen,withdrawOpen});
  }
  return out;
}
function rules(venue,pair,ticker) {
  const ku=venue==='kucoin';
  const baseFee=number(ku?ticker?.takerFeeRate:pair.takerFeeRate);
  const coefficient=ku?number(ticker?.takerCoefficient):1;
  const fee=baseFee===null||coefficient===null?null:baseFee*coefficient;
  const precision=number(pair.quantityPrecision);
  const step=ku?number(pair.baseIncrement):Number.isInteger(precision) && precision<=30?10**-precision:null;
  const min=number(ku?pair.minFunds:pair.minTradeUSDT);
  return {fee,step,min,tradeEnabled:ku?pair.enableTrading===true:pair.status==='online'};
}
function best(t,ku) {
  return {ask:number(ku?t?.sell:t?.askPr),bid:number(ku?t?.buy:t?.bidPr)};
}
async function spot(venue) {
  const ku=venue==='kucoin';
  const [pairs,tickRaw,coins]=await Promise.all([
    fetchData(ku?KU+'/api/v2/symbols':BG+'/public/symbols',120000),
    fetchData(ku?KU+'/api/v1/market/allTickers':BG+'/market/tickers',3500),
    fetchData(ku?KU+'/api/v3/currencies':BG+'/public/coins',45000).catch(()=>[])
  ]);
  const tickerMap=new Map((ku?tickRaw.ticker:tickRaw).map(t=>[t.symbol,t]));
  const coinMap=new Map(coins.map(c=>[ku?c.currency:c.coin,c]));
  const fx=tickerMap.get(ku?'USDC-USDT':'USDCUSDT');
  const fxPair=pairs.find(p=>p.symbol===(ku?'USDC-USDT':'USDCUSDT'));
  const fxLive=fxPair && rules(venue,fxPair,fx).tradeEnabled && fresh(Number(ku?tickRaw.time:fx?.ts));
  const f=best(fx,ku),markets=[];
  for(const pair of pairs) {
    const symbol=ku?pair.baseCurrency:pair.baseCoin;
    const quote=ku?pair.quoteCurrency:pair.quoteCoin;
    if(!['USDT','USDC'].includes(quote) || !symbol || !pair.symbol || pair.symbol.includes('|'))continue;
    const ticker=tickerMap.get(pair.symbol);
    const time=Number(ku?tickRaw.time:ticker?.ts)||0;
    const {ask:a,bid:b}=best(ticker,ku);
    const stats=rules(venue,pair,ticker);
    const fxOK=quote==='USDC'||fxLive && f.bid>0 && f.ask>0;
    const ask=fxOK&&a>0?a/(quote==='USDT'?f.bid:1):null;
    const bid=fxOK&&b>0?b/(quote==='USDT'?f.ask:1):null;
    const quoteReady=fresh(time)&&ask>0&&bid>0;
    const networks=parseNetworks(venue,coinMap.get(symbol),symbol);
    markets.push({id:venue+':'+pair.symbol,kind:'CEX',venue,name:names[venue],symbol,pair:pair.symbol,quote,ask,bid,time,
      askSize:number(ku?ticker?.bestAskSize:ticker?.askSz),bidSize:number(ku?ticker?.bestBidSize:ticker?.bidSz),
      ...(fxLive&&f.bid>0&&f.ask>=f.bid&&pair.symbol===fxPair.symbol?{settlementFx:{...f,time:Number(ku?tickRaw.time:fx.ts)}}:{}),
      minQty:ku?number(pair.baseMinSize):null,maxQty:ku?number(pair.baseMaxSize):null,
      networks,tradeFee:stats.fee,step:stats.step,min:stats.min,tradeEnabled:stats.tradeEnabled,quoteReady,
      observationOnly:!quoteReady||!stats.tradeEnabled||stats.fee===null||!(stats.step>0)||stats.min===null||!networks.some(n=>n.deposit||n.withdraw)});
  }
  return markets;
}
async function bithumb() {
  const [books,status]=await Promise.all([fetchData(BH+'/orderbook/ALL_KRW?count=1',3500),fetchData(BH+'/assetsstatus/ALL',15000).catch(()=>({}))]);
  const fxBuy=number(books.USDC?.asks?.[0]?.price),fxSell=number(books.USDC?.bids?.[0]?.price);
  const time=Number(books.timestamp)||0;
  return Object.values(books).filter(b=>b?.order_currency).map(book=>{
    const symbol=book.order_currency;
    const a=number(book.asks?.[0]?.price),b=number(book.bids?.[0]?.price);
    const ask=a>0&&fxSell>0?a/fxSell:null,bid=b>0&&fxBuy>0?b/fxBuy:null;
    return {id:'bithumb:KRW-'+symbol,venue:'bithumb',kind:'CEX',name:names.bithumb,symbol,pair:'KRW-'+symbol,quote:'KRW',
      askSize:number(book.asks?.[0]?.quantity),bidSize:number(book.bids?.[0]?.quantity),ask,bid,time,tradeEnabled:false,quoteReady:fresh(time)&&ask>0&&bid>0,observationOnly:true,
      depositOpen:status[symbol]?.deposit_status==null?null:Number(status[symbol].deposit_status)===1,
      withdrawOpen:status[symbol]?.withdrawal_status==null?null:Number(status[symbol].withdrawal_status)===1,
      networks:[],tradeFee:null,step:null,min:null};
  });
}
export async function loadCex() {
  const venues=['bitget','kucoin','bithumb'];
  const feeds=await Promise.allSettled(venues.map(id=>id==='bithumb'?bithumb():spot(id)));
  const markets=[], sources=[];
  for(const [i,r] of feeds.entries()){
    const id=venues[i],rows=r.status==='fulfilled'?r.value:[];
    markets.push(...rows);
    const count=rows.filter(m=>m.quoteReady).length;
    sources.push({id,name:names[id],ok:count>0,count,at:Date.now()});
  }
  return {markets,sources};
}
function validateMarket(m) {
  if(!['kucoin','bitget'].includes(m.venue)||!['USDT','USDC'].includes(m.quote)||typeof m.symbol!=='string'||typeof m.pair!=='string')throw Error('검증 불가 마켓');
}
async function liveBook(venue,symbol,quote) {
  const ku=venue==='kucoin';
  const pair=ku?symbol+'-'+quote:symbol+quote;
  const qp=encodeURIComponent(pair);
  const urls=ku?[KU+'/api/v1/market/orderbook/level2_20?symbol='+qp,KU+'/api/v2/symbols/'+qp]:
    [BG+'/market/orderbook?symbol='+qp+'&type=step0&limit=100',BG+'/public/symbols?symbol='+qp];
  const [book,meta,tick]=await Promise.all([fetchData(urls[0]),fetchData(urls[1]),
    ku?fetchData(KU+'/api/v1/market/allTickers',3500):null]);
  const p=ku?meta:meta.find(v=>v.symbol===pair),t=ku?tick.ticker.find(v=>v.symbol===pair):null;
  if(!p || p.symbol!==pair || (ku?p.baseCurrency:p.baseCoin)!==symbol || (ku?p.quoteCurrency:p.quoteCoin)!==quote)throw Error('거래소 마켓 불일치');
  const {fee,step,min,tradeEnabled}=rules(venue,p,t);
  const time=Number(ku?book.time:book.ts);
  if(!tradeEnabled||!(step>0)||fee===null||fee>=1||min===null||!fresh(time)||ku&&(!fresh(Number(tick.time))||p.feeCurrency!==quote))throw Error('거래 규칙 또는 호가를 확인할 수 없습니다.');
  const levels=rows=>Array.isArray(rows)?rows.map(([p,q])=>[number(p),number(q)]).filter(([p,q])=>p>0&&q>0):[];
  const asks=levels(book.asks).sort((a,b)=>a[0]-b[0]);
  const bids=levels(book.bids).sort((a,b)=>b[0]-a[0]);
  if(!asks.length||!bids.length||asks[0][0]<bids[0][0])throw Error('호가 누락');
  return {asks,bids,time,fee,step,min};
}
export async function freshBook(m) {
  validateMarket(m);
  const ku=m.venue==='kucoin',expected=ku?m.symbol+'-'+m.quote:m.symbol+m.quote;
  if(m.pair!==expected)throw Error('마켓 식별자 불일치');
  const [book,fx]=await Promise.all([liveBook(m.venue,m.symbol,m.quote),
    m.quote==='USDT'?liveBook(m.venue,'USDC','USDT'):null]);
  return fx?{...book,fx}:book;
}
export async function freshNetworks(m) {
  validateMarket(m);
  const ku=m.venue==='kucoin',sym=encodeURIComponent(m.symbol);
  const coin=await fetchData(ku?KU+'/api/v3/currencies/'+sym:BG+'/public/coins?coin='+sym);
  const data=ku?coin:coin.find(v=>v.coin===m.symbol);
  if(!data||(ku?data.currency:data.coin)!==m.symbol)throw Error('자산 식별자 불일치');
  return parseNetworks(m.venue,data,m.symbol);
}

// Public, read-only market feeds for venues not reliably indexed by DEX Screener.
const stableNtrn='ibc/B559A80D62249C8AA07A380E2A2BEA6E5CA9A6F079C912C3A9E9B494105E4F81';
const stableOsmo='ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4';
const stellarUsdc='USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const word=value=>BigInt(value).toString(16).padStart(64,'0');
function mark(chain,pool,token,symbol,price,time,usdc=true,label=''){
  return {chain,pool,token,symbol,ask:price,bid:price,time,usdc,label};
}

async function ethereumView(get,url,chain){
  async function rpc(method,params){
    const {data}=await get(url,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({id:1,jsonrpc:'2.0',method,params})});
    if(data.error||!data.result)throw Error('RPC 응답 대기');
    return data.result;
  }
  const [id,block]=await Promise.all([rpc('eth_chainId',[]),rpc('eth_getBlockByNumber',['latest',false])]);
  if(Number(id)!==chain||!block.number||!block.timestamp)throw Error('체인·블록 확인 대기');
  return {time:Number(block.timestamp)*1000,call:async(to,data)=>{
    const hex=await rpc('eth_call',[{to,data:'0x'+data},block.number]);
    if(!/^0x(?:[0-9a-fA-F]{64})+$/.test(hex))throw Error('컨트랙트 응답 대기');
    return hex.slice(2).match(/.{64}/g).map(w=>BigInt('0x'+w));
  }};
}
async function ambient(get){
  const view=await ethereumView(get,'https://rpc.scroll.io',534352);
  const query='0x62223e90605845Cf5CC6DAE6E0de4CDA130d6DDf';
  const base='0x06efdbff2a14a7c8e15944d1f4a48f9f95f663a4';
  const quotes=[['0xf55bec9cafdbe8730f096aa55dad6d22d44099df','USDT',6],['0x5300000000000000000000000000000000000004','WETH',18]];
  return (await Promise.all(quotes.map(async([token,symbol,decimals])=>{
    const key=word(base)+word(token)+word(420);
    const [[sqrt],[liq]]=await Promise.all([view.call(query,'f8c7efa7'+key),view.call(query,'338adc67'+key)]);
    // Croc represents base atoms per quote atom in Q64.64 square-root form.
    const price=(Number(sqrt)/2**64)**2*10**(decimals-6);
    return liq>0n?[mark('scroll',base+'-'+token+'-420',token,symbol,price,view.time)]:[];
  }))).flat();
}
async function mento(get){
  const view=await ethereumView(get,'https://forno.celo.org',42220);
  const pool='0x462fe04b4FD719Cbd04C0310365D421D02AaA19E',token='0x765de816845861e75a25fca122bb6898b8b1282a';
  const stable='0xceba9300f2b948710d2653dd7b07f33a8b32118c';
  const [[a],[b],[sell],[buy]]=await Promise.all([view.call(pool,'0dfe1681'),view.call(pool,'d21220a7'),
    view.call(pool,'f140a35a'+word(10n**18n)+word(token)),view.call(pool,'f140a35a'+word(1000000)+word(stable))]);
  if(a!==BigInt(token)||b!==BigInt(stable)||!buy||!sell)return [];
  return [{...mark('celo',pool,token,'USDm',0,view.time,true,'V3'),ask:1e18/Number(buy),bid:Number(sell)/1e6}];
}
async function thruster(get){
  const view=await ethereumView(get,'https://lb.routeme.sh/rpc/evm/81457',81457);
  const usdb='0x4300000000000000000000000000000000000003',weth='0x4300000000000000000000000000000000000004';
  const [id]=await view.call('0xb4A7D971D0ADea1c73198C97d7ab3f9CE4aaFA13','e6a43905'+word(usdb)+word(weth));
  if(!id)return [];
  const pool='0x'+id.toString(16).padStart(40,'0');
  const [[r0,r1],[first],eth]=await Promise.all([view.call(pool,'0902f1ac'),view.call(pool,'0dfe1681'),
    get('https://api.kraken.com/0/public/Ticker?pair=ETHUSD')]);
  if(!r0||!r1||first!==BigInt(usdb))return [];
  const usd=eth.data.result?.XETHZUSD;
  return [{...mark('blast',pool,usdb,'USDB',0,Math.min(view.time,eth.time),false,'V2'),
    ask:Number(r1)/Number(r0)*Number(usd?.a[0]),bid:Number(r1)/Number(r0)*Number(usd?.b[0])}];
}
async function bancorDirectory(get){
  const {data,time}=await get('https://api-v3.bancor.network/pools');
  const at=Math.min(time,Number(data.timestamp?.ethereum?.timestamp)*1000);
  return (data.data||[]).filter(p=>Number(p.tradingLiquidityBNT?.bnt)>0).map(p=>
    mark('ethereum',p.poolTokenDltId,p.poolDltId,p.name,Number(p.tradingLiquidityBNT.usd)/Number(p.tradingLiquidityTKN?.tkn),at,false,'V3'));
}
async function bancor(get){
  async function live(){
    const view=await ethereumView(get,'https://ethereum-rpc.publicnode.com',1);
    const info='0x8E303D296851B320e6a697bAcB979d13c9D6E760',eth='0x'+'e'.repeat(40);
    const bnt='0x1f573d6fb3f13d689ff844b4ce37794d79a7ff1c',pool='0x256ed1d83e3e4efdda977389a5389c3433137dda';
    const out=(a,b,n)=>view.call(info,'6e1a20be'+word(a)+word(b)+word(n));
    const [[sell],[buy],ethUsd]=await Promise.all([out(bnt,eth,10n**18n),out(eth,bnt,10n**15n),
      get('https://api.kraken.com/0/public/Ticker?pair=ETHUSD')]);
    const book=ethUsd.data.result?.XETHZUSD;
    if(!sell||!buy)return [];
    return [{...mark('ethereum',pool,bnt,'BNT',0,Math.min(view.time,ethUsd.time),false,'V3'),
      ask:1e15/Number(buy)*Number(book?.a[0]),bid:Number(sell)/1e18*Number(book?.b[0])}];
  }
  const results=await Promise.allSettled([live(),bancorDirectory(get)]);
  if(results.every(r=>r.status==='rejected'))throw Error('Bancor 풀 조회 대기');
  return results.flatMap(r=>r.status==='fulfilled'?r.value:[]);
}
async function stellar(get){
  const {data,time}=await get('https://horizon.stellar.org/trades?order=desc&limit=200');
  const rows=[];
  for(const t of data._embedded?.records||[]){
    const base=t.base_asset_code+':'+t.base_asset_issuer,quote=t.counter_asset_code+':'+t.counter_asset_issuer;
    if(base!==stellarUsdc&&quote!==stellarUsdc)continue;
    const inverse=base===stellarUsdc,token=inverse?quote:base;
    const pool=t.base_liquidity_pool_id||t.counter_liquidity_pool_id||'book-'+token+'-'+stellarUsdc;
    rows.push(mark('stellar',pool,token,inverse?t.counter_asset_code:t.base_asset_code,
      inverse?Number(t.base_amount)/Number(t.counter_amount):Number(t.counter_amount)/Number(t.base_amount),
      Math.min(time,Date.parse(t.ledger_close_time)),true,'SDEX'));
  }
  return rows;
}
async function osmosis(get){
  const params=new URLSearchParams({base_asset_denom:'uosmo',quote_asset_denom:stableOsmo});
  const {data,time}=await get('https://lcd.osmosis.zone/osmosis/poolmanager/v2/pools/1464/prices?'+params);
  return [mark('osmosis','1464','uosmo','OSMO',Number(data.spot_price),time)];
}
// TickLiquidityAll also includes resting orders on Neutron's native DEX.
// The gRPC gateway cannot represent IBC slashes in this route's path segments.
function protobufFields(bytes){
  const fields=new Map();let i=0;
  function varint(){
    let value=0n;
    for(let shift=0n;i<bytes.length&&shift<=63n;shift+=7n){
      const b=bytes[i++];value|=BigInt(b&127)<<shift;if(b<128)return value;
    }
    throw Error('DEX 틱 인코딩 오류');
  }
  while(i<bytes.length){
    const tag=Number(varint()),field=tag>>3,wire=tag&7;
    let value;
    if(wire===0)value=varint();
    else if(wire===2){
      const n=Number(varint());if(n>bytes.length-i)throw Error('DEX 틱 길이 오류');
      value=bytes.subarray(i,i+n);i+=n;
    }else throw Error('DEX 틱 형식 오류');
    if(!fields.has(field))fields.set(field,[]);fields.get(field).push(value);
  }
  return fields;
}
async function duality(get){
  const pair=stableNtrn+'<>untrn';
  const field=(tag,b)=>Buffer.concat([Buffer.from([tag,b.length]),b]);
  async function side(maker){
    const payload=Buffer.concat([field(10,Buffer.from(pair)),field(18,Buffer.from(maker)),field(26,Buffer.from([24,8]))]);
    const params=new URLSearchParams({path:'"/neutron.dex.Query/TickLiquidityAll"',data:'0x'+payload.toString('hex')});
    const {data,time}=await get('https://neutron-rpc.polkachu.com/abci_query?'+params);
    const res=data.result?.response;if(res?.code!==0||!res.value)return [];
    const rows=[];
    for(const raw of protobufFields(Buffer.from(res.value,'base64')).get(1)||[]){
      const tick=protobufFields(raw),order=tick.has(2),leg=protobufFields(tick.get(order?2:1)[0]);
      if(!(Number(leg.get(2)?.[0]?.toString())>0))continue;
      if(order&&leg.has(6)&&Number(protobufFields(leg.get(6)[0]).get(1)?.[0])*1000<=Date.now())continue;
      const key=protobufFields(leg.get(1)[0]),trade=protobufFields(key.get(1)[0]);
      const other=maker==='untrn'?stableNtrn:'untrn';
      if(trade.get(2)?.[0].toString()!==maker||trade.get(3)?.[0].toString()!==other)continue;
      const index=Number(BigInt.asIntN(64,key.get(2)?.[0]??0n));
      const price=Math.pow(1.0001,maker==='untrn'?index:-index);
      if(Number.isFinite(price)&&price>0)rows.push({price,time});
    }
    return rows;
  }
  const [asks,bids]=await Promise.all([side('untrn'),side(stableNtrn)]);
  const ask=asks.sort((a,b)=>a.price-b.price)[0],bid=bids.sort((a,b)=>b.price-a.price)[0];
  if(!ask&&!bid)return [];
  // Even a single resting side can be observed. This mark never qualifies a fill.
  return [{...mark('neutron','duality-untrn-usdc','untrn','NTRN',0,Math.min(ask?.time??Infinity,bid?.time??Infinity)),
    ask:ask?.price??bid.price,bid:bid?.price??ask.price,onlySide:!bid?'buy':!ask?'sell':null}];
}

async function hydration(get){
  async function rpc(method,params){
    const {data}=await get('https://rpc.hydradx.cloud',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    if(typeof data.result!=='string')throw Error('Omnipool 상태 조회 대기');
    return data.result;
  }
  const block=await rpc('chain_getBlockHash',[]);
  const timestampKey='0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb';
  const little=hex=>Number(BigInt('0x'+hex.match(/../g).reverse().join('')));
  // Omnipool.Assets uses Blake2_128Concat(u32). First u128 is the LRNA reserve.
  // CurrenciesApi reads the other reserve at the same block hash.
  const prefix='0x97bd8c21bba825270fe6b1b8b3961ac3682a59d51ab9e48a8c8cc418ff9708d2';
  const account='6d6f646c6f6d6e69706f6f6c'+'00'.repeat(20);
  async function hubPrice(suffix,decimals){
    const [state,balance]=await Promise.all([rpc('state_getStorage',[prefix+suffix,block]),
      rpc('state_call',['CurrenciesApi_free_balance','0x'+suffix.slice(-8)+account,block])]);
    if(!/^0x[0-9a-f]{32,}$/i.test(state)||!/^0x[0-9a-f]{32}$/i.test(balance))throw Error('Omnipool 잔량 대기');
    return little(state.slice(2,34))/little(balance.slice(2))*10**decimals;
  }
  const [anchor,hdx,stamp,ticker]=await Promise.all([hubPrice('70a0262dd2b7d857263f255f404337b15a450f00',18),
    hubPrice('11d2df4e979aa105cf552e9544ebd2b500000000',12),rpc('state_getStorage',[timestampKey,block]),
    get('https://api.kraken.com/0/public/Ticker?pair=LINKUSD')]);
  const book=ticker.data.result?.LINKUSD;
  return [{...mark('hydration','omnipool-0-1000794','0','HDX',0,Math.min(little(stamp.slice(2)),ticker.time),false,'Omnipool'),
    ask:hdx/anchor*Number(book?.a[0]),bid:hdx/anchor*Number(book?.b[0])}];
}
export const nativeVenueReaders={ambient,mento,thruster,bancor,stellarx:stellar,osmosis,duality,hydration};

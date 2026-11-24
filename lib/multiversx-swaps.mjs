// MultiversX mainnet. Router address from mx-exchange-service/src/config/mainnet.json.
// Payload layout from mx-exchange-sc/dex/pair/src/events.rs (nested binary encoding).
const gateway='https://gateway.multiversx.com';
const router='erd1qqqqqqqqqqqqqpgqq66xk9gfr4esuhem3jru86wg5hvp33a62jps2fy57p';
const chain='multiversx',venue='xexchange',shard=1,key='native/xexchange/shard-1';
const alphabet='qpzry9x8gf2tvdw0s3jn54khce6mua7l';

// Compare the 32-byte address from the router with the address payload in a
// gateway-issued erd1 Bech32 string. Both come from the same mainnet gateway.
function addressPayload(base64){
  const bytes=Buffer.from(base64,'base64');
  if(bytes.length!==32)throw Error('Invalid MultiversX router address');
  const last=bytes[31]&3;
  if((last===3?1:last)!==shard)throw Error('xExchange router added a pool on a new shard');
  let value=0,bits=0,result='';
  for(const byte of bytes){
    value=(value<<8)|byte;bits+=8;
    while(bits>=5){bits-=5;result+=alphabet[(value>>bits)&31]}
  }
  return result+alphabet[(value<<(5-bits))&31];
}
const tokenId=/^[A-Z0-9a-z]{3,20}-[a-f0-9]{6}$/;
const eventName=s=>s?Buffer.from(s,'base64').toString('ascii'):'';
function decodeFill(event,block,seq){
  const name=eventName(event.topics?.[0]),regular=name==='swap';
  if(!regular&&name!=='swap_no_fee_and_forward')return;
  const body=Buffer.from(event.data??'','base64');
  let offset=32; // managed caller address
  function field(){
    if(offset+4>body.length)throw Error('Incomplete xExchange swap field');
    const size=body.readUInt32BE(offset);offset+=4;
    if(size>128||offset+size>body.length)throw Error('Invalid xExchange swap field');
    const result=body.subarray(offset,offset+size);offset+=size;return result;
  }
  const tokenIn=field().toString('ascii'),amountIn=field(),tokenOut=field().toString('ascii'),amountOut=field();
  if(regular){field();field();field()}else offset+=32;
  if(!tokenId.test(tokenIn)||!tokenId.test(tokenOut)||tokenIn===tokenOut||!amountIn.length||!amountOut.length||
    offset+24!==body.length||body.readBigUInt64BE(offset)!==BigInt(block.nonce)||
    body.readBigUInt64BE(offset+16)!==BigInt(block.timestamp)||
    (regular?eventName(event.topics[1])!==tokenIn||eventName(event.topics[2])!==tokenOut:eventName(event.topics[1])!==tokenOut)){
    throw Error('xExchange swap payload does not match block or indexed tokens');
  }
  const a=Number(BigInt('0x'+amountIn.toString('hex'))),b=Number(BigInt('0x'+amountOut.toString('hex')));
  if(!a||!b)return;
  const time=Number.isSafeInteger(block.timestampMs)&&Math.floor(block.timestampMs/1000)===block.timestamp?block.timestampMs:block.timestamp*1000;
  return {chain,venue,pool:event.address,protocol:'xExchange pair',tokens:[tokenIn,tokenOut].sort(),
    rawRatio:tokenIn<tokenOut?b/a:a/b,time,block:block.nonce,seq,hash:block.hash};
}
export function xexchangeTicks(block,nonce,pools){
  if(block?.shard!==shard||block.nonce!==nonce||block.status!=='on-chain'||!Number.isSafeInteger(block.timestamp)||
    !/^[a-f0-9]{64}$/.test(block.hash)||(!Array.isArray(block.miniBlocks)&&block.numTxs!==0))throw Error('Invalid MultiversX finalized shard block');
  let seq=0,created=false;
  const ticks=[];
  for(const mini of block.miniBlocks??[]){
    if(mini.destinationShard!==shard)continue;
    if(!Array.isArray(mini.transactions)&&['TxBlock','SmartContractResultBlock'].includes(mini.type))throw Error('Missing MultiversX transaction bodies');
    for(const tx of mini.transactions??[]){
      if(tx.status!=='success')continue;
      for(const event of tx.logs?.events??[]){
        seq++;
        if(event.address===router&&eventName(event.topics?.[0])==='create_pair')created=true;
        if(!pools.has(event.address?.slice(4,-6)))continue;
        const tick=decodeFill(event,block,seq);
        if(tick)ticks.push(tick);
      }
    }
  }
  return {ticks,created};
}
export function createMultiversxSwaps(registry,{request=fetch,now=Date.now}={}){
  let state={chain,venue},pools,lastPoolsAt=0,busy,retryAfter=0;
  async function get(path,body){
    const r=await request(gateway+path,{method:body?'POST':'GET',signal:AbortSignal.timeout(9000),
      ...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});
    if(!r.ok)throw Error('MultiversX gateway HTTP '+r.status);
    const result=await r.json();
    if(result.code!=='successful'||!result.data)throw Error('MultiversX gateway request failed');
    return result.data;
  }
  async function readPools(){
    const res=await get('/vm-values/query',{scAddress:router,funcName:'getAllPairsManagedAddresses',args:[]});
    if(res.data?.returnCode!=='ok'||!res.data.returnData?.length)throw Error('Missing xExchange router pairs');
    pools=new Set(res.data.returnData.map(addressPayload));lastPoolsAt=now();
  }
  async function run(){
    if(!pools||now()-lastPoolsAt>=60000)await readPools();
    const {status}=await get('/network/status/'+shard),head=status?.erd_highest_final_nonce;
    if(!Number.isSafeInteger(head)||head<1)throw Error('Invalid MultiversX finalized height');
    let cursor=registry.cursor(key)??{height:Math.max(0,head-12),observed:0,lastSwapAt:null};
    if(cursor.height>head)throw Error('MultiversX finalized head behind saved cursor');
    state={chain,venue,head,processed:cursor.height,at:now(),registeredPools:pools.size,observed:cursor.observed,lastSwapAt:cursor.lastSwapAt};
    const stop=Math.min(head,cursor.height+60);
    while(cursor.height<stop){
      const first=cursor.height+1,count=Math.min(4,stop-cursor.height);
      const blocks=await Promise.all(Array.from({length:count},(_,i)=>get('/block/'+shard+'/by-nonce/'+(first+i)+'?withTxs=true&withLogs=true')));
      for(const [i,{block}] of blocks.entries()){
        const nonce=first+i;
        if(cursor.hash&&cursor.hash!==block?.prevBlockHash)throw Error('MultiversX finalized block continuity failure');
        let decoded=xexchangeTicks(block,nonce,pools);
        if(decoded.created){await readPools();decoded=xexchangeTicks(block,nonce,pools)}
        const ticks=decoded.ticks,rows=new Map(ticks.map(t=>[t.pool,{chain,venue,pool:t.pool,tokens:t.tokens,activity:t.time}]));
        cursor={height:nonce,hash:block.hash,observed:cursor.observed+ticks.length,lastSwapAt:ticks.at(-1)?.time??cursor.lastSwapAt};
        registry.commit([...rows.values()],key,cursor,ticks);
        Object.assign(state,{processed:nonce,observed:cursor.observed,lastSwapAt:cursor.lastSwapAt,registeredPools:pools.size});
      }
    }
  }
  return {async refresh(){
    if(!busy&&now()>=retryAfter)busy=run().catch(e=>{state={...state,error:e.message,at:now()};retryAfter=now()+5000}).finally(()=>{busy=null});
    return busy;
  },coverage:()=>[{...state}]};
}

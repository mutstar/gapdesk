export const rpcNetworks=[
  ['worldchain',480,'0xb1860d529182ac3bc1f51fa2abd56662b7d13f33','https://worldchain-mainnet.g.alchemy.com/public'],
  ['tempo',4217,'0x33620f62c5b9b2086dd6b62f4a297a9f30347029','https://rpc.mainnet.tempo.xyz'],
  ['robinhood',4663,'0x8366a39cc670b4001a1121b8f6a443a643e40951','https://rpc.mainnet.chain.robinhood.com'],
  ['arc',5042,'0x8366a39cc670b4001a1121b8f6a443a643e40951','https://rpc.mainnet.arc.io'],
  ['elysium',99901,'0xe2e105d3f7209a9da11f83ccf3e7398a753823f1','https://rpc.elysium.kinetiq.xyz'],
].map(([chain,id,manager,rpc])=>({chain,id,manager,rpc}));
const hex=n=>'0x'+n.toString(16);
async function call(net,method,params,request){
  const r=await request(net.rpc,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(6000),
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  if(!r.ok)throw Error('V4 RPC '+r.status);
  const j=await r.json();
  if(j.error||j.result==null)throw Error('V4 RPC '+(j.error?.code??'empty')+' '+String(j.error?.message??'').slice(0,100));
  return j.result;
}
export async function rpcHead(net,request){
  const [chain,head]=await Promise.all([call(net,'eth_chainId',[],request),call(net,'eth_blockNumber',[],request)]);
  if(Number(chain)!==net.id)throw Error('V4 RPC chain mismatch');
  return Number(head);
}
export async function rpcRange(net,from,to,topics,request,decode){
  let last=Math.min(to,from+799),logs;
  while(true){
    try{
      logs=await call(net,'eth_getLogs',[{fromBlock:hex(from),toBlock:hex(last),address:net.manager,topics:[topics]}],request);
      if(!Array.isArray(logs))throw Error('Invalid RPC logs');
      if(logs.length>=10000)throw Error('RPC result limit');
      break;
    }catch(e){
      if(last===from||!/(result limit|range|too many|exceed|response size|-32005)/i.test(e.message))throw e;
      last=from+Math.floor((last-from)/2);
    }
  }
  const byBlock=new Map();
  for(const log of logs){
    const number=Number(log.blockNumber);
    if(log.removed||log.address!==net.manager||!Number.isSafeInteger(number)||number<from||number>last)continue;
    if(!byBlock.has(number))byBlock.set(number,{header:{number,timestamp:Number(log.blockTimestamp)},logs:[]});
    byBlock.get(number).logs.push(log);
  }
  const blocks=[...byBlock.values()].sort((a,b)=>a.header.number-b.header.number);
  for(const block of blocks){
    if(!Number.isFinite(block.header.timestamp)){
      const header=await call(net,'eth_getBlockByNumber',[hex(block.header.number),false],request);
      block.header.timestamp=Number(header.timestamp);
    }
    if(!Number.isSafeInteger(block.header.timestamp)||block.header.timestamp<=0)throw Error('Invalid RPC block time');
    block.logs.sort((a,b)=>Number(a.logIndex)-Number(b.logIndex));
  }
  return {last,...decode(net,blocks)};
}

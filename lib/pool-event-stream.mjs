import {factoryVenue} from './factory-registry.mjs';
import {rpcNetworks,rpcHead,rpcRange} from './v4-public-rpc.mjs';
import {networks} from './dex-venues.mjs';

// SQD EVM archives. V4 pool IDs are scoped to the official PoolManager on each chain.
// https://developers.uniswap.org/deployments.json
export const v4Networks = [
  ['ethereum','ethereum-mainnet','000000000004444c5dc75cb358380d2e3de08a90'],
  ['bsc','binance-mainnet','28e2ea090877bf75740558f6bfb36a5ffee9e9df'],
  ['base','base-mainnet','498581ff718922c3f8e6a244956af099b2652b2b'],
  ['arbitrum','arbitrum-one','360e68faccca8ca495c1b759fd9eee466db9fb32'],
  ['polygon','polygon-mainnet','67366782805870060151383f4bbff9dab53e5cd6'],
  ['optimism','optimism-mainnet','9a13f98cb987694c9f086b1f5eb990eea8264ec3'],
  ['unichain','unichain-mainnet','1f98400000000000000000000000000000000004'],
  ['avalanche','avalanche-mainnet','06380c0e0912312b5150364b9dc4542ba0dbbc85'],
  ['celo','celo-mainnet','288dc841a52fca2707c6947b3a777c5e56cd87bc'],
  ['hyperevm','hyperliquid-mainnet','12d4fd9c5dedd00ab8a0bce2cf0167bbf94b6b1f'],
  ['linea','linea-mainnet','248083fb965359d82b06c1f5322480dcfc1ad857'],
  ['ink','ink-mainnet','360e68faccca8ca495c1b759fd9eee466db9fb32'],
  ['soneium','soneium-mainnet','360e68faccca8ca495c1b759fd9eee466db9fb32'],
  ['monad','monad-mainnet','188d586ddcf52439676ca21a244753fa19f9ea8e'],
  ['megaeth','megaeth-mainnet','acb7e78fa05d562e0a5d3089ec896d57d057d38e'],
  ['zora','zora-mainnet','0575338e4c17006ae181b47900a84404247ca30f'],
  ['xlayer','xlayer-mainnet','360e68faccca8ca495c1b759fd9eee466db9fb32'],
].map(([chain,dataset,address])=>({chain,dataset,manager:'0x'+address}));

const eventNetworks=v4Networks.concat(rpcNetworks,['berachain','flare','zksync','mantle','opbnb','scroll','sonic'].map(chain=>({chain,dataset:chain+'-mainnet'})));
const archived=new Set(['xlayer','mantle','opbnb','scroll','sonic']);
const pairCreated='0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9';
const poolCreated='0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118';
export const initialize='0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
export const v4Swap='0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
const otherSwaps=['0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
  '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'];
const sync='0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';
const pancakeSwap='0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83';
const address=/^0x[0-9a-f]{40}$/,word=/^0x[0-9a-f]{64}$/;
export function events(network,blocks) {
  const pools=new Map(),swaps=new Map();
  for(const {header,logs=[]} of blocks){
    const time=Number(header.timestamp)*1000;
    if(!Number.isSafeInteger(time)||time<=0)continue;
    for(const log of logs){
      if(log.removed||!address.test(log.address))continue;
      const [topic,id,a,b]=log.topics??[];
      if(topic===pairCreated||topic===poolCreated){
        if(![id,a].every(t=>/^0x0{24}[0-9a-f]{40}$/.test(t)) || id>=a || !/^0x(?:[0-9a-f]{64}){2}$/.test(log.data))continue;
        const protocol=topic===pairCreated?'v2':'v3',w=protocol==='v2'?log.data.slice(2,66):log.data.slice(66);
        if(!/^0{24}[0-9a-f]{40}$/.test(w)||/^0+$/.test(w))continue;
        const pool='0x'+w.slice(-40),venue=factoryVenue(networks[network.chain],log.address,protocol);
        const row=pools.get(pool)??{chain:network.chain,pool};
        if(venue)Object.assign(row,{venue,protocol,tokens:[id,a].map(t=>'0x'+t.slice(-40))});
        pools.set(pool,row);
        continue;
      }
      if(otherSwaps.includes(topic)||topic===sync||topic===pancakeSwap){
        const pool=log.address,chain=network.chain;
        pools.set(pool,{...pools.get(pool),chain,pool,activity:time});
        // The price reader only uses reserves from independently matched factory pools.
        const words=/^0x(?:[0-9a-f]{64}){2,7}$/.test(log.data)?log.data.slice(2).match(/.{64}/g):[];
        if(topic===sync&&words.length===2){
          const [a,b]=words.map(w=>Number(BigInt('0x'+w)));
          swaps.set(pool,{chain,pool,time,protocol:'v2',rawRatio:a&&b?b/a:0});
        }else if((topic===otherSwaps[1]&&words.length===5)||(topic===pancakeSwap&&words.length===7)){
          const sqrt=Number(BigInt('0x'+words[2]));
          swaps.set(pool,{chain,pool,time,protocol:'v3',rawRatio:BigInt('0x'+words[3])?(sqrt/2**96)**2:0});
        }
        continue;
      }
      if(log.address!==network.manager||!word.test(id))continue;
      const p=pools.get(id)??{chain:network.chain,pool:id,venue:'uniswap'};
      if(topic===initialize && [a,b].every(t=>/^0x0{24}[0-9a-f]{40}$/.test(t))){
        p.tokens=[a,b].map(t=>'0x'+t.slice(-40));p.initialized=true;
      }else if(topic===v4Swap && /^0x(?:[0-9a-f]{64}){6}$/.test(log.data)){
        p.activity=time;
        const sqrt=BigInt('0x'+log.data.slice(130,194)),liquidity=BigInt('0x'+log.data.slice(194,258));
        swaps.set(id,{chain:network.chain,pool:id,time,protocol:'v4',rawRatio:liquidity?(Number(sqrt)/2**96)**2:0});
      }else continue;
      pools.set(id,p);
    }
  }
  return {pools:[...pools.values()],swaps:[...swaps.values()]};
}

export async function readRange(network,from,to,historical,request=fetch) {
  if(network.rpc)return rpcRange(network,from,to,historical?[initialize]:[initialize,v4Swap],request,events);
  const logs=[{topic0:[pairCreated,poolCreated]}];
  if(network.manager)logs.push({address:[network.manager],topic0:historical?[initialize]:[initialize,v4Swap]});
  if(!historical)logs.push({topic0:[...otherSwaps,sync,pancakeSwap]});
  const response=await request('https://portal.sqd.dev/datasets/'+network.dataset+'/'+(historical||archived.has(network.chain)?'finalized-stream':'stream'),{
    method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(11000),
    body:JSON.stringify({type:'evm',fromBlock:from,toBlock:to,logs,fields:{
      block:{number:true,timestamp:true},log:{address:true,topics:true,data:true}}})});
  return consumeBlocks(response,from,to,b=>events(network,b));
}

export async function consumeBlocks(response,from,to,decode,{skippedSlots=false}={}){
  if(!response.ok||response.status===204)throw Error('SQD '+response.status);
  // A portal response may end before toBlock. Only acknowledge fully decoded blocks.
  const blocks=[]; let pending='',bytes=0,previous=from-1;
  const decoder=new TextDecoder();
  function append(line){
    if(!line.trim())return;
    const b=JSON.parse(line),n=b.header?.number;
    if(!Number.isSafeInteger(n)||n<=previous||n>to||n<from||(!skippedSlots&&!blocks.length&&n!==from))throw Error('SQD block boundaries');
    blocks.push(b);previous=n;
  }
  for await(const chunk of response.body){
    pending+=decoder.decode(chunk,{stream:true});
    const lines=pending.split('\n');pending=lines.pop();
    for(const line of lines)append(line);
    bytes+=chunk.length;
    if(bytes>=2500000&&blocks.length)return {last:previous,...decode(blocks)};
  }
  append(pending+decoder.decode());
  if(!blocks.length)throw Error('SQD empty range');
  return {last:previous,...decode(blocks)};
}

export function createEventWatcher(registry,{request=fetch,now=Date.now}={}) {
  const latest=new Map(),status=new Map(),errors=new Map();
  let running=false,historyTurn=0;
  async function scan(network,wantHistory){
    const {chain,dataset}=network,key='blocks/'+chain;
    let head;
    if(network.rpc)head=await rpcHead(network,request);
    else{
      const response=await request('https://portal.sqd.dev/datasets/'+dataset+'/head',{signal:AbortSignal.timeout(5000)});
      if(!response.ok)throw Error('SQD head '+response.status);
      head=(await response.json()).number;
    }
    if(!Number.isSafeInteger(head)||head<0)throw Error('SQD invalid head');
    const saved=registry.cursor(key),from=saved===null?Math.max(0,head-35):saved+1;
    const historyKey='initializations/'+chain;
    if(registry.cursor(historyKey)===null)registry.commit([],historyKey,{end:from-1,start:null});
    async function collect(low,high,checkpoint){
      const r=await readRange(network,low,high,false,request);
      registry.commit(r.pools,checkpoint,r.last);
      for(const swap of r.swaps)if(now()-swap.time<45000){
        const id=chain+':'+swap.pool;
        if((latest.get(id)?.time??0)<=swap.time)latest.set(id,swap);
      }
      return r.last;
    }
    let last=saved;
    if(from<=head){
      // Keep current activity visible while catching up after an outage.
      if(head-from>500)await collect(Math.max(from,head-30),head,null);
      last=await collect(from,Math.min(head,from+1400),key);
    }
    status.set(chain,{chain,head,processed:last,at:now()});
    if(wantHistory){
      const state=registry.cursor(historyKey);
      if(state.end<0)return;
      const lower=Math.max(0,state.end-9999),start=state.start??lower;
      const r=await readRange(network,start,state.end,true,request);
      registry.commit(r.pools,historyKey,r.last===state.end?{end:lower-1,start:null}:{...state,start:r.last+1});
    }
  }
  return {
    async refresh(){
      if(running)return;
      running=true;
      const turn=historyTurn++;
      try{
        let n=0;
        await Promise.all(Array.from({length:7},async()=>{
          while(n<eventNetworks.length){
            const i=n++,network=eventNetworks[i];
            try{await scan(network,(i+turn)%3===0);errors.delete(network.chain)}
            catch(e){errors.set(network.chain,e.message)}
          }
        }));
      }finally{running=false}
    },
    swaps(){
      for(const [id,s] of latest)if(now()-s.time>=45000)latest.delete(id);
      return [...latest.values()];
    },
    coverage:()=>eventNetworks.map(({chain})=>({...status.get(chain),chain,error:errors.get(chain)??null})),
  };
}

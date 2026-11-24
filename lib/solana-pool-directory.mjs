import {strictContractKey} from './contract-identity.mjs';

const feeds=['raydium','orca','dlmm','damm-v2'];
export async function readSolanaDirectory(feed,cursor,get){
  const page=Number(cursor||1);
  let url,parse;
  if(feed==='raydium'){
    url='https://api-v3.raydium.io/pools/info/list?poolType=all&poolSortField=default&sortType=desc&pageSize=100&page='+page;
    parse=j=>{
      if(j.success!==true || typeof j.data?.hasNextPage!=='boolean')throw Error('Raydium page');
      return [j.data.data,j.data.hasNextPage?page+1:null,p=>[p.id,p.mintA?.address,p.mintB?.address]];
    };
  }else if(feed==='orca'){
    url='https://api.orca.so/v2/solana/pools?size=100'+(cursor?'&next='+encodeURIComponent(cursor):'');
    parse=j=>{
      if(!j.meta?.cursor || !('next' in j.meta.cursor))throw Error('Orca cursor');
      return [j.data,j.meta.cursor.next,p=>[p.address,p.tokenMintA,p.tokenMintB]];
    };
  }else{
    url='https://'+feed+'.datapi.meteora.ag/pools?page_size=100&page='+page;
    parse=j=>{
      if(j.current_page!==page||!Number.isInteger(j.pages))throw Error('Meteora page');
      return [j.data,page<j.pages?page+1:null,p=>[p.address,p.token_x?.address,p.token_y?.address]];
    };
  }
  const {data}=await get(url),[rows,next,decode]=parse(data);
  if(!Array.isArray(rows)||rows.length>100||next && (!rows.length||next===cursor))throw Error('Incomplete directory page');
  const pools=[];
  for(const p of rows){
    const [pool,a,b]=decode(p);
    if(a===b||![pool,a,b].every(token=>strictContractKey({chain:'solana',token})))continue;
    pools.push({chain:'solana',pool,venue:feed==='orca'||feed==='raydium'?feed:'meteora',tokens:[a,b],
      symbols:[p.mintA??p.tokenA??p.token_x,p.mintB??p.tokenB??p.token_y].map(t=>t?.symbol)});
  }
  return {pools,next};
}
export async function updateSolanaDirectory(registry,get){
  return Promise.allSettled(feeds.map(async feed=>{
    const key='solana/'+feed;
    for(let n=0;n<4;n++){
      const {pools,next}=await readSolanaDirectory(feed,registry.cursor(key),get);
      registry.commit(pools,key,next);
      if(!next)break;
    }
  }));
}

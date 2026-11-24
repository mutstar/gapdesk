import {consumeBlocks} from './pool-event-stream.mjs';
import {strictContractKey} from './contract-identity.mjs';

const swap='0xf8c69e91e17587c8',swap2='0x414b3f4ceb5b5b88',v2='0x2b04ed0b1ac91e62';
const layouts=new Map();
function program(venue,id,discriminators,legs){
  if(!layouts.has(id))layouts.set(id,new Map());
  for(const d of discriminators)layouts.get(id).set(d,{venue,legs});
}
// Pool account and its two vault indices from each program's published swap instruction IDL.
const orca='whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
program('orca',orca,[swap],[[2,4,6]]);
program('orca',orca,[v2],[[4,8,10]]);
program('orca',orca,['0xc360ed6c44a2dbe6'],[[2,5,7],[3,9,11]]);
program('orca',orca,['0xba8fd11dfe02c275'],[[0,9,10],[1,11,12]]);
program('raydium','CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',[swap,v2],[[2,5,6]]);
program('raydium','CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',['0x8fbe5adac41e33de','0x37d96256a34ab4ad'],[[3,6,7]]);
program('meteora','cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',[swap,swap2],[[1,4,5]]);
program('meteora','LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',[swap,swap2,'0xfa49652126cf4bb8','0x2bd7f784893cf351','0x38ade6d0ade49ccd','0x4a62c0d6b1334b33'],[[0,2,3]]);

const splToken='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const usdc='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const wrappedSol='So11111111111111111111111111111111111111112';
const orcaSolUsdc='Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';

function checkedTransfer(ix){
  if(ix.programId!==splToken||!/^0x0c/.test(ix.d8)||!ix.data||ix.data.length>14)return;
  let n=0n;
  for(const ch of ix.data){
    const digit=alphabet.indexOf(ch);
    if(digit<0)return;
    n=n*58n+BigInt(digit);
  }
  const bytes=Buffer.from(n.toString(16).padStart(20,'0'),'hex');
  if(bytes.length!==10||bytes[0]!==12||bytes[9]>36)return;
  const amount=Number(bytes.readBigUInt64LE(1))/10**bytes[9];
  const [source,mint,dest]=ix.accounts;
  if(amount>0&&strictContractKey({chain:'solana',token:mint}))return {source,mint,dest,amount};
}
export function solanaActivities(blocks){
  const pools=new Map(),trades=new Map();
  for(const block of blocks){
    const time=block.header.timestamp*1000;
    if(!Number.isSafeInteger(time)||time<=0)continue;
    const children=new Map(),parents=[];
    for(const ix of block.instructions??[]){
      if(!ix.isCommitted||!Array.isArray(ix.instructionAddress)||!Array.isArray(ix.accounts))continue;
      const path=ix.instructionAddress,id=ix.transactionIndex+':'+path.join('.');
      const layout=layouts.get(ix.programId)?.get(ix.d8);
      if(layout)parents.push({ix,id,layout});
      if(path.length>1){
        const parent=ix.transactionIndex+':'+path.slice(0,-1).join('.');
        if(!children.has(parent))children.set(parent,[]);
        children.get(parent).push(ix);
      }
    }
    for(const {ix,id,layout} of parents)for(const [p,a,b] of layout.legs){
      const pool=ix.accounts[p],vaults=[ix.accounts[a],ix.accounts[b]];
      if(!strictContractKey({chain:'solana',token:pool})||!vaults[0]||!vaults[1]||vaults[0]===vaults[1])continue;
      const row={chain:'solana',venue:layout.venue,pool,activity:time};
      pools.set(pool,row);
      // Only unambiguous direct SPL transfers on opposite sides of the two vaults
      // form a trade price. Token-2022 extensions and multileg ambiguity stay discovery-only.
      const sides=vaults.map(v=>{
        const touching=(children.get(id)??[]).filter(i=>i.accounts.includes(v));
        if(touching.length!==1)return;
        const t=checkedTransfer(touching[0]);
        if(!t||t.source!==v&&t.dest!==v)return;
        return {...t,inbound:t.dest===v};
      });
      if(!sides[0]||!sides[1]||sides[0].inbound===sides[1].inbound||sides[0].mint===sides[1].mint)continue;
      row.tokens=sides.map(s=>s.mint);
      trades.set(pool,{...row,time,amounts:sides.map(s=>s.amount)});
    }
  }
  return {pools:[...pools.values()],trades:[...trades.values()]};
}

export function createSolanaWatcher(registry,request=fetch,now=Date.now){
  const latest=new Map(),base='https://portal.sqd.dev/datasets/solana-mainnet',key='blocks/solana';
  let running=false,status={},solAnchor;
  async function range(from,to,persist,discoveryOnly=false){
    const r=await request(base+'/stream',{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(12000),
      body:JSON.stringify({type:'solana',fromBlock:from,toBlock:to,fields:{block:{number:true,timestamp:true},
        instruction:{transactionIndex:true,instructionAddress:true,programId:true,accounts:true,d8:true,data:true,isCommitted:true}},
        instructions:[...layouts].map(([id,variants])=>({programId:[id],d8:[...variants.keys()],isCommitted:true,innerInstructions:!discoveryOnly}))})});
    const page=await consumeBlocks(r,from,to,solanaActivities,{skippedSlots:true});
    registry.commit(page.pools,persist?key:null,page.last);
    for(const t of page.trades){
      if(t.time<now()-45000||t.time>now()+5000)continue;
      if((latest.get(t.pool)?.time??0)>t.time)continue;
      latest.set(t.pool,t);
      if(t.pool===orcaSolUsdc&&t.tokens.includes(usdc)&&t.tokens.includes(wrappedSol)){
        const index=t.tokens.indexOf(usdc);
        if(t.amounts[index]>=10)solAnchor={price:t.amounts[index]/t.amounts[1-index],time:t.time};
      }
    }
    return page.last;
  }
  return {
    async refresh(){
      if(running)return;
      running=true;
      try{
        const r=await request(base+'/head',{signal:AbortSignal.timeout(4000)});
        if(!r.ok)throw Error('Solana head '+r.status);
        const {number:head}=await r.json();
        if(!Number.isSafeInteger(head)||head<0)throw Error('Invalid Solana head');
        let last=registry.cursor(key)??Math.max(-1,head-16);
        if(head-last>90)await range(head-9,head,false);
        const start=now();
        while(last<head&&now()-start<20000){
          const backlog=head-last>120;
          const end=backlog?Math.min(head-100,last+250):Math.min(head,last+24);
          last=await range(last+1,end,true,backlog);
        }
        status={chain:'solana',head,processed:last,at:now()};
      }catch(e){status={...status,chain:'solana',error:e.message}}finally{running=false}
    },
    coverage:()=>status,
    markets(symbolFor){
      const rows=[];
      for(const [id,t] of latest){
        if(t.time<=now()-45000){latest.delete(id);continue}
        let anchor=t.tokens.indexOf(usdc),factor=1,time=t.time;
        if(anchor<0){
          anchor=t.tokens.indexOf(wrappedSol);
          if(anchor<0||!solAnchor||solAnchor.time<=now()-45000)continue;
          factor=solAnchor.price;time=Math.min(t.time,solAnchor.time);
        }
        const i=1-anchor,token=t.tokens[i],mark=factor*t.amounts[anchor]/t.amounts[i];
        if(!Number.isFinite(mark)||mark<=0)continue;
        const label={orca:'Orca',raydium:'Raydium',meteora:'Meteora'}[t.venue];
        rows.push({id:'dex:solana:'+token+':'+id,chain:'solana',pool:id,token,dexId:t.venue,venue:'dex',kind:'DEX',
          name:label+' · Solana',symbol:symbolFor(token)||token.slice(0,5)+'…'+token.slice(-4),ask:mark,bid:mark,time,
          reference:'venue-index',referenceOnly:false,observationOnly:true,liquidityUSD:null});
      }
      return rows;
    },
  };
}

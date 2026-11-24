// Horizon exposes individual Stellar Classic LP fills in deterministic ledger order.
const url='https://horizon.stellar.org/trades';
const key='stellar/classic-lp/v1';
function asset(row,side){
  if(row[side+'_asset_type']==='native')return 'native';
  const code=row[side+'_asset_code'],issuer=row[side+'_asset_issuer'];
  if(!/^[a-zA-Z0-9]{1,12}$/.test(code??'')||!/^G[A-Z2-7]{55}$/.test(issuer??''))throw Error('Stellar asset identity');
  return code+':'+issuer;
}
function position(token){
  const m=/^(\d+)-(\d+)$/.exec(token);
  if(!m)throw Error('Stellar trade cursor');
  return [BigInt(m[1]),BigInt(m[2])];
}
export function stellarPage(records,previous){
  const pools=[],ticks=[];
  let cursor=previous;
  for(const t of records){
    const token=t.paging_token,[op,leg]=position(token);
    if(cursor){
      const [a,b]=position(cursor.token);
      if(op<a||op===a&&leg<=b)throw Error('Stellar trade order');
    }
    const block=Number(op>>32n),seq=cursor?.block===block?cursor.seq+1:0;
    const pool=t.base_liquidity_pool_id||t.counter_liquidity_pool_id;
    if(t.trade_type!=='liquidity_pool'||!/^[0-9a-f]{64}$/.test(pool??''))throw Error('Stellar LP trade identity');
    const tokens=[asset(t,'base'),asset(t,'counter')],amounts=[Number(t.base_amount),Number(t.counter_amount)];
    if(tokens[0]>tokens[1]){tokens.reverse();amounts.reverse()}
    const rawRatio=amounts[1]/amounts[0],time=Date.parse(t.ledger_close_time);
    if(tokens[0]===tokens[1]||!amounts.every(v=>v>0&&Number.isFinite(v))||!Number.isFinite(rawRatio)||!Number.isFinite(time))throw Error('Stellar trade amount/time');
    pools.push({chain:'stellar',pool,venue:'stellarx',tokens,activity:time});
    ticks.push({chain:'stellar',pool,venue:'stellarx',protocol:'Classic LP',tokens,humanUnits:true,time,block,seq,hash:token,rawRatio});
    cursor={token,block,seq,time};
  }
  return {cursor,pools,ticks};
}
export function createStellarStream(registry,request=fetch,now=Date.now){
  let running=false,retry=0,status={chain:'stellar',venue:'stellarx'};
  return {
    async refresh(){
      if(running||now()<retry)return;
      running=true;
      try{
        for(let i=0;i<3;i++){
          const prev=registry.cursor(key);
          const query=new URLSearchParams({trade_type:'liquidity_pool',order:prev?'asc':'desc',limit:'200'});
          if(prev)query.set('cursor',prev.token);
          const response=await request(url+'?'+query,{signal:AbortSignal.timeout(8000)});
          if(!response.ok)throw Error('Horizon '+response.status);
          const records=(await response.json())._embedded?.records;
          if(!Array.isArray(records))throw Error('Horizon trade page');
          const page=stellarPage(prev?records:records.reverse(),prev);
          if(page.ticks.length)registry.commit(page.pools,key,page.cursor,page.ticks);
          status={...status,error:null,at:now(),processed:page.cursor?.block,backlog:records.length===200&&!!prev};
          if(records.length<200)break;
        }
        retry=now()+4000;
      }catch(e){status={...status,error:e.message};retry=now()+10000}
      finally{running=false}
    },
    coverage:()=>status,
  };
}

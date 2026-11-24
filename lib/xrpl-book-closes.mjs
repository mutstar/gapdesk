const key='xrpl/validated-books';
const servers=['https://xrplcluster.com','https://s2.ripple.com:51234'];
export function ledgerCloses(row,height){
  if(row?.validated!==true||row.ledger_index!==height||!Number.isSafeInteger(height)||!Number.isSafeInteger(row.ledger_time)||
    !/^[0-9A-F]{64}$/i.test(row.ledger_hash)||!Array.isArray(row.changes))throw Error('Incomplete XRPL validated ledger');
  const ticks=[],time=(row.ledger_time+946684800)*1000;
  for(const {currency_a:a,currency_b:b,volume_a:va,volume_b:vb,close} of row.changes){
    const rate=Number(close);
    if(typeof a!=='string'||typeof b!=='string'||!a||!b||a===b||!(Number(va)>0&&Number(vb)>0&&rate>0&&Number.isFinite(rate)))continue;
    // The published rate is units of A per unit of B. This is one close per order book and ledger.
    ticks.push({venue:'xrpl',chain:'xrpl',protocol:'원장 종가',pool:JSON.stringify([a,b]),tokens:[b,a],
      block:height,seq:ticks.length,hash:row.ledger_hash,rawRatio:rate,time});
  }
  return ticks;
}
export function createXrplBooks(registry,request=fetch,now=Date.now){
  let status={chain:'xrpl',venue:'xrpl'},busy=false,preferred=0;
  async function read(endpoint,height){
    const r=await request(endpoint,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(6500),
      body:JSON.stringify({method:'book_changes',params:[{api_version:2,ledger_index:height}]})});
    if(!r.ok)throw Error('XRPL HTTP '+r.status);
    return (await r.json()).result;
  }
  return {
    async refresh(){
      if(busy)return;
      busy=true;
      try{
        for(let i=0;i<servers.length;i++){
          const idx=(preferred+i)%servers.length,endpoint=servers[idx];
          try{
            const tip=await read(endpoint,'validated'),head=tip?.ledger_index;
            ledgerCloses(tip,head);
            let saved=registry.cursor(key)??{height:Math.max(0,head-4)};
            for(let n=0;n<16&&saved.height<head;n++){
              const height=saved.height+1,r=height===head?tip:await read(endpoint,height),ticks=ledgerCloses(r,height);
              saved={height,lastQuoteAt:ticks.at(-1)?.time??saved.lastQuoteAt??null};
              registry.commit([],key,saved,ticks,'ledger-close');
            }
            status={chain:'xrpl',venue:'xrpl',head,processed:saved.height,at:now(),lastQuoteAt:saved.lastQuoteAt};
            preferred=idx;break;
          }catch(e){if(i===servers.length-1)throw e}
        }
      }catch(e){status={...status,error:e.message}}finally{busy=false}
    },
    coverage:()=>status,
  };
}

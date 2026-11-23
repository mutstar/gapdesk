import {readFile} from 'node:fs/promises';
import {strictContractKey} from './contract-identity.mjs';

const directory='/var/lib/gapdesk/cex-wide';
const fresh=(t,now)=>Number.isSafeInteger(t)&&t>now-45000&&t<=now+5000;
const positive=n=>Number.isFinite(n)&&n>0;
const safe=s=>typeof s==='string'&&s.length>0&&s.length<130&&!/[|\x00-\x1f]/.test(s);

export async function readWideFiles(){
  const read=async id=>JSON.parse(await readFile(directory+'/'+id+'.json','utf8'));
  try{
    const registry=await read('registry');
    return await Promise.all(registry.filter(v=>/^[a-z0-9]+$/.test(v.id)).map(async v=>{
      try{return await read(v.id)}catch{return {...v,modes:{},status:'첫 수집 대기'};}
    }));
  }catch{return [];}
}

// Rates give USDC per unit of the venue's quote currency, in both directions.
function ratesFor(data,global,now){
  const rates=new Map(global);
  rates.set('USDC',{ask:1,bid:1,time:now});
  const spot=data.modes?.spot?.rows||[];
  for(let pass=0;pass<2;pass++){
    const prior=new Map(rates);
    for(const [base,quote,,,a,b,,,,ts] of spot){
      if(!fresh(ts,now)||!positive(b)||!(a>=b))continue;
      // Derive FX only through an actual local market quoted in a known unit.
      if(!rates.has(base)&&prior.has(quote)){
        const ref=prior.get(quote);rates.set(base,{ask:a*ref.ask,bid:b*ref.bid,time:Math.min(ts,ref.time)});
      }
      if(!rates.has(quote)&&prior.has(base)){
        const ref=prior.get(base);rates.set(quote,{ask:ref.ask/b,bid:ref.bid/a,time:Math.min(ts,ref.time)});
      }
    }
  }
  return rates;
}

export function wideMarkets(files,native,now=Date.now()){
  const global=new Map(), batches=[],feeds=[],samples=[];
  // Use the freshest directly observed USDC/USDT book, with the correct sides on inversion.
  for(const m of native){
    const f=m.settlementFx;
    if(fresh(f?.time,now)&&positive(f.bid)&&f.ask>=f.bid&&(!global.has('USDT')||f.time>global.get('USDT').time))
      global.set('USDT',{ask:1/f.bid,bid:1/f.ask,time:f.time});
  }
  for(const file of files){
    const venue=file.venue||file.id,rates=ratesFor(file,global,now);
    const modes=Object.entries(file.modes||{});
    if(!modes.length){
      batches.push({rows:[],source:{id:'wide-'+file.id,name:file.name,venue,ok:false,count:0,at:now,
        status:file.status||'기본 피드에서 수집'}});
    }
    for(const [mode,group] of modes){
      const spot=mode==='spot',name=file.name+(spot?' 현물':mode==='inverse'?' 인버스 선물':' 선물');
      const source={id:'wide-'+file.id+'-'+mode,venue,name,ok:false,at:0,count:0,total:group.total,books:0,status:group.status};
      const rows=[],derivatives=[];
      for(const [symbol,quote,settle,pair,ask,bid,askSize,bidSize,step,time,last] of group.rows||[]){
        if(!safe(symbol)||!safe(quote)||!safe(pair)||!fresh(time,now))continue;
        const book=positive(bid)&&positive(ask)&&ask>=bid;
        if(!book&&!positive(last))continue;
        if(book)source.books++;
        const id='cex-'+file.id+':'+mode+':'+encodeURIComponent(pair)+':'+encodeURIComponent(settle||'');
        // A pair's own quote unit can support a price alert even without a conversion or CA.
        samples.push({id:id+':'+(book?'bbo':'last')+':'+encodeURIComponent(quote),symbol,asset:null,venue,
          name,ask:book?ask:last,bid:book?bid:last,time});
        source.count++;source.at=Math.max(source.at,time);
        const fx=rates.get(quote),converted=book&&fx;
        const netFlag=value=>fresh(file.catalogAt,now)&&typeof value==='boolean'?value:null;
        const nets=(now-file.catalogAt<2*3600000?(file.networks?.[symbol]||[]):[]).map(([chain,token,deposit,withdraw])=>({chain,token,
          deposit:false,withdraw:false,depositOpen:netFlag(deposit),withdrawOpen:netFlag(withdraw)})).filter(strictContractKey);
        if(spot){
          rows.push({id,kind:'CEX',symbol,name,venue,pair,quote,time:converted?Math.min(time,fx.time):time,
            ask:converted?ask*fx.ask:null,bid:converted?bid*fx.bid:null,askSize,bidSize,step,min:null,tradeFee:null,
            networks:nets,networkTime:file.catalogAt,quoteReady:!!converted,tradeEnabled:true,observationOnly:true,wide:true});
        }else if(converted&&mode!=='inverse'){
          const anchorIds=file.anchors?.[pair]||[];
          derivatives.push({id,kind:'PERP',name,venue,contract:pair,symbol,ask:ask*fx.ask,bid:bid*fx.bid,
            time:Math.min(time,fx.time),askSize,bidSize,step,spotAnchorIds:anchorIds,quote:'USDC'});
        }
      }
      source.ok=source.count>0;source.at||=now;
      if(!source.ok)source.status=file.status||group.status||'최신 시세 대기';
      if(spot)batches.push({source,rows});
      else feeds.push({source,markets:derivatives,fx:{ask:1,bid:1,time:now}});
    }
  }
  return {batches,feeds,samples};
}

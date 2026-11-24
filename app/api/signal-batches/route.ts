import {logSignals,logSwapSpikes} from '../../../lib/signal-store';
import {validImpact} from '../../../lib/impact-limit.mjs';
export async function POST(req:Request){
  if(req.headers.get('content-type')!=='application/gzip')return new Response(null,{status:415});
  const bytes=await req.arrayBuffer();
  if(bytes.byteLength>4000000)return new Response(null,{status:413});
  try{
    const s=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).json() as Record<string,any>;
    if(s.kind==='swap-spikes'){
      if(!Array.isArray(s.spikes)||!s.spikes.length||s.spikes.length>500||!s.spikes.every((r:any)=>
        typeof r?.marketId==='string'&&r.marketId.startsWith('swap/')&&r.windowSec===60))
        return new Response(null,{status:400});
      await logSwapSpikes(s.spikes,Date.now());
      return Response.json({recorded:true});
    }
    if(!Number.isSafeInteger(s.at)||!Number.isSafeInteger(s.startedAt)||s.startedAt>s.at||s.at-s.startedAt>120000||
       s.at>Date.now()+5000||!Number.isFinite(s.budget)||s.budget<10||s.budget>100000||!Number.isFinite(s.floor)||s.floor<0||!validImpact(s.maxImpact)||
       !Array.isArray(s.signalGaps)||!Array.isArray(s.entryChecks)||!Array.isArray(s.spikes)||!Array.isArray(s.signalMarketIds))return new Response(null,{status:400});
    if(s.at>=Date.now()-7*86400000)await logSignals(s);
    return Response.json({recorded:true});
  }catch{return new Response('감지 기록 저장 지연',{status:503})}
}

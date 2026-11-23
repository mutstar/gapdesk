import {env} from 'cloudflare:workers';
import {validImpact} from '../../../lib/impact-limit.mjs';
import {frameOrder,OBSERVATION_HOLD_MS} from '../../../lib/observation-window.mjs';

const key='live/observation-book-v1.json.gz';
const noCache={'Cache-Control':'no-store'};
const idle=()=>new Response(null,{status:204,headers:noCache});
export async function GET(req:Request){
  const p=new URL(req.url).searchParams;
  const object=await env.BUCKET?.get(key,{onlyIf:{etagDoesNotMatch:p.get('revision')||'-'}});
  const meta=object?.customMetadata;
  if(!object || !('body' in object) || !meta || Date.now()-Number(meta.at)>=OBSERVATION_HOLD_MS ||
     Number(p.get('amount'))!==Number(meta.budget) || Number(p.get('floor'))!==Number(meta.floor) ||
     Number(p.get('impact'))!==Number(meta.maxImpact))return idle();
  return new Response(object.body.pipeThrough(new DecompressionStream('gzip')),{headers:{...noCache,
    'Content-Type':'application/json','X-Observation-Revision':object.etag}});
}
export async function POST(req:Request){
  if(!env.BUCKET || req.headers.get('content-type')!=='application/gzip')return new Response(null,{status:400});
  const bytes=await req.arrayBuffer();
  if(bytes.byteLength>4_000_000)return new Response(null,{status:413});
  const frame=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).json() as Record<string,any>;
  const {startedAt,at,seq,complete,budget,floor,maxImpact}=frame,now=Date.now();
  if(!Number.isSafeInteger(startedAt)||!Number.isSafeInteger(at)||at<startedAt||at>now+5000||now-at>=OBSERVATION_HOLD_MS||
     !Number.isSafeInteger(seq)||seq<1||typeof complete!=='boolean'||!(budget>=10&&budget<=100000)||!(floor>=0&&floor<=100000)||
     !validImpact(maxImpact)||!Array.isArray(frame.spotGaps)||!Array.isArray(frame.futures?.rows))return new Response(null,{status:400});
  const metadata={startedAt:String(startedAt),at:String(at),seq:String(seq),complete:String(complete),
    budget:String(budget),floor:String(floor),maxImpact:String(maxImpact)};
  for(let i=0;i<3;i++){
    const prior=await env.BUCKET.head(key),m=prior?.customMetadata;
    if(m && frameOrder(frame,{startedAt:Number(m.startedAt),at:Number(m.at),seq:Number(m.seq),complete:m.complete==='true'})<=0)
      return Response.json({saved:false});
    const onlyIf=prior?{etagMatches:prior.etag}:new Headers({'If-None-Match':'*'});
    if(await env.BUCKET.put(key,bytes,{customMetadata:metadata,onlyIf}))return Response.json({saved:true});
  }
  return new Response(null,{status:503});
}

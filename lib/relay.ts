import {env} from 'cloudflare:workers';
import {validImpact} from './impact-limit.mjs';
import {logScan} from './scan-store';
type Snapshot=Record<string,any>;
const file='live/public-markets.json.gz';
export async function relayChanged(budget:number,floor:number,revision:string,maxImpact:number){
 const meta=(await env.BUCKET?.head(file))?.customMetadata;
 return !!meta&&Number(meta.maxImpact)===maxImpact&&Number(meta.budget)===budget&&Number(meta.floor)===floor&&Date.now()-Number(meta.at)<45000&&(meta.revision||meta.at)!==revision;
}
export async function latestRelay(budget:number,floor:number,only='',maxImpact?:number){
 if(!env.BUCKET)return null;
 const head=await env.BUCKET.head(file),meta=head?.customMetadata;
 if(!meta||!meta.maxImpact||maxImpact!==undefined&&Number(meta.maxImpact)!==maxImpact||Number(meta.budget)!==budget||Number(meta.floor)!==floor)return null;
 const age=Date.now()-Number(meta.at);
 if(age< -5000||age>(only?12000:45000))return null;
 const object=await env.BUCKET.get(file);if(!object)return null;
 const data=await new Response(object.body.pipeThrough(new DecompressionStream('gzip'))).json() as Snapshot;
 if(!data.depthCoverage||maxImpact!==undefined&&data.maxImpact!==maxImpact||data.budget!==budget||data.floor!==floor||Date.now()-data.at>(only?12000:45000))return null;
 data.rows=data.rows.filter((r:Snapshot)=>r.expires>Date.now()&&(!only||r.id===only));
 if(only&&!data.rows.length)return null;
 if(only)data.tokens=[];
 return {...data,revision:object.customMetadata?.revision||String(data.at),mode:data.intervalMs===30000?'PC 30초 수집':'PC 연속 수집',recorded:true};
}
export async function acceptRelay(req:Request){
 if(!env.BUCKET||req.headers.get('content-type')!=='application/gzip')return new Response('지원하지 않는 요청',{status:400});
 const bytes=await req.arrayBuffer();if(bytes.byteLength>4000000)return new Response('크기 한도',{status:413});
 const data=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).json() as Snapshot;
 const {at,budget,floor,rows,tokens,sources}=data;
 if(!data.depthCoverage||!validImpact(data.maxImpact)||!Number.isFinite(at)||Date.now()-at>45000||at>Date.now()+5000||!(budget>=10&&budget<=100000)||!(floor>=0&&floor<=100000)||!Array.isArray(rows)||!Array.isArray(tokens)||!Array.isArray(sources)||!tokens.length||tokens.length>100000)return new Response('유효한 시세 없음',{status:400});
 if(!sources.some(s=>s.ok&&s.count>0))return new Response('시세 미수신',{status:400});
 const revision=String(Date.now());
 await logScan(data);
 await env.BUCKET.put(file,bytes,{customMetadata:{revision,maxImpact:String(data.maxImpact),at:String(at),budget:String(budget),floor:String(floor)}});
 return Response.json({recorded:true,at,symbols:tokens.length,verified:rows.length});
}
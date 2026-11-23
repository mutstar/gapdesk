// Read-only producer for the owner-private Gapdesk deployment. The native launcher
// supplies its Site service credential over stdin. No wallet or exchange keys are used.
import {gzipSync} from 'node:zlib';
import {setTimeout as sleep} from 'node:timers/promises';
import {wideScan} from '../lib/universe.mjs';
const site=new URL('https://dokdo-gapdesk.awakeant23.chatgpt.site');
let service='';
for await(const part of process.stdin)service+=part.toString();
service=service.trim();
if(!service)throw Error('Site service credential required on stdin.');
async function siteFetch(path,options={}){
 const url=new URL(path,site);if(url.origin!==site.origin)throw Error('Origin mismatch');
 const r=await fetch(url,{...options,headers:{...options.headers,'OAI-Sites-Authorization':'Bearer '+service},redirect:'error',signal:AbortSignal.timeout(30000)});
 if(r.status===401||r.status===403)throw Error('access-expired');
 if(!r.ok)throw Error('Site HTTP '+r.status);
 return r.json();
}
let cursor='',poolCursor=0,prior=new Map(),previousConfig='';
for(;;){
 try{
  const settings=await siteFetch('/api/settings');
  const budget=settings.amount,floor=settings.min,config=budget+'|'+floor;
  if(!Number.isFinite(budget)||!Number.isFinite(floor))throw Error('Invalid settings');
  if(previousConfig!==config){prior.clear();previousConfig=config}
  const s=await wideScan({budget,floor,cursor,poolCursor,limit:10});cursor=s.nextCursor;poolCursor=s.poolCursor;
  const possible=new Set(s.eligible);
  for(const [id,row] of prior)if(row.expires<=Date.now()||!possible.has(id))prior.delete(id);
  for(const id of s.attempted)prior.delete(id);for(const row of s.rows)prior.set(row.id,row);
  s.rows=[...prior.values()].sort((a,b)=>b.profit-a.profit);s.floor=floor;
  await siteFetch('/api/relay',{method:'POST',headers:{'content-type':'application/gzip'},body:gzipSync(JSON.stringify(s),{level:3})});
  await sleep(6000);
 }catch(e){
   if(e.message==='access-expired')break;
   await sleep(15000);
 }
}

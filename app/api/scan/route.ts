import {DEFAULT_IMPACT,validImpact} from '../../../lib/impact-limit.mjs';
import {latestRelay,relayChanged} from '../../../lib/relay';
import {wideScan} from '../../../lib/universe.mjs';
import {readState,writeState,logScan} from '../../../lib/scan-store';
const valid=(budget:number,floor:number)=>Number.isFinite(budget)&&budget>=10&&budget<=100000&&Number.isFinite(floor)&&floor>=0&&floor<=100000;
export async function GET(req:Request){
 const p=new URL(req.url).searchParams,budget=Number(p.get('amount')??1000),floor=Number(p.get('floor')??5),address=p.get('address')||undefined,only=p.get('only')||'';
 const maxImpact=Number(p.get('impact')??DEFAULT_IMPACT);
 if(!valid(budget,floor)||!validImpact(maxImpact)||address&&!/^0x[0-9a-f]{40}$/i.test(address)||only.length>500)return new Response('입력값 오류',{status:400});
 // Jobs saved by the single-pair version retain their original, ETH-only route IDs.
 if(/^(bitget|kucoin|base|arb)-(bitget|kucoin|base|arb)$/.test(only)){
 if(only.split('-').some(v=>v==='base'||v==='arb'))return Response.json({rows:[],tokens:[]},{headers:{'Cache-Control':'no-store'}});
 const {scan}=await import('../../../lib/market.mjs');return Response.json(await scan(budget,floor,address,only),{headers:{'Cache-Control':'no-store'}});
 }
 const cursor=p.get('cursor')||'',poolCursor=Number(p.get('pool')||0);
 if(cursor.length>500||!Number.isSafeInteger(poolCursor)||poolCursor<0)return new Response('커서 오류',{status:400});
 if(p.get('updates')==='1'&&!only){
   const changed=await relayChanged(budget,floor,p.get('revision')||'',maxImpact).catch(()=>false);
   if(!changed)return new Response(null,{status:204,headers:{'Cache-Control':'no-store'}});
 }
 const relay=await latestRelay(budget,floor,only&&address?'':only,maxImpact).catch(()=>null) as Record<string,any>|null;
 if(relay&&!(only&&address))return Response.json(relay,{headers:{'Cache-Control':'no-store'}});
 if(p.get('updates')==='1')return new Response(null,{status:204,headers:{'Cache-Control':'no-store'}});
 const savedEntries=only?relay?.rows.find((r:any)=>r.id===only)?.depthChecks?.flatMap((c:any)=>c.entries)||[]:[];
 const data=await wideScan({budget,floor,address,only,cursor,poolCursor,maxImpact,savedEntries});
 let recorded=false;if(!only)try{await logScan(data);recorded=true}catch{}
 return Response.json({...data,mode:'클라우드 직접 조회',recorded},{headers:{'Cache-Control':'no-store'}});
}
// Sites authenticates service callers before dispatch to this owner-private site.
export async function POST(req:Request){
 const p=new URL(req.url).searchParams;
 if(p.get('mode')==='settings'){
   const {amount,min,maxImpact=DEFAULT_IMPACT}=await req.json() as {amount:number,min:number,maxImpact?:number};if(!valid(amount,min)||!validImpact(maxImpact))return new Response('입력 오류',{status:400});
   await writeState('settings',{amount,min,maxImpact});return Response.json({saved:true});
 }
 if(p.get('mode')!=='monitor')return new Response('모드 오류',{status:400});
 const settings=await readState('settings')||{amount:1000,min:5},state=await readState('monitor')||{};
 const relay=await latestRelay(settings.amount,settings.min,'',settings.maxImpact??DEFAULT_IMPACT).catch(()=>null) as Record<string,any>|null;
 if(relay)return Response.json({at:relay.at,tokens:relay.tokens.length,compared:relay.checked,verified:relay.rows.length,recorded:true,mode:relay.mode});
 const data=await wideScan({budget:settings.amount,floor:settings.min,maxImpact:settings.maxImpact??DEFAULT_IMPACT,cursor:state.cursor||'',poolCursor:state.pool||0});
 await logScan(data);await writeState('monitor',{cursor:data.nextCursor,pool:data.poolCursor,at:data.at});
 return Response.json({at:data.at,tokens:data.tokens.length,compared:data.checked,verified:data.rows.length,recorded:true});
}
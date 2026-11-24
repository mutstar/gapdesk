import {acceptRelay} from '../../../lib/relay';
import {writeState} from '../../../lib/scan-store';

export async function POST(req:Request){
 try{
   if(new URL(req.url).searchParams.get('view')!=='dex-streams')return await acceptRelay(req);
   if(req.headers.get('content-type')!=='application/json')return new Response(null,{status:415});
   const bytes=await req.arrayBuffer();
   if(bytes.byteLength>512000)return new Response(null,{status:413});
   const report=JSON.parse(new TextDecoder().decode(bytes));
   if(!Number.isSafeInteger(report.reportedAt)||Math.abs(Date.now()-report.reportedAt)>90000||
     !Array.isArray(report.eventStreams)||report.eventStreams.length>200||!Array.isArray(report.swapReceipts)||report.swapReceipts.length>2000)
     return new Response(null,{status:400});
   await writeState('dex-stream-coverage',{reportedAt:report.reportedAt,eventStreams:report.eventStreams,swapReceipts:report.swapReceipts});
   return Response.json({recorded:true});
 }catch{return new Response('시장 스냅샷을 저장할 수 없습니다.',{status:503})}
}
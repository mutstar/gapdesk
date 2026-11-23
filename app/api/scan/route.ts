import {scan} from '../../../lib/market.mjs';
export async function GET(request:Request){
 const p=new URL(request.url).searchParams, budget=Number(p.get('amount')??1000),floor=Number(p.get('floor')??5),address=p.get('address')||undefined;
 if(!Number.isFinite(budget)||budget<10||budget>100000||!Number.isFinite(floor)||floor<0||floor>100000||address&&!/^0x[0-9a-fA-F]{40}$/.test(address))return new Response('입력값 오류',{status:400});
 return Response.json(await scan(budget,floor,address,p.get('only')||undefined),{headers:{'Cache-Control':'no-store'}});
}
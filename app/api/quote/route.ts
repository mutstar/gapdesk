import {getQuote} from '../../../lib/market.mjs';
import {CHAINS,NATIVE} from '../../../lib/assets.js';
export async function POST(req:Request){
 try{
 const {from,to,side,amount,address,input,output}=await req.json() as {from:number,to:number,side:string,amount:string,address:string,input?:string,output?:string};
 const chains=CHAINS as Record<number,{usdc:string}>,valid=(v:string)=>/^0x[0-9a-f]{40}$/i.test(v);
 if(!chains[from]||!chains[to]||!['buy','bridge','sell'].includes(side)||!valid(address)||!/^\d{1,78}$/.test(amount)||BigInt(amount)<=BigInt(0)||(side==='bridge')!==(from!==to))return new Response('입력값 오류',{status:400});
 const src=input??(side==='buy'?chains[from].usdc:NATIVE),dst=output??(side==='sell'?chains[to].usdc:NATIVE);
 if(!valid(src)||!valid(dst)||(side==='buy'&&src!==chains[from].usdc)||(side==='sell'&&dst!==chains[to].usdc))return new Response('토큰 주소 오류',{status:400});
 return Response.json(await getQuote(from,to,src.toLowerCase(),dst.toLowerCase(),amount,address),{headers:{'Cache-Control':'no-store'}});
 }catch{return new Response('경로 견적을 받을 수 없습니다.',{status:503})}
}
import {getQuote} from '../../../lib/market.mjs';
import {CHAINS,NATIVE} from '../../../lib/assets.js';
export async function POST(req:Request){
 try{
 const {from,to,side,amount,address}=await req.json() as {from:number,to:number,side:string,amount:string,address:string};
 if(![8453,42161].includes(from)||![8453,42161].includes(to)||!['buy','bridge','sell'].includes(side)||!/^0x[0-9a-fA-F]{40}$/.test(address)||!/^\d{1,24}$/.test(amount)||BigInt(amount)<=BigInt(0)||(side==='bridge')!==(from!==to))return new Response('입력값 오류',{status:400});
 const chains=CHAINS as Record<number,{usdc:string}>;
 const quote=await getQuote(from,to,side==='buy'?chains[from].usdc:NATIVE,side==='sell'?chains[to].usdc:NATIVE,amount,address);
 return Response.json(quote,{headers:{'Cache-Control':'no-store'}});
 }catch{return new Response('경로 견적을 받을 수 없습니다.',{status:503})}
}


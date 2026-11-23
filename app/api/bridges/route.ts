import {lookupBridge} from '../../../lib/bridge-lookup.mjs';
import {bridgeDestinations} from '../../../lib/token-contracts.mjs';
import {latestRelay} from '../../../lib/relay';
import {prepareScan} from '../../../lib/universe.mjs';
import {CHAINS} from '../../../lib/assets.js';

type Contract={chain:string|number,token:string,group:number};
const reply=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
export async function POST(req:Request){
  try{
    const {symbol,from,to,fromToken,toToken,budget,floor,address}=await req.json() as {symbol:string,from:number,to:number,fromToken:string,toToken:string,budget:number,floor:number,address?:string};
    const valid=(s:unknown)=>typeof s==='string'&&/^0x[0-9a-f]{40}$/i.test(s);
    if(typeof symbol!=='string'||!symbol||symbol.length>100||!Number.isInteger(from)||!Object.hasOwn(CHAINS,from)||
       !Number.isInteger(to)||!Object.hasOwn(CHAINS,to)||from===to||!valid(fromToken)||!valid(toToken)||
       address&&!valid(address)||!Number.isFinite(budget)||budget<10||budget>100000||
       !Number.isFinite(floor)||floor<0||floor>100000)return reply({reason:'조회 조건을 확인해 주세요.'},400);
    const relay=await latestRelay(budget,floor).catch(()=>null) as Record<string,any>|null;
    const snapshot=relay?.tokens?.some((t:any)=>Array.isArray(t.contracts))?relay:(await prepareScan({budget,floor,poolPass:undefined})).snapshot;
    const contracts:Contract[]=snapshot.tokens.find((t:{symbol:string})=>t.symbol===symbol)?.contracts||[];
    const src=contracts.find(c=>c.chain===from&&c.token===fromToken.toLowerCase());
    if(!bridgeDestinations(src,contracts).some((c:Contract)=>c.chain===to&&c.token===toToken.toLowerCase()))
      return reply({status:'unknown',reason:'이 두 컨트랙트가 같은 자산인지 확인할 수 없어요.'});
    return reply(await lookupBridge({from,to,fromToken:fromToken.toLowerCase(),toToken:toToken.toLowerCase(),budget,address:address||undefined}));
  }catch{return reply({status:'unknown',reason:'브리지 견적을 받지 못했어요. 잠시 후 다시 조회해 주세요.'},503)}
}

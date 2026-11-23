import {signalHistory,InvalidSignalQuery} from '../../../lib/signal-store';
export async function GET(req:Request){
  const headers={'Cache-Control':'no-store'};
  try{return Response.json(await signalHistory(new URL(req.url).searchParams),{headers})}
  catch(e){
    if(e instanceof InvalidSignalQuery)return new Response('조회 조건을 확인해 주세요.',{status:400,headers});
    return new Response('감지 기록 저장소에 연결할 수 없어요.',{status:503,headers});
  }
}

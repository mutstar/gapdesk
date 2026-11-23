import {acceptRelay} from '../../../lib/relay';
export async function POST(req:Request){try{return await acceptRelay(req)}catch{return new Response('시장 스냅샷을 저장할 수 없습니다.',{status:503})}}
import {strictContractKey} from './contract-identity.mjs';
type Data=Record<string,any>;
async function database(){
 const {env}=await import('cloudflare:workers');
 if(!env.DB)throw Error('기록 저장소 연결 대기');
 return env.DB;
}
export async function readState(key:string){
 const storage=await database();
 const row=await storage.prepare('SELECT value FROM scan_state WHERE id=?').bind(key).first<{value:string}>();
 return row?JSON.parse(row.value):null;
}
export async function writeState(key:string,value:unknown){
 const storage=await database();
 await storage.prepare('INSERT INTO scan_state(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
   .bind(key,JSON.stringify(value)).run();
}
export async function logScan(scan:Data,connection?:D1Database){
 const seen=scan.at,hour=Math.floor(seen/3600000);
 const storage=connection??await database();
 const events:Data[]=[];
 for(const t of scan.tokens){
   const contractKey=strictContractKey(t.match);
   if(contractKey&&t.gap>=5&&t.time>0&&seen-t.time<45000)
     events.push({symbol:t.symbol,buy:t.buy,sell:t.sell,gap:t.gap,kind:'경로 확인 시세차',contractKey});
 }
 for(const r of scan.rows){
   const contractKey=strictContractKey({chain:r.from,token:r.fromToken});
   if(contractKey&&contractKey===strictContractKey({chain:r.to,token:r.toToken}))
     events.push({symbol:r.symbol,buy:r.buy,sell:r.sell,gap:r.bps,kind:'견적 통과',contractKey});
 }
 // Collapse repeated observations within the hour, retaining the highest observed spread.
 // D1 JSON expansion keeps each batch well below the SQL parameter limit.
 const statement=storage.prepare(`INSERT INTO detections(id,symbol,buy,sell,gap,seen,kind,contract_key)
 SELECT json_extract(value,'$.id'),json_extract(value,'$.symbol'),json_extract(value,'$.buy'),json_extract(value,'$.sell'),json_extract(value,'$.gap'),?,json_extract(value,'$.kind'),json_extract(value,'$.contractKey') FROM json_each(?) WHERE 1
 ON CONFLICT(id) DO UPDATE SET gap=excluded.gap,seen=excluded.seen WHERE excluded.gap>detections.gap`);
 const inserts=[];for(let i=0;i<events.length;i+=100){
 const part=events.slice(i,i+100).map(e=>({...e,id:JSON.stringify([hour,e.symbol,e.buy,e.sell,e.kind,e.contractKey])}));
 inserts.push(statement.bind(seen,JSON.stringify(part)))}
 inserts.push(storage.prepare('DELETE FROM detections WHERE seen<?').bind(seen-86400000));
 await storage.batch(inserts);
}
export async function history(symbol='',screened=false,connection?:D1Database,now=Date.now()){
 const storage=connection??await database();
 const sql=`SELECT symbol,buy,sell,gap,seen,kind,contract_key AS contractKey,
   substr(contract_key,1,instr(contract_key,':')-1) AS chain,substr(contract_key,instr(contract_key,':')+1) AS token
   FROM detections WHERE seen>? AND contract_key IS NOT NULL`+(symbol?' AND symbol=?':'')+
   (screened?" AND kind IN ('경로 확인 시세차','견적 통과')":"")+' ORDER BY seen DESC,gap DESC LIMIT 100';
 const st=storage.prepare(sql).bind(now-86400000,...(symbol?[symbol.toUpperCase()]:[]));
 return (await st.all()).results;
}

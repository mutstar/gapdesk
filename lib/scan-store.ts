import {env} from 'cloudflare:workers';
type Data=Record<string,any>;
const db=()=>{if(!env.DB)throw Error('기록 저장소 연결 대기');return env.DB};
export async function readState(key:string){const row=await db().prepare('SELECT value FROM scan_state WHERE id=?').bind(key).first<{value:string}>();return row?JSON.parse(row.value):null}
export async function writeState(key:string,value:unknown){await db().prepare('INSERT INTO scan_state(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').bind(key,JSON.stringify(value)).run()}
export async function logScan(scan:Data){
 const seen=scan.at,hour=Math.floor(seen/3600000);
 const events=[...scan.tokens.filter((x:Data)=>x.gap>=5&&x.time>0&&seen-x.time<45000).map((x:Data)=>({...x,kind:'시세차'})),
 ...scan.rows.map((r:Data)=>({symbol:r.symbol,buy:r.buy,sell:r.sell,gap:r.bps,kind:'견적 통과'}))];
 // Collapse repeated observations within the hour, retaining the highest observed spread.
 // D1 JSON expansion keeps each batch well below the SQL parameter limit.
 const statement=db().prepare(`INSERT INTO detections(id,symbol,buy,sell,gap,seen,kind)
 SELECT json_extract(value,'$.id'),json_extract(value,'$.symbol'),json_extract(value,'$.buy'),json_extract(value,'$.sell'),json_extract(value,'$.gap'),?,json_extract(value,'$.kind') FROM json_each(?) WHERE 1
 ON CONFLICT(id) DO UPDATE SET gap=excluded.gap,seen=excluded.seen WHERE excluded.gap>detections.gap`);
 const inserts=[];for(let i=0;i<events.length;i+=100){
 const part=events.slice(i,i+100).map(e=>({id:JSON.stringify([hour,e.symbol,e.buy,e.sell,e.kind]),symbol:e.symbol,buy:e.buy,sell:e.sell,gap:e.gap,kind:e.kind}));
 inserts.push(statement.bind(seen,JSON.stringify(part)))}
 inserts.push(db().prepare('DELETE FROM detections WHERE seen<?').bind(seen-86400000));
 await db().batch(inserts);
}
export async function history(symbol=''){
 const st=symbol?db().prepare('SELECT symbol,buy,sell,gap,seen,kind FROM detections WHERE seen>? AND symbol=? ORDER BY seen DESC,gap DESC LIMIT 100').bind(Date.now()-86400000,symbol.toUpperCase()):
 db().prepare('SELECT symbol,buy,sell,gap,seen,kind FROM detections WHERE seen>? ORDER BY seen DESC,gap DESC LIMIT 100').bind(Date.now()-86400000);
 return (await st.all()).results;
}

import {families} from './venue-family.mjs';
import {strictContractKey} from './contract-identity.mjs';
type Row=Record<string,any>;
const DAY=86400000;
const MAX_GAP_MS=45000;
const clock='COALESCE((SELECT cycle FROM signal_stream WHERE id=1),0)';
const gapFields=`id, route_id AS routeId, symbol, buy, sell, contract_key AS contractKey,
  substr(contract_key,1,instr(contract_key,':')-1) AS chain, substr(contract_key,instr(contract_key,':')+1) AS token, opened_at AS openedAt, last_seen AS lastSeen,
  closed_at AS closedAt, state, entry_gap AS entryGap, latest_gap AS latestGap, entry_ask AS entryAsk,
  entry_bid AS entryBid, latest_ask AS latestAsk, latest_bid AS latestBid, budget, floor,
  max_impact AS maxImpact, status, reason, profit, checked_at AS checkedAt`;
const spikeFields=`id, symbol, venue, market_id AS marketId, side, window_sec AS windowSec, at,
  baseline_at AS baselineAt, baseline_price AS baselinePrice, price, change_pct AS changePct,
  threshold_pct AS thresholdPct, corroborated`;
const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
const positive=(n:unknown):n is number=>finite(n)&&n>0;
const integer=(n:unknown):n is number=>positive(n)&&Number.isSafeInteger(n);
const str=(s:unknown,max:number):s is string=>typeof s==='string'&&s.length>0&&s.length<=max;
function chunks<T>(rows:T[],n:number){
  const result:T[][]=[];
  for(let i=0;i<rows.length;i+=n)result.push(rows.slice(i,i+n));
  return result;
}
async function storage(){
  const {env}=await import('cloudflare:workers');
  if(!env.DB)throw Error('감지 기록 저장소 연결 대기');
  return env.DB;
}

export async function logSignals(scan:Row,connection?:D1Database){
  if(!Array.isArray(scan.signalGaps))return;
  const db=connection??await storage(), cycle=scan.startedAt, seen=scan.at;
  if(!integer(cycle)||!integer(seen)||!positive(scan.budget)||!finite(scan.floor)||!positive(scan.maxImpact))
    throw Error('감지 시각 또는 설정 오류');
  const gaps:Row[]=scan.signalGaps.flatMap((gap:Row)=>{
    const key=strictContractKey(gap?.match);
    return key?[{...gap,contractKey:key}]:[];
  });
  const checks:Row[]=scan.entryChecks??[], spikes:Row[]=scan.spikes??[];
  for(const r of gaps){
    if(!str(r.id,1000)||!r.id.includes('|')||!str(r.symbol,150)||!str(r.buy,300)||!str(r.sell,300)||
       !positive(r.gap)||!positive(r.ask)||!positive(r.bid)||r.blocked!=null&&!str(r.blocked,500))
      throw Error('갭 관측값 오류');
  }
  const tx:D1PreparedStatement[]=[];
  const sql=(s:string,...params:(string|number|null)[])=>tx.push(db.prepare(s).bind(...params));
  // All cycle changes share one D1 batch transaction. A retry sees the advanced clock;
  // delayed check results below still attach to their own cycle.
  sql(`UPDATE gap_episodes SET closed_at=?,state='interrupted' WHERE closed_at IS NULL AND ?>${clock}
    AND (?-last_seen>? OR budget<>? OR floor<>? OR max_impact<>? OR ?-${clock}>?)`,
    seen,cycle,seen,MAX_GAP_MS+15000,scan.budget,scan.floor,scan.maxImpact,cycle,MAX_GAP_MS);
  for(const chunk of chunks(gaps,120)){
    // A closure or reopening starts a new observation even if both book prices persist.
    sql(`WITH incoming AS (SELECT value->>'$.id' AS route,value->>'$.contractKey' AS ca,
       COALESCE(value->>'$.blocked',value->>'$.reason') AS reason FROM json_each(?))
       UPDATE gap_episodes SET closed_at=?,state='closed'
       WHERE closed_at IS NULL AND ?>${clock} AND (route_id,contract_key) IN (SELECT route,ca FROM incoming)
       AND reason IS NOT (SELECT reason FROM incoming WHERE route=route_id AND ca=contract_key)`,
       JSON.stringify(chunk),seen,cycle);
    sql(`INSERT INTO gap_episodes
       (id,route_id,contract_key,entry_cycle,symbol,buy,sell,opened_at,last_seen,state,entry_gap,latest_gap,entry_ask,entry_bid,latest_ask,latest_bid,budget,floor,max_impact,status,reason)
       SELECT json_array(?,v->>'$.id',v->>'$.contractKey'),v->>'$.id',v->>'$.contractKey',?,v->>'$.symbol',v->>'$.buy',v->>'$.sell',?,?,'active',
       v->>'$.gap',v->>'$.gap',v->>'$.ask',v->>'$.bid',v->>'$.ask',v->>'$.bid',?,?,?,
       CASE WHEN v->>'$.basis' IN ('perp_spot','perp_perp') THEN v->>'$.basis' WHEN v->>'$.blocked' IS NULL THEN 'unchecked' ELSE 'blocked' END,COALESCE(v->>'$.blocked',v->>'$.reason')
       FROM (SELECT value AS v FROM json_each(?)) WHERE ?>${clock}
       ON CONFLICT(route_id,contract_key) WHERE closed_at IS NULL DO UPDATE SET
       latest_gap=excluded.latest_gap,latest_ask=excluded.latest_ask,latest_bid=excluded.latest_bid,last_seen=excluded.last_seen`,
       cycle,cycle,seen,seen,scan.budget,scan.floor,scan.maxImpact,JSON.stringify(chunk),cycle);
  }
  // A vanished venue observation can't prove the spread closed.
  sql(`WITH observed AS MATERIALIZED (SELECT value FROM json_each(?))
    UPDATE gap_episodes SET closed_at=?, state=CASE
      WHEN substr(route_id,1,instr(route_id,'|')-1) IN observed AND substr(route_id,instr(route_id,'|')+1) IN observed
      THEN 'closed' ELSE 'interrupted' END
    WHERE closed_at IS NULL AND last_seen<? AND ?>${clock}`,JSON.stringify(scan.signalMarketIds??[]),seen,seen,cycle);
  for(const r of checks){
    const key=strictContractKey(r.match);
    if(!key||!str(r.id,1000)||!integer(r.cycle)||!integer(r.checkedAt)||!['passed','unconfirmed','below_floor'].includes(r.status))continue;
    if(r.status==='passed'&&(!finite(r.profit)||r.profit<=0))continue;
    sql(`UPDATE gap_episodes SET status=?,profit=?,checked_at=?
      WHERE id=json_array(?,?,?) AND status='unchecked'
      AND ?>=opened_at AND ?<=opened_at+? AND (?<>'passed' OR ?>=floor)`,
      r.status,r.status==='passed'?r.profit:null,r.checkedAt,r.cycle,r.id,key,r.checkedAt,r.checkedAt,MAX_GAP_MS,r.status,r.profit??0);
  }
  for(const chunk of chunks(spikes.filter(r=>str(r.id,1600)&&str(r.symbol,150)&&str(r.venue,300)&&str(r.marketId,800)&&
    ['up','down'].includes(r.side)&&integer(r.at)&&integer(r.baselineAt)&&r.at>=seen-8*DAY&&r.at<=seen+5000&&r.baselineAt<r.at&&
    positive(r.baselinePrice)&&positive(r.price)&&finite(r.changePct)&&positive(r.thresholdPct)&&positive(r.windowSec)),100)){
    sql(`INSERT INTO venue_spikes(id,symbol,venue,market_id,side,window_sec,at,baseline_at,baseline_price,price,change_pct,threshold_pct,corroborated)
      SELECT v->>'$.id',v->>'$.symbol',v->>'$.venue',v->>'$.marketId',v->>'$.side',v->>'$.windowSec',v->>'$.at',v->>'$.baselineAt',
        v->>'$.baselinePrice',v->>'$.price',v->>'$.changePct',v->>'$.thresholdPct',COALESCE(v->>'$.corroborated',0)
      FROM (SELECT value AS v FROM json_each(?)) WHERE 1 ON CONFLICT(id) DO NOTHING`,JSON.stringify(chunk));
  }
  // Hourly housekeeping, retaining a full seven days plus a rollover day.
  sql(`DELETE FROM gap_episodes WHERE last_seen<? AND ?>${clock}/3600000`,seen-8*DAY,Math.floor(cycle/3600000));
  sql(`DELETE FROM venue_spikes WHERE at<? AND ?>${clock}/3600000`,seen-8*DAY,Math.floor(cycle/3600000));
  sql(`INSERT INTO scan_state(id,value) VALUES('signal-history-start',?) ON CONFLICT(id) DO NOTHING`,String(seen));
  sql(`INSERT INTO signal_stream(id,cycle,seen) VALUES(1,?,?)
    ON CONFLICT(id) DO UPDATE SET cycle=excluded.cycle,seen=excluded.seen WHERE excluded.cycle>signal_stream.cycle`,cycle,seen);
  await db.batch(tx);
}

export class InvalidSignalQuery extends Error {}
export async function signalHistory(params:URLSearchParams,connection?:D1Database,now=Date.now()){
  const kind=params.get('kind')??'gaps',hours=Number(params.get('hours')??24);
  const symbol=(params.get('symbol')??'').trim().toUpperCase(),venue=(params.get('venue')??'').trim();
  const limit=Number(params.get('limit')??50),market=params.get('market')||'all',family=params.get('family')||'전체';
  if(!families.includes(family)||!['all','spot','perp_spot','perp_perp'].includes(market)||!['gaps','spikes'].includes(kind)||!Number.isInteger(hours)||hours<1||hours>168||
    !Number.isInteger(limit)||limit<1||limit>100||symbol.length>150||venue.length>300)throw new InvalidSignalQuery();
  const db=connection??await storage(),gaps=kind==='gaps',time=gaps?'opened_at':'at',source=gaps?'gap_episodes':'venue_spikes';
  const clauses=[time+'>=?',time+'<=?'],bindings:(string|number)[]=[];
  const cursor=params.get('cursor');
  const screened=gaps&&params.get('screened')==='1';
  const filterKey=JSON.stringify([kind,hours,symbol,venue,...(market==='all'?[]:[market]),...(screened?['screened']:[]),...(family==='전체'?[]:[family])]);
  if(gaps)clauses.push('contract_key IS NOT NULL');
  if(gaps&&family!=='전체'){
    // Historical route IDs retain the original venue prefixes on both legs.
    const left="substr(route_id,1,instr(route_id,':')-1)";
    const rightLeg="substr(route_id,instr(route_id,'|')+1)";
    const right=`substr(${rightLeg},1,instr(${rightLeg},':')-1)`;
    const cex="('bitget','kucoin','binance','bithumb','gate')";
    if(family==='DEX–DEX')clauses.push(`${left}='dex' AND ${right}='dex'`);
    if(family==='CEX–CEX')clauses.push(`${left} IN ${cex} AND ${right} IN ${cex}`);
    if(family==='DEX–CEX')clauses.push(`((${left}='dex' AND ${right} IN ${cex}) OR (${right}='dex' AND ${left} IN ${cex}))`);
  }
  if(screened)clauses.push("(status IN ('passed','perp_spot','perp_perp') OR reason='동일 네트워크 이동 경로 확인')");
  let anchor=now;
  if(cursor){
    try{
      if(cursor.length>4500)throw Error();
      const [a,t,id,filter]=JSON.parse(cursor);
      if(!integer(a)||a>now+5000||!integer(t)||t>a||t<a-hours*3600000||!str(id,2200)||filter!==filterKey)throw Error();
      anchor=a;clauses.push('('+time+',id)<(?,?)');bindings.push(t,id);
    }catch{throw new InvalidSignalQuery()}
  }
  bindings.unshift(anchor-hours*3600000,anchor);
  if(gaps&&market==='spot')clauses.push("status NOT IN ('perp_spot','perp_perp')");
  if(gaps&&market.startsWith('perp_')){clauses.push('status=?');bindings.push(market)}
  if(symbol){clauses.push('symbol=?');bindings.push(symbol)}
  if(venue){clauses.push(gaps?'(buy=? OR sell=?)':'venue=?');bindings.push(venue);if(gaps)bindings.push(venue)}
  const query=db.prepare(`SELECT ${gaps?gapFields:spikeFields} FROM ${source} WHERE ${clauses.join(' AND ')}
    ORDER BY ${time} DESC,id DESC LIMIT ?`).bind(...bindings,limit+1);
  const [page,clockRow]=await db.batch([query,db.prepare("SELECT seen,(SELECT CAST(value AS INTEGER) FROM scan_state WHERE id='signal-history-start') AS historyStartedAt FROM signal_stream WHERE id=1")]);
  const stream=clockRow.results?.[0] as {seen:number,historyStartedAt:number}|undefined;
  const asOf=stream?.seen??null,historyStartedAt=stream?.historyStartedAt??null;
  const raw=(page.results??[]) as Row[],items=raw.slice(0,limit);
  for(const r of items){
    if(gaps&&r.state==='active'&&(!asOf||now-asOf>90000))r.state='interrupted';
    if(!gaps)r.corroborated=!!r.corroborated;
  }
  const last=items.at(-1),nextCursor=raw.length>limit&&last?JSON.stringify([anchor,last[gaps?'openedAt':'at'],last.id,filterKey]):null;
  return {items,nextCursor,asOf,historyStartedAt};
}

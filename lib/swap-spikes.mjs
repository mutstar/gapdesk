import {createHash} from 'node:crypto';
import {CHAINS,NATIVE} from './assets.js';
import {dexVenues,networks} from './dex-venues.mjs';
import {SPIKE_THRESHOLD_PCT} from './venue-spikes.mjs';

const usd={
  ethereum:['0xdac17f958d2ee523a2206206994597c13d831ec7'],
  bsc:['0x55d398326f99059ff775485246999027b3197955'],
  arbitrum:['0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9'],
  solana:['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
};
const wrapped={ethereum:'0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',bsc:'0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  base:'0x4200000000000000000000000000000000000006',arbitrum:'0x82af49447d8a07e3bd95bd0d56f35241523fbab1',solana:'So11111111111111111111111111111111111111112'};
const rank=(chain,token)=>token===CHAINS[networks[chain]]?.usdc?3:usd[chain]?.includes(token)?2:
  token===NATIVE||token===wrapped[chain]?1:0;
const names=new Map(dexVenues.map(v=>[v.id,v.name]));
const short=s=>s.slice(0,6)+'…'+s.slice(-4);

// The detector runs inside the same SQLite transaction as the block checkpoint.
// One bucket per block timestamp keeps intra-second extrema without retaining every trade.
export function createSwapSpikes(db){
  db.exec(`CREATE TABLE IF NOT EXISTS swap_windows(
    lane TEXT,chain TEXT,pool TEXT,at INTEGER,block INTEGER,seq INTEGER,state TEXT,PRIMARY KEY(lane,chain,pool)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS swap_windows_time ON swap_windows(lane,chain,at);
    CREATE TABLE IF NOT EXISTS swap_direct_pools(chain TEXT,pool TEXT,PRIMARY KEY(chain,pool)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS swap_last_spot(chain TEXT,pool TEXT,at INTEGER,block INTEGER,seq INTEGER,ratio REAL,PRIMARY KEY(chain,pool)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS dex_swap_receipts(venue TEXT,chain TEXT,protocol TEXT,at INTEGER,pool TEXT,PRIMARY KEY(venue,chain,protocol)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS swap_alert_queue(id TEXT PRIMARY KEY,body TEXT NOT NULL) WITHOUT ROWID;`);
  const receipt=db.prepare(`INSERT INTO dex_swap_receipts VALUES(?,?,?,?,?) ON CONFLICT(venue,chain,protocol) DO UPDATE SET at=excluded.at,pool=excluded.pool WHERE excluded.at>=dex_swap_receipts.at`);
  const receipts=db.prepare('SELECT venue,chain,protocol,at,pool FROM dex_swap_receipts ORDER BY venue,at DESC');
  const read=db.prepare('SELECT * FROM swap_windows WHERE lane=? AND chain=? AND pool=?');
  const direct=db.prepare('INSERT OR IGNORE INTO swap_direct_pools VALUES(?,?)');
  const lastSpot=db.prepare('SELECT * FROM swap_last_spot WHERE chain=? AND pool=?');
  const saveSpot=db.prepare('INSERT OR REPLACE INTO swap_last_spot VALUES(?,?,?,?,?,?)');
  const save=db.prepare('INSERT OR REPLACE INTO swap_windows VALUES(?,?,?,?,?,?,?)');
  const enqueue=db.prepare('INSERT OR IGNORE INTO swap_alert_queue VALUES(?,?)');
  const trim=db.prepare('DELETE FROM swap_windows WHERE lane=? AND chain=? AND at<?');
  const poolInfo=db.prepare('SELECT token0,token1,venue FROM watch WHERE chain=? AND pool=?');
  const label=db.prepare('SELECT symbol FROM watch_asset_labels WHERE chain=? AND token=?');
  const canonical=db.prepare('SELECT token0,token1 FROM v4_keys WHERE chain=? AND pool=?');
  const pending=db.prepare('SELECT id,body FROM swap_alert_queue LIMIT ?');
  const remove=db.prepare('DELETE FROM swap_alert_queue WHERE id=?');
  let assets=new Map();
  function analyze(samples,lane,lookupSymbol){
    const groups=new Map();
    for(const s of samples){
      if(!(s.rawRatio>0&&Number.isFinite(s.rawRatio)&&Number.isSafeInteger(s.time)&&s.time>0&&Number.isSafeInteger(s.block)&&Number.isSafeInteger(s.seq)))continue;
      const k=s.series?s.pool+'|'+s.series:s.pool;
      if(!groups.has(k))groups.set(k,[]);
      groups.get(k).push(s);
    }
    let newest=0,chain;
    for(const [series,rows] of groups){
      const first=rows[0],pool=first.pool;chain=first.chain;
      const saved=read.get(lane,chain,series);
      const continuousSpot=lane==='canonical'&&['v3','v4','Algebra'].includes(first.protocol);
      const prior=saved??(continuousSpot?lastSpot.get(chain,series):null);
      const state=saved?JSON.parse(saved.state):{buckets:[],up:null,down:null,invert:false,carry:prior?.ratio??null};
      let lastBlock=prior?.block??-1,lastSeq=prior?.seq??-1,lastTime=prior?.at??0,dirty=false;
      const info=poolInfo.get(chain,pool),key=first.protocol==='v4'?canonical.get(chain,pool):null;
      // Standard EVM pools order currencies numerically. Solana's decoder supplies
      // a fixed mint order even when the swap instruction reverses the vaults.
      const pair=first.axis?[]:first.tokens??(key?[key.token0,key.token1]:info?.token0&&info?.token1?[info.token0,info.token1].sort():[]);
      const invert=pair.length===2&&rank(chain,pair[0])>rank(chain,pair[1]);
      if(state.invert!==invert){state.up=null;state.down=null;state.invert=invert}
      let received=null;
      for(const s of rows){
        if(s.block<lastBlock||s.block===lastBlock&&s.seq<=lastSeq)continue;
        if(s.time<lastTime){state.buckets=[];state.carry=null;state.up=null;state.down=null}
        if(s.time-lastTime>60000){state.up=null;state.down=null}
        lastTime=s.time;lastBlock=s.block;lastSeq=s.seq;dirty=true;
        while(state.buckets.length&&state.buckets[0][0]<s.time-60000){
          const expired=state.buckets.shift();
          if(continuousSpot)state.carry=expired[3];
        }
        const value=invert?1/s.rawRatio:s.rawRatio;
        if(!Number.isFinite(value)||value<=0)continue;
        if(!s.seed&&['canonical','tip'].includes(lane)&&names.has(s.venue??info?.venue))received=s;
        const carry=continuousSpot&&state.carry?(invert?1/state.carry:state.carry):null;
        let low=carry??Infinity,high=carry??0,lowAt=carry?s.time-60000:0,highAt=lowAt;
        for(const [at,min,max] of state.buckets){
          const floor=invert?1/max:min,ceil=invert?1/min:max;
          if(floor<low){low=floor;lowAt=at}
          if(ceil>high){high=ceil;highAt=at}
        }
        for(const [side,base,at] of [['up',low,lowAt],['down',high,highAt]]){
          const pct=(value/base-1)*100;
          if(s.seed)continue;
          if(!at||!Number.isFinite(pct)||(side==='up'?pct:-pct)<SPIKE_THRESHOLD_PCT-1e-9){state[side]=null;continue}
          // Log the threshold crossing and any new extreme during the excursion.
          if(state[side]!==null&&(side==='up'?value<=state.up:value>=state.down))continue;
          state[side]=value;
          const target=pair[invert?1:0],quote=pair[invert?0:1];
          const a=assets.get(chain+':'+target),b=assets.get(chain+':'+quote);
          const symbol=a?.symbol??(target?label.get(chain,target)?.symbol:null)??(chain==='solana'&&target?lookupSymbol(target):null)??(target?short(target):short(pool)+(s.axis?' '+s.axis:''));
          const decimalsKnown=s.protocol==='solana'||s.humanUnits||[a?.decimals,b?.decimals].every(n=>Number.isInteger(n)&&n>=0&&n<=36);
          const unit=decimalsKnown&&quote?(b?.symbol??label.get(chain,quote)?.symbol??(chain==='solana'?lookupSymbol(quote):null)??short(quote)):null;
          const factor=s.protocol==='solana'||s.humanUnits?1:unit?10**(a.decimals-b.decimals):1;
          const price=unit?value*factor:100*(value/base),baselinePrice=unit?base*factor:100;
          if(!Number.isFinite(price)||!Number.isFinite(baselinePrice)||price<=0||baselinePrice<=0)continue;
          const venueId=s.venue??(s.protocol==='v4'?'uniswap':info?.venue);
          const title=names.get(venueId)??venueId??'DEX';
          const venue=title+(['solana','indexed'].includes(s.protocol)?'':' '+s.protocol.toUpperCase())+' · '+(CHAINS[networks[chain]]?.name??chain);
          const marketId=['swap',chain,pool,target??'',unit??''].map(encodeURIComponent).join('/');
          const digest=createHash('sha256').update(JSON.stringify(['swap',chain,pool,s.block,s.seq,s.hash??'',side])).digest('hex');
          const id='swap-'+String(s.block).padStart(16,'0')+'-'+String(s.seq).padStart(9,'0')+'-'+digest;
          enqueue.run(id,JSON.stringify({id,marketId,side,symbol,venue,at:s.time,baselineAt:at,price,baselinePrice,
            changePct:pct,windowSec:60,thresholdPct:SPIKE_THRESHOLD_PCT,corroborated:false}));
        }
        const last=state.buckets.at(-1);
        if(last?.[0]===s.time){last[1]=Math.min(last[1],s.rawRatio);last[2]=Math.max(last[2],s.rawRatio);last[3]=s.rawRatio}
        else state.buckets.push([s.time,s.rawRatio,s.rawRatio,s.rawRatio]);
      }
      if(received)receipt.run(received.venue??info.venue,chain,received.protocol,received.time,pool);
      if(dirty){
        if(['canonical','tip'].includes(lane)&&rows.some(r=>!r.seed))direct.run(chain,pool);
        save.run(lane,chain,series,lastTime,lastBlock,lastSeq,JSON.stringify(state));
        if(continuousSpot&&state.buckets.length)saveSpot.run(chain,series,lastTime,lastBlock,lastSeq,state.buckets.at(-1)[3]);
        newest=Math.max(newest,lastTime);
      }
    }
    if(newest)trim.run(lane,chain,newest-(lane==='index'?7*86400000:120000));
  }
  return {analyze,receipts:()=>receipts.all(),setAssets(items){assets=new Map(items.map(a=>[a.slug+':'+a.token,a]))},
    pending(limit=500){return pending.all(limit).map(r=>JSON.parse(r.body))},ack(ids){for(const id of ids)remove.run(id)}};
}

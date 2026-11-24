// Collector-only durable discovery and fair pricing queue.
import {createSwapSpikes} from './swap-spikes.mjs';
import {DatabaseSync} from 'node:sqlite';

export function openWatchRegistry(file) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS watch(chain TEXT NOT NULL,pool TEXT NOT NULL,venue TEXT,token0 TEXT,token1 TEXT,
      activity INTEGER NOT NULL DEFAULT 0, checked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(chain,pool)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS watch_active ON watch(chain,activity DESC);
    CREATE TABLE IF NOT EXISTS factory_keys(chain TEXT,pool TEXT,token0 TEXT,token1 TEXT,venue TEXT,protocol TEXT,PRIMARY KEY(chain,pool)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS solana_symbols(mint TEXT PRIMARY KEY,symbol TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS watch_asset_labels(chain TEXT,token TEXT,symbol TEXT,PRIMARY KEY(chain,token)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS v4_keys(chain TEXT,pool TEXT,token0 TEXT,token1 TEXT,PRIMARY KEY(chain,pool)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS checkpoints(id TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;`);
  const upsert=db.prepare(`INSERT INTO watch(chain,pool,venue,token0,token1,activity) VALUES(?,?,?,?,?,?)
    ON CONFLICT(chain,pool) DO UPDATE SET venue=coalesce(watch.venue,excluded.venue),
    token0=coalesce(watch.token0,excluded.token0),token1=coalesce(watch.token1,excluded.token1),
    activity=max(watch.activity,excluded.activity)
    WHERE excluded.activity>watch.activity OR (excluded.venue IS NOT NULL AND watch.venue IS NULL)
      OR (excluded.token0 IS NOT NULL AND watch.token0 IS NULL)`);
  const checkpoint=db.prepare('INSERT OR REPLACE INTO checkpoints VALUES(?,?)');
  const read=db.prepare('SELECT value FROM checkpoints WHERE id=?');
  const fair=db.prepare('SELECT * FROM watch WHERE chain=? AND pool>? AND checked<? ORDER BY pool LIMIT 30');
  const spikes=createSwapSpikes(db);
  const tradePool=db.prepare(`SELECT w.chain,w.pool,w.venue,w.token0,w.token1 FROM watch w
    WHERE w.chain=? AND w.pool>? AND w.venue IS NOT NULL AND w.token0 IS NOT NULL AND w.token1 IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM swap_direct_pools s WHERE s.chain=w.chain AND s.pool=w.pool)
    ORDER BY w.pool LIMIT 1`);
  const saveSymbol=db.prepare('INSERT OR IGNORE INTO solana_symbols VALUES(?,?)');
  const saveLabel=db.prepare('INSERT OR IGNORE INTO watch_asset_labels VALUES(?,?,?)');
  const lookupSymbol=db.prepare('SELECT symbol FROM solana_symbols WHERE mint=?');
  const hot=db.prepare('SELECT * FROM watch WHERE chain=? AND activity>? AND checked<? ORDER BY activity DESC LIMIT ?');
  const checked=db.prepare('UPDATE watch SET checked=? WHERE chain=? AND pool=?');
  const chains=db.prepare('SELECT DISTINCT chain FROM watch');
  const total=db.prepare('SELECT count(*) AS n FROM watch');
  const saveKey=db.prepare('INSERT OR REPLACE INTO v4_keys VALUES(?,?,?,?)');
  const saveFactory=db.prepare('INSERT OR IGNORE INTO factory_keys VALUES(?,?,?,?,?,?)');
  const getFactory=db.prepare('SELECT token0 AS base,token1 AS quote,venue AS dexId,protocol FROM factory_keys WHERE chain=? AND pool=?');
  const getPool=db.prepare('SELECT token0,token1 FROM v4_keys WHERE chain=? AND pool=?');
  function transaction(work) {
    db.exec('BEGIN');
    try {work(); db.exec('COMMIT')} catch(e){db.exec('ROLLBACK');throw e}
  }
  return {
    spikes,
    ackSpikes:ids=>transaction(()=>spikes.ack(ids)),
    symbolFor:mint=>lookupSymbol.get(mint)?.symbol,
    cursor:id=>JSON.parse(read.get(id)?.value??'null'),
    factory:(chain,pool)=>getFactory.get(chain,pool),
    identity:(chain,pool)=>getPool.get(chain,pool),
    commit(rows,id,value,swaps=[],lane='canonical') {
      transaction(()=>{
        for(const p of rows){
          upsert.run(p.chain,p.pool,p.venue??null,p.tokens?.[0]??null,p.tokens?.[1]??null,p.activity??0);
          if(p.symbols)p.symbols.forEach((symbol,i)=>{
            if(typeof symbol==='string'&&symbol.length<=50&&symbol.trim()&&!/[|~\x00-\x1f]/.test(symbol)&&p.tokens?.[i]){
              saveLabel.run(p.chain,p.tokens[i],symbol);
              if(p.chain==='solana')saveSymbol.run(p.tokens[i],symbol);
            }
          });
          if(p.protocol&&p.venue&&p.tokens&&['v2','v3'].includes(p.protocol))saveFactory.run(p.chain,p.pool,...p.tokens,p.venue,p.protocol);
          if(p.initialized)saveKey.run(p.chain,p.pool,...p.tokens);
        }
        if(swaps.length)spikes.analyze(swaps,lane,mint=>lookupSymbol.get(mint)?.symbol);
        if(id)checkpoint.run(id,JSON.stringify(value));
      });
    },
    nextTradePool(chain){
      const after=JSON.parse(read.get('trade-pool/'+chain)?.value??'""');
      return tradePool.get(chain,after)??(after?tradePool.get(chain,''):null);
    },
    chains:()=>chains.all().map(r=>r.chain),
    batch(chain,now) {
      const active=hot.all(chain,now-120000,now-20000,15);
      const list=new Map(active.map(r=>[r.pool,r]));
      const after=JSON.parse(read.get('prices/'+chain)?.value??'""');
      let next=fair.all(chain,after,now-20000);
      if(next.length<30&&after)next=next.concat(fair.all(chain,'',now-20000).filter(p=>p.pool<=after));
      for(const p of next)if(list.size<30)list.set(p.pool,p);
      return [...list.values()];
    },
    attempted(chain,pools,now){transaction(()=>{for(const p of pools)checked.run(now,chain,p.pool);if(pools.length)checkpoint.run('prices/'+chain,JSON.stringify(pools.at(-1).pool))})},
    size:()=>total.get().n,
    close:()=>db.close(),
  };
}

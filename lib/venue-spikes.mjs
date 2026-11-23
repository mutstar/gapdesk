import {createHash} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {gunzipSync,gzipSync} from 'node:zlib';

export const SPIKE_WINDOWS = [30,60,300,900,1800,3600];
export const SPIKE_THRESHOLD_PCT = 10;
const CYCLE = 30_000;
const TOLERANCE = 15_000;
const RING_SIZE = 121;
const historyOffset = slot => (slot % RING_SIZE) * 3;
const positive = n => Number.isFinite(n) && n > 0;

function newTrack(asset,venue) {
  return {asset,venue,history:new Float64Array(RING_SIZE*3),length:0,mask:0,lastTime:0};
}

function append(track,slot,time,ask,bid,mask) {
  const offset=historyOffset(slot);
  track.history[offset]=time;
  track.history[offset+1]=ask;
  track.history[offset+2]=bid;
  track.lastTime=time;
  track.length=Math.min(RING_SIZE,track.length+1);
  track.mask=mask;
}

// Record the corroboration available at detection. Separate pools / pairs on the
// same exchange don't provide an independent venue, nor does a same-symbol asset.
function referenceFor(m,peers,side,base) {
  if(!peers)return null;
  for(const peer of peers) {
    if(peer.venue===m.venue || Math.abs(peer.time-m.time)>TOLERANCE)continue;
    const price=side==='up'?m.bid:m.ask;
    const other=side==='up'?peer.bid:peer.ask;
    if(!positive(other))continue;
    const delta=side==='up'?(other/base-1):(1-other/base);
    if(Math.max(price,other)/Math.min(price,other)<=1.05 && delta>=SPIKE_THRESHOLD_PCT/200)
      return peer.name||peer.venue;
  }
  return null;
}

function event(m,side,secs,baseAt,base,price,change,peers,config) {
  const referenceVenue=referenceFor(m,peers,side,base);
  const id=createHash('sha256').update(JSON.stringify([m.id,side,secs,m.time,config])).digest('hex');
  return {id,symbol:m.symbol,venue:m.name||m.venue,marketId:m.id,side,windowSec:secs,at:m.time,baselineAt:baseAt,
    baselinePrice:base,price,changePct:change,thresholdPct:SPIKE_THRESHOLD_PCT,corroborated:referenceVenue!==null,referenceVenue};
}

function detect(m,track,slot,peers,config,events) {
  let mask=0;
  for(const [i,seconds] of SPIKE_WINDOWS.entries()) {
    const ticks=seconds/30;
    if(track.length<ticks)break;
    const index=historyOffset(slot-ticks);
    const previousTime=track.history[index];
    if(Math.abs(m.time-previousTime-seconds*1000)>TOLERANCE)continue;
    const previousAsk=track.history[index+1],previousBid=track.history[index+2];
    const rise=positive(m.bid)&&positive(previousAsk)?100*(m.bid/previousAsk-1):NaN;
    const drop=positive(m.ask)&&positive(previousBid)?100*(m.ask/previousBid-1):NaN;
    if(Number.isFinite(rise) && rise>=SPIKE_THRESHOLD_PCT-1e-10) {
      const bit=1<<(2*i);
      mask|=bit;
      if(!(track.mask&bit))events.push(event(m,'up',seconds,previousTime,previousAsk,m.bid,rise,peers,config));
    }
    if(Number.isFinite(drop) && drop<=-SPIKE_THRESHOLD_PCT+1e-10) {
      const bit=1<<(2*i+1);
      mask|=bit;
      if(!(track.mask&bit))events.push(event(m,'down',seconds,previousTime,previousBid,m.ask,drop,peers,config));
    }
  }
  return mask;
}

function validSample(m,at) {
  return typeof m?.id==='string' && m.id.length>0 && typeof m.symbol==='string' && m.symbol.length>0 &&
    typeof m.venue==='string' && m.venue.length>0 && (positive(m.ask)||positive(m.bid)) &&
    !(positive(m.ask)&&positive(m.bid)&&m.ask<m.bid) &&
    Number.isSafeInteger(m.time) && m.time>=at-45_000 && m.time<at+CYCLE+5000;
}

// A local SQL cache stores one compressed frame per scan; only the new frame is
// written. The price rings are keyed by actual market ID and occupy ~3 KiB each.
export async function createSpikeTracker({cacheFile,now=Date.now,onCacheError=()=>{}}={}) {
  let tracks=new Map(),lastSlot=-1,lastConfig=null,db=null,writeFrame,trimFrames;
  if(cacheFile) {
    try {
      const {DatabaseSync}=await import('node:sqlite');
      await mkdir(dirname(cacheFile),{recursive:true});
      db=new DatabaseSync(cacheFile);
      db.exec('PRAGMA busy_timeout=200; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS spike_price_frames_v1 (slot INTEGER PRIMARY KEY, config TEXT NOT NULL, samples BLOB NOT NULL)');
      writeFrame=db.prepare('INSERT OR REPLACE INTO spike_price_frames_v1 (slot,config,samples) VALUES (?,?,?)');
      trimFrames=db.prepare('DELETE FROM spike_price_frames_v1 WHERE slot<=?');
      const currentSlot=Math.floor(now()/CYCLE);
      const select=db.prepare('SELECT slot,config,samples FROM spike_price_frames_v1 WHERE slot BETWEEN ? AND ? ORDER BY slot');
      for(const frame of select.iterate(currentSlot-RING_SIZE+1,currentSlot)) {
        if(frame.slot!==lastSlot+1 || frame.config!==lastConfig)tracks.clear();
        const restored=new Map();
        const rows=JSON.parse(gunzipSync(frame.samples,{maxOutputLength:32*1024*1024}).toString());
        for(const [id,asset,venue,time,ask,bid,mask] of rows) {
          const prior=tracks.get(id);
          const track=prior?.asset===asset && prior.venue===venue ? prior : newTrack(asset,venue);
          append(track,frame.slot,time,ask,bid,mask);
          restored.set(id,track);
        }
        tracks=restored;lastConfig=frame.config;lastSlot=frame.slot;
      }
    }catch(error){
      db?.close();db=null;tracks.clear();lastSlot=-1;lastConfig=null;onCacheError(error);
    }
  }

  function observe(markets,{at=now(),config=''}={}) {
    if(!Number.isSafeInteger(at)||at<0||typeof config!=='string')throw Error('Invalid spike scan');
    const slot=Math.floor(at/CYCLE),slotTime=slot*CYCLE;
    if(slot<lastSlot || slot===lastSlot&&config===lastConfig)return [];
    if(slot!==lastSlot+1 || lastConfig!==config)tracks.clear();
    const sampled=new Map(),peers=new Map();
    for(const m of markets) {
      if(!validSample(m,slotTime))continue;
      const prior=sampled.get(m.id);
      if(!prior || m.time>prior.time)sampled.set(m.id,m);
    }
    for(const m of sampled.values()) {
      if(!m.asset)continue;
      if(!peers.has(m.asset))peers.set(m.asset,[]);
      peers.get(m.asset).push(m);
    }
    const next=new Map(),events=[],frame=[];
    for(const m of sampled.values()) {
      const asset=m.asset||null,prior=tracks.get(m.id);
      const same=prior && prior.asset===asset && prior.venue===m.venue;
      // Repeated cached data cannot fill a missing 30s observation.
      if(same && m.time<=prior.lastTime)continue;
      const track=same && m.time-prior.lastTime<=CYCLE+TOLERANCE?prior:newTrack(asset,m.venue);
      const mask=detect(m,track,slot,peers.get(asset),config,events);
      append(track,slot,m.time,m.ask,m.bid,mask);
      next.set(m.id,track);
      if(db)frame.push([m.id,asset,m.venue,m.time,m.ask,m.bid,mask]);
    }
    tracks=next;lastSlot=slot;lastConfig=config;
    if(db) {
      try {
        const bytes=gzipSync(JSON.stringify(frame),{level:1});
        db.exec('BEGIN IMMEDIATE');
        writeFrame.run(slot,config,bytes);
        trimFrames.run(slot-RING_SIZE);
        db.exec('COMMIT');
      }catch(error){
        if(db.isTransaction)db.exec('ROLLBACK');
        onCacheError(error);
      }
    }
    return events;
  }
  return {observe,close(){db?.close();db=null}};
}

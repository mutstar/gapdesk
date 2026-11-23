import {paths} from './qualification.mjs';

export function blockedReason(buy,sell){
  if(buy.venue==='bithumb' && buy.withdrawOpen===false)return '매수처 출금 중단';
  if(sell.venue==='bithumb' && sell.depositOpen===false)return '매도처 입금 중단';
  if(buy.kind==='CEX'&&buy.networks.length && buy.networks.every(n=>n.withdrawOpen===false))return '매수처 출금 중단';
  if(sell.kind==='CEX'&&sell.networks.length && sell.networks.every(n=>n.depositOpen===false))return '매도처 입금 중단';
  // Missing identity, status or bridge evidence is recorded as untested, never as a proven impossibility.
  return null;
}

export function signalInputs(markets,marks,identityOf,candidates,budget,floor){
  const samples=[],symbols=new Map(),gaps=new Map();
  function record(b,s,ask,bid,blocked){
    const id=b.id+'|'+s.id;
    gaps.set(id,{id,symbol:String(b.symbol).trim().toUpperCase(),buy:b.name,sell:s.name,
      ask,bid,gap:(bid/ask-1)*100,blocked});
  }
  for(const m of markets){
    const q=marks.get(m.id);
    if(!q)continue;
    const symbol=String(m.symbol).trim().toUpperCase(),asset=identityOf.get(m.id)||null;
    if(q.buy>0||q.sell>0){
      samples.push({id:m.id,symbol,asset,venue:m.kind==='DEX'?'dex:'+m.dexId:m.venue,name:m.name,ask:q.buy,bid:q.sell,time:m.time});
    }
    if(!symbols.has(symbol))symbols.set(symbol,[]);
    symbols.get(symbol).push(m);
  }
  for(const c of candidates){
    record(c.buy,c.sell,c.signalAsk,c.signalBid,null);
    if(c.direct)gaps.get(c.id).reason='동일 네트워크 이동 경로 확인';
  }
  // Include large observed gaps even when network closures or unverified transfer
  // paths kept them out of the qualification queue (notably KRW-only markets).
  for(const group of symbols.values())for(const b of group){
    const ask=marks.get(b.id).buy;if(!(ask>0))continue;
    for(const s of group){
      if(b===s||b.kind==='CEX'&&s.venue===b.venue||b.kind==='DEX'&&s.kind==='DEX'&&b.pool===s.pool&&b.chain===s.chain)continue;
      const bid=marks.get(s.id).sell;
      if(!(bid>ask && (bid/ask-1)>=Math.max(.05,floor/budget)))continue;
      const left=identityOf.get(b.id),right=identityOf.get(s.id);
      if(left&&right&&left!==right)continue;
      if(gaps.has(b.id+'|'+s.id))continue;
      // For a route that can be tested use the detector's actual arrival-size price,
      // not the sell-side standalone notional used on the all-token board.
      if(left&&right&&!b.observationOnly&&!s.observationOnly&&b.tradeEnabled!==false&&s.tradeEnabled!==false&&paths(b,s).length)continue;
      record(b,s,ask,bid,blockedReason(b,s));
    }
  }
  return {samples,gaps:[...gaps.values()],marketIds:[...marks.keys()]};
}

import {marketContracts,strictContractKey,spotRouteId,transferStatus} from './contract-identity.mjs';
import {isUniswapV4} from './v4-pool.mjs';

export function blockedReason(buy,sell){
  if(buy.venue==='bithumb' && buy.withdrawOpen===false)return '매수처 출금 중단';
  if(sell.venue==='bithumb' && sell.depositOpen===false)return '매도처 입금 중단';
  if(buy.kind==='CEX'&&buy.networks.length && buy.networks.every(n=>n.withdrawOpen===false))return '매수처 출금 중단';
  if(sell.kind==='CEX'&&sell.networks.length && sell.networks.every(n=>n.depositOpen===false))return '매도처 입금 중단';
  // Missing identity, status or bridge evidence is recorded as untested, never as a proven impossibility.
  return null;
}

export function signalInputs(markets,marks,identityOf,candidates,budget,floor){
  const samples=[],marketIds=new Set(marks.keys()),contracts=new Map(),gaps=new Map();
  const observed=new Map(),now=Date.now();
  function record(b,s,ask,bid,match,blocked,reason=null){
    const id=spotRouteId(b.id,s.id,match);
    gaps.set(id,{id,symbol:String(b.symbol).trim().toUpperCase(),buy:b.name,sell:s.name,
      ask,bid,gap:(bid/ask-1)*100,match,blocked,reason});
  }
  for(const m of markets){
    const rawV4=isUniswapV4(m)&&m.kind==='DEX'&&!m.referenceOnly&&m.ask>0&&m.bid>0&&m.ask>=m.bid&&
      Number.isFinite(m.ask)&&Number.isFinite(m.bid)&&m.time>now-45000&&m.time<=now+5000;
    const q=rawV4?{buy:m.ask,sell:m.bid}:marks.get(m.id);
    if(!q)continue;
    observed.set(m.id,q);
    marketIds.add(m.id);
    const symbol=String(m.symbol).trim().toUpperCase(),cas=marketContracts(m);
    const asset=cas.length===1?strictContractKey(cas[0]):null;
    if(!m.wide)samples.push({id:m.id,symbol,asset,venue:m.kind==='DEX'?'dex:'+m.dexId:m.venue,name:m.name,ask:q.buy,bid:q.sell,time:m.time});
    for(const match of cas){
      const id=strictContractKey(match);
      marketIds.add(m.id+'~ca='+id);
      if(!contracts.has(id))contracts.set(id,{match,group:[]});
      contracts.get(id).group.push(m);
    }
  }
  for(const c of candidates){
    if(strictContractKey(c.match))record(c.buy,c.sell,c.signalAsk,c.signalBid,c.match,null,'동일 네트워크 이동 경로 확인');
  }
  // Archived blocked paths also need matching contract evidence on both legs.
  for(const {match,group} of contracts.values())for(const b of group){
    const ask=observed.get(b.id).buy;if(!(ask>0))continue;
    for(const s of group){
      if(b===s||b.kind==='CEX'&&b.venue===s.venue||b.kind==='DEX'&&s.kind==='DEX'&&b.pool===s.pool)continue;
      const bid=observed.get(s.id).sell;
      if(!(bid>ask&&(bid/ask-1)>=Math.max(.05,floor/budget))||gaps.has(spotRouteId(b.id,s.id,match)))continue;
      if(isUniswapV4(b)||isUniswapV4(s)||b.venue==='gate'||s.venue==='gate'||b.wide||s.wide){
        if(b.tradeEnabled===false||s.tradeEnabled===false)continue;
        const blocked=transferStatus(b,match)?.withdraw===false?'매수처 출금 중단':
          transferStatus(s,match)?.deposit===false?'매도처 입금 중단':null;
        record(b,s,ask,bid,match,blocked,'관측 가격 차이 · 금액별 체결 미검증');
        continue;
      }
      const blocked=blockedReason(b,s);
      if(blocked)record(b,s,ask,bid,match,blocked);
    }
  }
  return {samples,gaps:[...gaps.values()],marketIds:[...marketIds]};
}

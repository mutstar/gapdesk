import {atomic, CHAINS, NATIVE} from './assets.js';
import {MAX_AGE} from './market.mjs';

const probe = '0x0000000000000000000000000000000000000001';
const addressPattern = /^0x[0-9a-f]{40}$/i;
const unitsPattern = /^[1-9]\d{0,77}$/;
const supported = chain => Number.isInteger(chain) && Object.hasOwn(CHAINS, chain);
const decimalsOK = n => Number.isInteger(n) && n >= 0 && n <= 36;
const sameAddress = (a,b) => typeof a === 'string' && a.toLowerCase() === b;
const amountUSD = n => n != null && n !== '' && Number.isFinite(Number(n)) && Number(n) >= 0 ? Number(n) : null;
const noRoute = 'unavailable', unknown = 'unknown';
const transientToolErrors = new Set(['TOOL_TIMEOUT','UNKNOWN_ERROR','RPC_ERROR','RATE_LIMIT_EXCEEDED','TOOL_SPECIFIC_ERROR']);
const relayNoRoute = new Set(['NO_QUOTES','UNSUPPORTED_CURRENCY','UNSUPPORTED_CHAIN','CHAIN_DISABLED','UNSUPPORTED_ROUTE','INSUFFICIENT_LIQUIDITY','AMOUNT_TOO_LOW','AMOUNT_TOO_HIGH','SWAP_IMPACT_TOO_HIGH']);
const backoffs = new Map();

function displayAmount(units, decimals) {
  const digits = units.padStart(decimals+1,'0');
  if (!decimals) return digits;
  const fraction = digits.slice(-decimals).replace(/0+$/,'');
  return digits.slice(0,-decimals)+(fraction?'.'+fraction:'');
}

function bridgeNames(step) {
  const nested = (step.includedSteps || []).flatMap(bridgeNames);
  if (nested.length) return [...new Set(nested)];
  if (!step.action || step.action.fromChainId === step.action.toChainId) return [];
  const title = step.toolDetails?.name || step.tool;
  return typeof title === 'string' && title.trim().length > 0 && title.length <= 100 && !/^(?:li\.?fi|custom|composite)$/i.test(title.trim()) ? [title.trim()] : [];
}

async function lifi(p, fetcher) {
  const params=new URLSearchParams({fromChain:String(p.from),toChain:String(p.to),fromToken:p.input,toToken:p.output,
    fromAmount:p.units,fromAddress:p.wallet,toAddress:p.wallet,slippage:'0.003',integrator:'gapdesk'});
  const r=await fetcher('https://li.quest/v1/quote?'+params);
  const j=await r.json();
  if (!r.ok) {
    const temporary = j.errors?.failed?.some(f=>Object.values(f.subpaths||{}).flat().some(e=>transientToolErrors.has(e.code)));
    return {status:r.status===404 && j.code===1002 && !temporary ? noRoute : unknown};
  }
  const a=j.action, e=j.estimate, tx=j.transactionRequest;
  if (!a || !e || !tx || a.fromChainId!==p.from || a.toChainId!==p.to ||
      !sameAddress(a.fromToken?.address,p.input) || !sameAddress(a.toToken?.address,p.output) ||
      !sameAddress(a.fromAddress,p.wallet) || !sameAddress(a.toAddress,p.wallet) || a.fromAmount!==p.units ||
      Number(tx.chainId)!==p.from || !addressPattern.test(tx.to) || !/^0x[0-9a-f]{8,}$/i.test(tx.data) ||
      !decimalsOK(a.fromToken.decimals) || !decimalsOK(a.toToken.decimals)) return {status:unknown};
  const names=bridgeNames(j), gas=e.gasCosts?.map(g=>amountUSD(g.amountUSD));
  if (p.from!==p.to && !names.length) return {status:unknown};
  return {status:'available',provider:names.join(' + '),min:e.toAmountMin,expected:e.toAmount,
    fromDecimals:a.fromToken.decimals,toDecimals:a.toToken.decimals,duration:amountUSD(e.executionDuration),
    gasUSD:gas?.length && gas.every(v=>v!==null) ? gas.reduce((n,g)=>n+g,0):null};
}

async function relay(p, fetcher) {
  const r=await fetcher('https://api.relay.link/quote/v2',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({user:p.wallet,recipient:p.wallet,originChainId:p.from,destinationChainId:p.to,
      originCurrency:p.input,destinationCurrency:p.output,amount:p.units,tradeType:'EXACT_INPUT',slippageTolerance:'30'})});
  const j=await r.json();
  if (!r.ok) return {status:r.status===400 && relayNoRoute.has(j.errorCode) ? noRoute : unknown};
  const d=j.details,input=d?.currencyIn,output=d?.currencyOut;
  const hasDeposit=j.steps?.some(s=>s.id==='deposit' && s.kind==='transaction' && s.items?.some(({data})=>
    data && Number(data.chainId)===p.from && sameAddress(data.from,p.wallet) && addressPattern.test(data.to) && /^0x[\da-f]*$/i.test(data.data)));
  if (!hasDeposit || !sameAddress(d?.sender,p.wallet) || !sameAddress(d.recipient,p.wallet) || input?.amount!==p.units ||
      input.currency?.chainId!==p.from || output?.currency?.chainId!==p.to || !sameAddress(input.currency.address,p.input) ||
      !sameAddress(output.currency.address,p.output) || !decimalsOK(input.currency.decimals) || !decimalsOK(output.currency.decimals)) return {status:unknown};
  const deadline=Number(j.protocol?.v2?.orderData?.output?.deadline);
  return {status:'available',provider:'Relay',min:output.minimumAmount,expected:output.amount,fromDecimals:input.currency.decimals,
    expires:Number.isFinite(deadline) && deadline>0 ? deadline*1000 : undefined,
    toDecimals:output.currency.decimals,duration:amountUSD(d.timeEstimate),gasUSD:amountUSD(j.fees?.gas?.amountUsd)};
}

async function requestLeg(params, io) {
  const errors=[];
  for (const provider of [lifi,relay]) {
    if ((io.cooldowns.get(provider)||0)>io.now()) { errors.push(unknown); continue; }
    const started=io.now();
    try {
      let at=started;
      const result=await provider(params,async(url,options={})=>{
        const r=await io.fetch(url,{...options,signal:AbortSignal.timeout(6500),cache:'no-store'});
        const date=Date.parse(r.headers.get('date')||''), age=Number(r.headers.get('age')||0);
        at=Math.min(started,Number.isFinite(date)?date:started,io.now()-(Number.isFinite(age)?Math.max(age,0)*1000:0));
        if (r.status===429) {
          const retry=r.headers.get('retry-after');
          const until=retry && /^\d+$/.test(retry)?io.now()+Number(retry)*1000:Date.parse(retry||'');
          io.cooldowns.set(provider,Number.isFinite(until)?until:io.now()+60000);
        }
        return r;
      });
      const expires=Math.min(at+MAX_AGE,result.expires??Infinity);
      if (result.status==='available' && typeof result.min==='string' && unitsPattern.test(result.min) &&
          typeof result.expected==='string' && unitsPattern.test(result.expected) && BigInt(result.min)<=BigInt(result.expected) &&
          expires>io.now()) return {...result,at,expires};
      errors.push(result.status===noRoute?noRoute:unknown);
    } catch { errors.push(unknown); }
  }
  return {status:errors.includes(unknown)?unknown:noRoute};
}

// Only normalized display data leaves this module. The probe requests a quote without signing or submitting it.
export async function lookupBridge({from,to,fromToken,toToken,budget,address}, options={}) {
  if (!supported(from)||!supported(to)||from===to||!addressPattern.test(fromToken)||!addressPattern.test(toToken)||
      !Number.isFinite(budget)||budget<10||budget>100000||address && (!addressPattern.test(address)||address.toLowerCase()===NATIVE))
    throw new RangeError('브리지 입력값을 확인해주세요.');
  const io={fetch:fetch,now:Date.now,cooldowns:backoffs,...options}, wallet=address?.toLowerCase()||probe;
  const src=CHAINS[from], input=fromToken.toLowerCase(), output=toToken.toLowerCase();
  let units=atomic(budget,src.decimals), decimals=src.decimals, started=io.now(), buyExpires=Infinity;
  if (input!==src.usdc) {
    const buy=await requestLeg({from,to:from,input:src.usdc,output:input,wallet,units},io);
    if (buy.status!=='available') return {status:buy.status,reason:buy.status===noRoute?'설정 금액으로 출발 토큰 매수 견적이 없어요.':'출발 토큰 매수 견적을 확인할 수 없어요.'};
    if (buy.fromDecimals!==src.decimals) return {status:unknown,reason:'출발 토큰의 단위를 확인할 수 없어요.'};
    units=buy.min; decimals=buy.toDecimals; started=buy.at; buyExpires=buy.expires;
  }
  const result=await requestLeg({from,to,input,output,wallet,units},io);
  if (result.status!=='available') return {status:result.status,reason:result.status===noRoute?'이 방향과 금액에 맞는 브리지 견적이 없어요.':'브리지 견적을 확인할 수 없어요. 잠시 후 다시 조회해주세요.'};
  const at=Math.min(started,result.at), expires=Math.min(at+MAX_AGE,buyExpires,result.expires);
  if (expires<=io.now() || decimals!==result.fromDecimals || (output===CHAINS[to].usdc && result.toDecimals!==CHAINS[to].decimals))
    return {status:unknown,reason:'브리지 견적을 다시 확인해주세요.'};
  return {status:'available',provider:result.provider,from,to,fromToken:input,toToken:output,sendAmount:displayAmount(units,decimals),
    minReceive:displayAmount(result.min,result.toDecimals),duration:result.duration,gasUSD:result.gasUSD,at,expires};
}

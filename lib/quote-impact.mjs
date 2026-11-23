import {CHAINS,NATIVE} from './assets.js';

const address = /^0x[0-9a-f]{40}$/i;
const poolId = /^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const units = /^[1-9]\d{0,77}$/;
const lower = s => typeof s === 'string' ? s.toLowerCase() : '';
const validDecimals = n => Number.isInteger(n) && n >= 0 && n <= 36;
const sameToken = (a,b) => a?.chainId === b?.chainId && address.test(a?.address) && lower(a.address) === lower(b?.address);

// LI.FI's EstimateHop.pool is optional. A router or approval address does not identify a pool.
export function quotedPool(step) {
  const action=step?.action;
  if (!action || action.fromChainId!==action.toChainId || !Array.isArray(step.includedSteps) || step.includedSteps.length!==1) return null;
  const [swap]=step.includedSteps;
  if (swap?.type!=='swap' || !Array.isArray(swap.estimate?.hops) || swap.estimate.hops.length!==1) return null;
  const [hop]=swap.estimate.hops;
  if (!poolId.test(hop?.pool) || /^0x0+$/i.test(hop.pool) || !units.test(hop.fromAmount) ||
      hop.fromAmount!==action.fromAmount || hop.toAmount!==swap.estimate.toAmount ||
      !units.test(hop.toAmount) || !sameToken(hop.fromToken,action.fromToken) || !sameToken(hop.toToken,action.toToken) ||
      hop.fromToken.chainId!==action.fromChainId || hop.toToken.chainId!==action.toChainId) return null;
  return lower(hop.pool);
}

// Compare an exact router quote to the observed pool's independent marginal price in USDC.
// Fees and requested slippage tolerance are already included in the router's minimum output.
export function quoteImpact({market,side,inputUnits,quote,maxImpactPct=1,now=Date.now(),onImpactExceeded}) {
  if (market?.kind!=='DEX' || !market.pool || !quote || !['buy','sell'].includes(side) ||
      !Number.isFinite(maxImpactPct) || maxImpactPct<0 || maxImpactPct>=100) return null;
  const fresh=t=>Number.isFinite(t) && t<=now+5000 && t>now-45000;
  const chain=CHAINS[market.chain], buy=side==='buy';
  if (!chain || !fresh(market.time) || !fresh(quote.at) ||
      quote.fromChain!==market.chain || quote.toChain!==market.chain || !address.test(market.token) ||
      lower(quote.fromToken)!==(buy?chain.usdc:lower(market.token)) || lower(quote.toToken)!==(buy?lower(market.token):chain.usdc) ||
      typeof inputUnits!=='string' || !units.test(inputUnits) || inputUnits!==quote.inputUnits ||
      typeof quote.minimum!=='string' || !units.test(quote.minimum)) return null;
  if (!validDecimals(market.decimals) || quote.fromDecimals!==(buy?chain.decimals:market.decimals) ||
      quote.toDecimals!==(buy?market.decimals:chain.decimals)) return null;
  const poolMatched=quote.pool!=null && poolId.test(quote.pool) && lower(quote.pool)===lower(market.pool);
  if (quote.pool!=null && !poolMatched) return null;
  const input=Number(inputUnits)/10**quote.fromDecimals, output=Number(quote.minimum)/10**quote.toDecimals;
  const effectivePrice=buy?input/output:output/input;
  const spotPrice=buy?(market.spotAsk??market.ask):(market.spotBid??market.bid);
  if (!Number.isFinite(spotPrice) || spotPrice<=0 || !Number.isFinite(effectivePrice) || effectivePrice<=0) return null;
  const ratio=effectivePrice/spotPrice;
  const impactPct=Math.max(0,100*(buy?ratio-1:1-ratio));
  if (!Number.isFinite(impactPct)) return null;
  if (impactPct>maxImpactPct+1e-10) {onImpactExceeded?.(impactPct);return null;}
  return {effectivePrice,spotPrice,impactPct,poolMatched};
}

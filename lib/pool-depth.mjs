// Amount-sensitive local AMM estimates. Routes settle in actual chain USDC.
import { CHAINS, atomic } from './assets.js';

const Q96 = 1n << 96n, Q128 = 1n << 128n, UINT256 = (1n << 256n) - 1n;
const PPM = 1000000n;
const ceil = (n,d) => (n+d-1n)/d;
const positive = n => Number.isFinite(n) && n>0;
const validTime = (t,now) => Number.isFinite(t) && now-t>=-5000 && now-t<45000;
const addresses = {
  1:['0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f','0x1f98431c8ad98523631ae4a59f267346ea31f984'],
  56:['0x8909dc15e40173ff4699343b6eb8132c65e18ec6','0xdb1d10011ad0ff90774d0c6bb92e5c5c8b4461f7'],
  8453:['0x8909dc15e40173ff4699343b6eb8132c65e18ec6','0x33128a8fc17869897dce68ed026d694621f6fdfd'],
  42161:['0xf1d7cc64fb4452f05c498126312ebe29f30fbcf9','0x1f98431c8ad98523631ae4a59f267346ea31f984'],
};
export function depthFactory(chain,dexId,protocol) {
  if (!addresses[chain] || !['v2','v3'].includes(protocol)) return null;
  const dex=String(dexId).toLowerCase().replace(/[-_]?v[23]$/,'');
  const index=protocol==='v2'?0:1;
  if (dex==='uniswap') return addresses[chain][index];
  if (dex==='pancakeswap' && Number(chain)===56) return ['0xca143ce32fe78f1f7019d7d551a6402fc5350c73','0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865'][index];
  return null;
}

// round(2^128 * 1.0001^(-2^i/2)), the protocol's integer tick conversion table.
const tickFactors = [
  0xfffcb933bd6fad37aa2d162d1a594001n,0xfff97272373d413259a46990580e213an,0xfff2e50f5f656932ef12357cf3c7fdccn,0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n,0xff973b41fa98c081472e6896dfb254c0n,0xff2ea16466c96a3843ec78b326b52861n,0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n,0xf987a7253ac413176f2b074cf7815e54n,0xf3392b0822b70005940c7a398e4b70f3n,0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n,0xa9f746462d870fdf8a65dc1f90e061e5n,0x70d869a156d2a1b890bb3df62baf32f7n,0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n,0x5d6af8dedb81196699c329225ee604n,0x2216e584f5fa1ea926041bedfe98n,0x48a170391f7dc42444e8fa2n,
];
function tickSqrt(tick) {
  let magnitude=Math.abs(tick), ratio=Q128;
  for (let i=0;magnitude;i++,magnitude>>=1) if (magnitude&1) ratio=ratio*tickFactors[i]>>128n;
  if (tick>0) ratio=UINT256/ratio;
  return ceil(ratio,1n<<32n);
}

const parsed = new WeakMap();
function decode(pool) {
  if (parsed.has(pool)) return parsed.get(pool);
  let state=null;
  // A V2 fee is a property of the official deployment, not of the DEX label alone.
  if (!depthFactory(pool.chain,pool.dexId,pool.protocol) || !Number.isInteger(pool.feePpm) ||
      pool.feePpm<0 || pool.feePpm>=1e6 || ![pool.decimals0,pool.decimals1].every(d=>Number.isInteger(d)&&d>=0&&d<=36)) return null;
  const fee=BigInt(pool.feePpm);
  if (pool.protocol==='v2') {
    const required=String(pool.dexId).toLowerCase().startsWith('uniswap')?3000:2500;
    if (pool.feePpm!==required) return null;
    const x=BigInt(pool.reserve0),y=BigInt(pool.reserve1);
    if (x>0n && x<1n<<112n && y>0n && y<1n<<112n)
      state={fee,x,y,ratio:Number(y)/Number(x)};
  } else {
    const {tick,tickSpacing}=pool, sqrt=BigInt(pool.sqrtPriceX96), liq=BigInt(pool.liquidity);
    if (!Number.isInteger(tick)||Math.abs(tick)>887272||!Number.isInteger(tickSpacing)||tickSpacing<1||tickSpacing>16384||liq<=0n||liq>=1n<<128n) return null;
    // A tick on the left side of a crossing may legally sit at its upper sqrt boundary.
    const compressed=Math.floor(tick/tickSpacing),wordIndex=Math.floor(compressed/256);
    let left=compressed,right=compressed+1;
    if (pool.wordIndex===wordIndex && /^0x[0-9a-f]{64}$/i.test(pool.bitmap)) {
      // Never cross an unknown word or an initialized tick. Uninitialized word edges
      // can themselves end a swap step, so preserve their protocol rounding boundaries.
      const first=wordIndex*256,position=BigInt(compressed-first),bits=BigInt(pool.bitmap);
      const lowerBits=bits & ((1n<<(position+1n))-1n);
      const upperBits=bits & ~((1n<<(position+1n))-1n);
      left=lowerBits ? first+lowerBits.toString(2).length-1 : first;
      right=upperBits ? first+(upperBits&-upperBits).toString(2).length-1 : Math.max(right,first+255);
    }
    const low=tickSqrt(Math.max(-887272,left*tickSpacing)),high=tickSqrt(Math.min(887272,right*tickSpacing));
    if (sqrt>=low && sqrt<=high && sqrt>=tickSqrt(tick) && sqrt<=tickSqrt(Math.min(887272,tick+1)))
      state={fee,sqrt,liq,low,high,ratio:(Number(sqrt)/Number(Q96))**2};
  }
  parsed.set(pool,state);
  return state;
}

function swap(pool,into,amount) {
  const state=decode(pool);
  if (!state || amount<=0n || amount>UINT256 || (into!==pool.token0 && into!==pool.token1)) return null;
  const forward=into===pool.token0;
  let out;
  if (pool.protocol==='v2') {
    const inputReserve=forward?state.x:state.y,outputReserve=forward?state.y:state.x;
    // V2 balances after the transfer must fit the pool's uint112 reserves.
    if (amount+inputReserve >= 1n<<112n) return null;
    const adjusted=amount*(PPM-state.fee);
    out=adjusted*outputReserve/(inputReserve*PPM+adjusted);
  } else {
    const {sqrt,liq,low,high}=state, net=amount*(PPM-state.fee)/PPM, scaledL=liq*Q96;
    if (net===0n || amount>=1n<<255n) return null;
    let next;
    if (forward) {
      const product=net*sqrt;
      next=product+scaledL<=UINT256?ceil(scaledL*sqrt,scaledL+product):ceil(scaledL,scaledL/sqrt+net);
      // A possibly initialized tick at the boundary can change active liquidity.
      if (next<=low) return null;
      out=liq*(sqrt-next)/Q96;
    } else {
      next=sqrt+net*Q96/liq;
      if (next>=high) return null;
      out=scaledL*(next-sqrt)/next/sqrt;
    }
  }
  return out>0n?{out,token:forward?pool.token1:pool.token0,decimals:forward?pool.decimals1:pool.decimals0,
    ratio:forward?state.ratio:1/state.ratio}:null;
}

// Every hop must be a real pool from the same block. Catalog/bid/ask marks cannot supply a conversion hop.
export function poolFill(market,side,input,maxImpactPct=1) {
  const now=Date.now(), pool=market?.depth, chain=Number(market?.chain), settlement=CHAINS[chain]?.usdc;
  if (!pool || !settlement || pool.chain!==chain || pool.pool!==market.pool || pool.block!==market.block ||
      !Number.isSafeInteger(pool.block) || pool.block<=0 || pool.time!==market.blockTime || !validTime(pool.time,now) ||
      !validTime(market.time,now) || (side!=='buy' && side!=='sell') || !positive(input) ||
      !Number.isFinite(maxImpactPct) || maxImpactPct<0 || maxImpactPct>100) return null;
  const token=market.token,other=pool.token0===token?pool.token1:pool.token1===token?pool.token0:null;
  if (!other || token===settlement) return null;
  const tokenDecimals=pool.token0===token?pool.decimals0:pool.decimals1;
  const stableDecimals=CHAINS[chain].decimals,buy=side==='buy';
  const inputDecimals=buy?stableDecimals:tokenDecimals,outputDecimals=buy?tokenDecimals:stableDecimals;
  const bridges=other===settlement?[null]:(market.depthBridges??[]);
  let best=null;
  try {
    const budget=BigInt(atomic(input,inputDecimals));
    for (const bridge of bridges) {
      if (bridge && (bridge.chain!==chain || bridge.block!==pool.block || bridge.time!==pool.time || bridge.pool===pool.pool ||
          ![bridge.token0,bridge.token1].includes(settlement) || ![bridge.token0,bridge.token1].includes(other))) continue;
      const path=bridge?(buy?[bridge,pool]:[pool,bridge]):[pool];
      let into=buy?settlement:token,amount=budget,ratio=1,units=inputDecimals;
      for (const hop of path) {
        if ((into===hop.token0?hop.decimals0:hop.decimals1)!==units) { amount=0n;break; }
        const result=swap(hop,into,amount);
        if (!result) { amount=0n;break; }
        amount=result.out;into=result.token;ratio*=result.ratio;units=result.decimals;
      }
      if (!amount || units!==outputDecimals || into!==(buy?token:settlement)) continue;
      const output=Number(amount)/10**outputDecimals,idealRate=ratio*10**(inputDecimals-outputDecimals);
      const spotPrice=buy?1/idealRate:idealRate, effectivePrice=buy?input/output:output/input;
      const impactPct=Math.max(0,100*(buy?effectivePrice/spotPrice-1:1-effectivePrice/spotPrice));
      if (!positive(output)||!positive(spotPrice)||!positive(effectivePrice)||!Number.isFinite(impactPct)||impactPct>maxImpactPct) continue;
      if (!best || output>best.output) best={output,effectivePrice,spotPrice,impactPct,method:path.map(p=>p.protocol).join('+'),
        pools:path.map(p=>p.pool),block:pool.block,time:pool.time,evidence:path.map(({chain,pool,token0,token1,dexId,protocol,feePpm})=>
          ({chain,pool,token0,token1,dexId,protocol,feePpm}))};
    }
  } catch { return null; }
  return best;
}

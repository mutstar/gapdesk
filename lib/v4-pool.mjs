export function isUniswapV4(market){
  return /^(uniswap|uniswap[-_]?v4)$/i.test(market.dexId||'')&&/^0x[0-9a-f]{64}$/i.test(market.pool||'');
}
export function poolVenueName(dexId,pool,chainName){
  return (isUniswapV4({dexId,pool})?'Uniswap V4':dexId)+' · '+chainName;
}

import {CHAINS,NATIVE} from './assets.js';

// Canonical quote assets in priority order. Symbols alone cannot identify an anchor.
export const quoteAssets = {
  1: ['0xdac17f958d2ee523a2206206994597c13d831ec7','0x6b175474e89094c44da98b954eedeac495271d0f','0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'],
  56: ['0x55d398326f99059ff775485246999027b3197955','0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'],
  8453: ['0x4200000000000000000000000000000000000006'],
  42161: ['0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9','0xff970a61a04b1ca14834a43f5de4533ebddb5cc8','0x82af49447d8a07e3bd95bd0d56f35241523fbab1'],
};

// A pool measures a token ratio. Revaluing its settlement side through the
// outside price of a speculative token fabricates a USD price for that side.
export function comparablePoolSide(chain,token,counter){
  const anchors=quoteAssets[chain];
  if(!anchors)return true;
  const known=t=>t===CHAINS[chain].usdc||t===NATIVE||anchors.includes(t);
  return !known(token)||known(counter);
}

export function reportedEmptyPool(value){
  return (typeof value==='number'||typeof value==='string'&&value.trim()!=='')&&Number(value)===0;
}

const wrapped = {
  1:'0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  56:'0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  8453:'0x4200000000000000000000000000000000000006',
  42161:'0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
};
// The USDC-denominated CEX book can value the quote leg while the token directory is cached.
export function poolValuationAssets(assets,cex) {
  const marks = new Map();
  const put = (id,m) => {
    const old = marks.get(id);
    if (!old || (m.quote==='USDC' && old.quote!=='USDC') ||
        (m.quote===old.quote && old.time<m.time)) marks.set(id,m);
  };
  for (const m of cex) {
    if (!m.quoteReady || !m.tradeEnabled || m.ask<=0 || m.bid<=0 || Date.now()-m.time>=45000) continue;
    for (const n of m.networks) {
      if (!CHAINS[n.chain]) continue;
      put(n.chain+':'+n.token,m);
      if (n.token===NATIVE && m.symbol===CHAINS[n.chain].gas) put(n.chain+':'+wrapped[n.chain],m);
    }
  }
  return assets.map(a => {
    const book=marks.get(a.chain+':'+a.token);
    return book ? {...a,ask:book.ask,bid:book.bid,time:book.time} : a;
  });
}

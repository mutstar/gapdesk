import {CHAINS,NATIVE} from './assets.js';

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

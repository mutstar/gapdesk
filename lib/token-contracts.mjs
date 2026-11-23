import {CHAINS,NATIVE} from './assets.js';

const chainNames={10:'Optimism',137:'Polygon',43114:'Avalanche',solana:'Solana',tron:'Tron',bitcoin:'Bitcoin',xrpl:'XRP Ledger',ltc:'Litecoin',dogecoin:'Dogecoin','bitcoin-cash':'Bitcoin Cash',cardano:'Cardano'};
export const chainTitle=chain=>CHAINS[chain]?.name||chainNames[chain]||String(chain);
export const contractKey=c=>c.chain+':'+c.token;
export const shortCA=token=>token===NATIVE?'네이티브':token.slice(0,6)+'…'+token.slice(-4);
export function bridgeDestinations(source,contracts){
  if(!source||source.group==null||!CHAINS[source.chain])return [];
  return contracts.filter(c=>CHAINS[c.chain]&&c.chain!==source.chain&&c.group===source.group);
}

import {CHAINS,NATIVE} from './assets.js';

const chainNames={1030:'Conflux',88888:'Chiliz',80094:'Berachain',146:'Sonic',59144:'Linea',534352:'Scroll',324:'ZKsync',1329:'Sei',8217:'Kaia',999:'HyperEVM',2020:'Ronin',14:'Flare',81457:'Blast',50:'XDC',5000:'Mantle',42220:'Celo',25:'Cronos',143:'Monad',130:'Unichain',57073:'Ink',295:'Hedera',4663:'Robinhood',5042:'Arc',sui:'Sui',aptos:'Aptos',multiversx:'MultiversX',hypercore:'HyperCore',near:'NEAR',ton:'TON',hydration:'Hydration',stellar:'Stellar',osmosis:'Osmosis',algorand:'Algorand',neutron:'Neutron',starknet:'Starknet',10:'Optimism',137:'Polygon',43114:'Avalanche',solana:'Solana',tron:'Tron',bitcoin:'Bitcoin',xrpl:'XRP Ledger',ltc:'Litecoin',dogecoin:'Dogecoin','bitcoin-cash':'Bitcoin Cash',cardano:'Cardano'};
export const chainTitle=chain=>CHAINS[chain]?.name||chainNames[chain]||String(chain);
export const contractKey=c=>c.chain+':'+c.token;
export const shortCA=token=>token===NATIVE?'네이티브':token.slice(0,6)+'…'+token.slice(-4);
export function bridgeDestinations(source,contracts){
  if(!source||source.group==null||!CHAINS[source.chain])return [];
  return contracts.filter(c=>CHAINS[c.chain]&&c.chain!==source.chain&&c.group===source.group);
}

import {createHash} from 'node:crypto';

// Chain-identified public full-node endpoints for EVM logs outside the archive feeds.
export const chainLogRpcs=[
  ['seiv2',1329,'https://evm-rpc.sei-apis.com'],['kaia',8217,'https://public-en.node.kaia.io'],
  ['ronin',2020,'https://api.roninchain.com/rpc'],['cronos',25,'https://evm.cronos.org'],
  ['conflux',1030,'https://evm.confluxrpc.com'],['chiliz',88888,'https://rpc.ankr.com/chiliz'],
  ['xdc',50,'https://rpc.xinfin.network'],['hedera',295,'https://mainnet.hashio.io/api'],
  ['tron',728126428,'https://api.trongrid.io/jsonrpc'],['blast',81457,'https://blast.api.pocket.network'],
].map(([chain,id,rpc])=>({chain,id,rpc,wholeChain:true,confirmations:3}));

const alternatives={
  xdc:['https://rpc1.xinfin.network','https://rpc.ankr.com/xdc'],
  blast:['https://lb.routeme.sh/rpc/evm/81457'],
  tron:['https://api.trongrid.io/jsonrpc'],
};
export function rpcAddresses(network){
  return [...new Set([process.env['GAPDESK_RPC_'+network.chain.toUpperCase()],network.rpc,...(alternatives[network.chain]??[])].filter(Boolean))];
}

export function tronAddress(hex){
  if(!/^0x[0-9a-f]{40}$/.test(hex))return hex;
  const body=Buffer.from('41'+hex.slice(2),'hex');
  const checksum=createHash('sha256').update(createHash('sha256').update(body).digest()).digest().subarray(0,4);
  let n=BigInt('0x'+Buffer.concat([body,checksum]).toString('hex')),result='';
  const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  while(n){result=alphabet[Number(n%58n)]+result;n/=58n}
  return result;
}

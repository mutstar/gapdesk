export const NATIVE='0x0000000000000000000000000000000000000000';
export const DIAMOND='0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae';
export const CHAINS={
  1:{name:'Ethereum',gas:'ETH',usdc:'0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',decimals:6,rpc:'https://ethereum-rpc.publicnode.com',explorer:'https://etherscan.io'},
  56:{name:'BNB Chain',gas:'BNB',usdc:'0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',decimals:18,rpc:'https://bsc-rpc.publicnode.com',explorer:'https://bscscan.com'},
  8453:{name:'Base',gas:'ETH',usdc:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',decimals:6,rpc:'https://mainnet.base.org',explorer:'https://basescan.org'},
  42161:{name:'Arbitrum',gas:'ETH',usdc:'0xaf88d065e77c8cc2239327c5edb3a432268e5831',decimals:6,rpc:'https://arb1.arbitrum.io/rpc',explorer:'https://arbiscan.io'}
};
export function atomic(n,decimals){
  if(!Number.isFinite(n)||n<=0||!Number.isInteger(decimals)||decimals<0||decimals>36)throw Error('토큰 단위를 확인할 수 없습니다.');
  const [mantissa,exponent]=n.toExponential().split('e');
  const digits=mantissa.replace('.',''),places=Number(exponent)+decimals+1-digits.length;
  return String(places>=0?BigInt(digits)*10n**BigInt(places):BigInt(digits)/10n**BigInt(-places));
}
export function chainLabel(chain){return CHAINS[chain]?.name||String(chain)}

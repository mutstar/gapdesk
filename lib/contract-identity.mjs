// Identity for a price comparison is a network AND an issued token address.
const base58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function solanaMint(s){
  if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s))return false;
  let n=0n;
  for(const ch of s)n=n*58n+BigInt(base58.indexOf(ch));
  const leading=s.match(/^1*/)[0].length;
  return n>0n&&leading+Math.ceil(n.toString(16).length/2)===32;
}
export function strictContractKey(c){
  if(!c||typeof c.token!=='string')return null;
  const chain=String(c.chain),token=c.token;
  if(/^[1-9]\d*$/.test(chain)&&Number.isSafeInteger(Number(chain))&&/^0x[0-9a-fA-F]{40}$/.test(token)){
    const ca=token.toLowerCase();
    return /^0x(?:0{40}|e{40})$/.test(ca)?null:chain+':'+ca;
  }
  if(chain==='solana'&&solanaMint(token)||chain==='tron'&&/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(token))return chain+':'+token;
  return null;
}
export function marketContracts(m){
  const out=new Map();
  for(const n of m.kind==='DEX'?[m]:m.networks||[]){
    const key=strictContractKey(n);
    if(key&&!out.has(key))out.set(key,{chain:/^\d+$/.test(String(n.chain))?Number(n.chain):n.chain,token:key.slice(key.indexOf(':')+1)});
  }
  return [...out.values()];
}

export function spotRouteId(buyId,sellId,match){
  const key=strictContractKey(match);
  return key?buyId+'|'+sellId+'~ca='+key:null;
}

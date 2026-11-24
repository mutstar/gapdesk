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
  // Move type names and issuer-qualified denoms are case-sensitive.
  if(chain==='sui'||chain==='aptos'){
    const move=/^0x([0-9a-fA-F]{1,64})(::[A-Za-z_][A-Za-z_0-9]*::[A-Za-z_][A-Za-z_0-9]*)?$/.exec(token);
    if(move && (move[2]||chain==='aptos') && BigInt('0x'+move[1])>0n)
      return chain+':0x'+BigInt('0x'+move[1]).toString(16)+(move[2]||'');
  }
  if(chain==='starknet'&&/^0x[0-9a-fA-F]{1,64}$/.test(token)&&BigInt(token)>0n)
    return chain+':0x'+BigInt(token).toString(16);
  const pattern=issuedTokenFormats[chain];
  if(pattern instanceof RegExp && pattern.test(token))return chain+':'+token;
  return null;
}

const issuedTokenFormats={
  near:/^(?:[a-z0-9_-]+\.)+near$|^[0-9a-f]{64}$/,
  algorand:/^[1-9]\d{0,19}$/, hydration:/^\d{1,10}$/, hypercore:/^0x[0-9a-f]{32}$/,
  multiversx:/^[A-Z0-9]{3,10}-[a-f0-9]{6}$/, cardano:/^[a-f0-9]{56}(?:[a-f0-9]{2}){0,32}$/,
  ton:/^(?:EQ|UQ)[A-Za-z0-9_-]{46}$/, stellar:/^[a-zA-Z0-9]{1,12}:G[A-Z2-7]{55}$/,
  xrpl:/^(?:[A-Za-z0-9]{3}|[a-fA-F0-9]{40})\.r[1-9A-HJ-NP-Za-km-z]{24,34}$/,
  neutron:/^(?:untrn|ibc\/[A-F0-9]{64})$/, osmosis:/^(?:uosmo|ibc\/[A-F0-9]{64})$/,
};
export function marketContracts(m){
  const out=new Map();
  for(const n of m.kind==='DEX'?[m]:m.networks||[]){
    const key=strictContractKey(n);
    if(key&&!out.has(key))out.set(key,{chain:/^\d+$/.test(String(n.chain))?Number(n.chain):n.chain,token:key.slice(key.indexOf(':')+1)});
  }
  return [...out.values()];
}

// Only chain-specific exchange flags describe availability for this contract.
export function transferStatus(market,match){
  if(market?.kind!=='CEX')return undefined;
  const key=strictContractKey(match);
  const records=key?(market.networks||[]).filter(n=>strictContractKey(n)===key):[];
  function flag(field){
    const first=records[0]?.[field];
    return typeof first==='boolean'&&records.every(n=>n[field]===first)?first:null;
  }
  return {deposit:flag('depositOpen'),withdraw:flag('withdrawOpen'),at:market.networkTime||0};
}

export function spotRouteId(buyId,sellId,match){
  const key=strictContractKey(match);
  return key?buyId+'|'+sellId+'~ca='+key:null;
}

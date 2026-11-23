export const families=['전체','DEX–DEX','DEX–CEX','CEX–CEX'];

export function venueFamily(left,right){
  if(!['DEX','CEX','PERP'].includes(left)||!['DEX','CEX','PERP'].includes(right))return null;
  if(left==='DEX'&&right==='DEX')return 'DEX–DEX';
  if(left==='DEX'||right==='DEX')return 'DEX–CEX';
  return 'CEX–CEX';
}

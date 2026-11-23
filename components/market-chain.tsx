import {Layers} from 'lucide-react';
import {chainTitle} from '../lib/token-contracts.mjs';

type ChainId=number|string|null|undefined;

export function venueLabel(name:string|undefined,chain:ChainId){
  if(!name||!chain)return name;
  const suffix=' · '+chainTitle(chain);
  return name.endsWith(suffix)?name.slice(0,-suffix.length):name;
}

export function MarketChain({chain,kind,perp=false}:{chain?:ChainId,kind?:string,perp?:boolean}){
  const role=perp||kind==='PERP'?'기초자산':kind==='CEX'?'입출금 체인':'체인';
  const name=chain?chainTitle(chain):'미확인';
  return <span className="marketChain" title={role+' · '+name}>
    <Layers size={12} aria-hidden="true"/><span className="chainRole">{role}</span> {name}
  </span>;
}

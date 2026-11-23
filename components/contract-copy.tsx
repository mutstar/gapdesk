'use client';
import {useEffect,useRef,useState} from 'react';
import {Check,Copy} from 'lucide-react';
import {NATIVE} from '../lib/assets.js';
import {chainTitle,shortCA} from '../lib/token-contracts.mjs';

export type Contract={chain:number|string,token:string,group?:number,venues?:string[]};
export function ContractCopy({item}:{item:Contract}){
  const [state,setState]=useState(''),timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  useEffect(()=>()=>{if(timer.current)clearTimeout(timer.current)},[]);
  const name=chainTitle(item.chain);
  if(item.token===NATIVE)return <span className="nativeCA">{name} · 네이티브</span>;
  async function copy(){
    let manual=false;
    try{await navigator.clipboard.writeText(item.token);setState('copied')}
    catch{manual=true;setState('manual')}
    if(timer.current)clearTimeout(timer.current);
    timer.current=setTimeout(()=>setState(''),manual?15000:2200);
  }
  return <span className="caWrap"><button type="button" className="caCopy" onClick={copy} title={name+' · '+item.token}
    aria-label={name+' '+item.token+' CA 복사'}><span>{name}</span><code>{shortCA(item.token)}</code>{state==='copied'?<Check size={13}/>:<Copy size={13}/>}</button>
    {state==='copied'&&<small role="status">복사됨</small>}{state==='manual'&&<input aria-label="선택해서 복사할 주소" readOnly value={item.token} autoFocus onFocus={e=>e.target.select()}/>}</span>
}

'use client';
import {useEffect,useState} from 'react';

const choices={
  'gap-desc':'갭 높은 순',
  'gap-asc':'갭 낮은 순',
  'latest':'최근 관찰 순',
  'symbol':'토큰명 A–Z'
} as const;
export type MarketOrder=keyof typeof choices;
type Sortable={symbol?:string,asset?:string,displayKey?:string,gap?:number|null,time?:number};
const alphabet=new Intl.Collator('en',{sensitivity:'base'});
const isOrder=(value:string|null):value is MarketOrder=>value!=null&&Object.hasOwn(choices,value);

export function compareMarkets(order:MarketOrder){
  return (left:Sortable,right:Sortable)=>{
    if(order!=='symbol'){
      const value=(r:Sortable)=>order==='latest'&&Number.isFinite(r.gap)?r.time:order==='latest'?null:r.gap;
      const a=value(left),b=value(right);
      const pricedA=typeof a==='number'&&Number.isFinite(a)&&(order!=='latest'||a>0);
      const pricedB=typeof b==='number'&&Number.isFinite(b)&&(order!=='latest'||b>0);
      if(pricedA!==pricedB)return pricedA?-1:1;
      if(pricedA&&pricedB&&a!==b)return order==='gap-asc'?a-b:b-a;
    }
    const name=alphabet.compare(left.symbol||'',right.symbol||'');
    const a=left.displayKey??left.asset??'',b=right.displayKey??right.asset??'';
    return name||(a<b?-1:a>b?1:0);
  };
}

export function useMarketOrder(tab:'explorer'|'tokens'){
  const [order,setOrder]=useState<MarketOrder>('gap-desc');
  const key='gapdesk.market-order.'+tab;
  useEffect(()=>{
    try{
      const value=localStorage.getItem(key);
      if(isOrder(value))setOrder(value);
    }catch{}
  },[key]);
  function change(next:MarketOrder){
    setOrder(next);
    try{localStorage.setItem(key,next)}catch{}
  }
  return [order,change] as const;
}
export function MarketSort({value,onChange}:{value:MarketOrder,onChange:(order:MarketOrder)=>void}){
  return <label className="marketSort">정렬<select value={value} onChange={e=>{
    if(isOrder(e.target.value))onChange(e.target.value);
  }}>{Object.entries(choices).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>;
}

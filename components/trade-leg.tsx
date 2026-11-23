import type {ReactNode} from 'react';

type Props={
  side:'buy'|'sell';
  venue?:string;
  perp?:boolean;
  price?:number|null;
  caption?:string;
  children?:ReactNode;
};
const priceFormat=new Intl.NumberFormat('en-US',{maximumSignificantDigits:7});
export function TradeLeg({side,venue,perp,price,caption,children}:Props){
  const buy=side==='buy';
  const action=perp?(buy?'롱 진입':'숏 진입'):(buy?'사는 곳':'파는 곳');
  const hasPrice=typeof price==='number'&&Number.isFinite(price)&&price>0;
  return <div className={'tradeLeg '+side}>
    <div className="legAction">{action}</div>
    <strong className="legVenue">{venue||'거래소 미확인'}</strong>
    {price!==undefined&&<div className="legPrice">{hasPrice?<>{priceFormat.format(price)} <small>USDC</small></>:'시세 대기'}</div>}
    {caption&&<small className="legCaption">{caption}</small>}
    {children}
  </div>;
}

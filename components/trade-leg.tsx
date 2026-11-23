import {MarketChain,venueLabel} from './market-chain';
import type {ReactNode} from 'react';
import {isFreshQuoteAt} from '../lib/quote-freshness.mjs';

export type TransferStatus={deposit:boolean|null,withdraw:boolean|null,at:number};
type TransferProps={kind?:string,status?:TransferStatus|null,side:'buy'|'sell',now:number};
export function TransferBadges({kind,status,side,now}:TransferProps){
  if(kind!=='CEX')return null;
  const fresh=isFreshQuoteAt(status?.at,now);
  const directions:('deposit'|'withdraw')[]=side==='buy'?['withdraw','deposit']:['deposit','withdraw'];
  return <div className="transferBadges">{directions.map(direction=>{
    const value=fresh?status?.[direction]:null;
    const state=value===true?'open':value===false?'closed':'unknown';
    return <span key={direction} data-state={state}>{direction==='deposit'?'입금':'출금'} {state==='open'?'가능':state==='closed'?'중단':'미확인'}</span>;
  })}</div>;
}

type Props={
  side:'buy'|'sell';
  venue?:string;
  chain?:number|string|null;
  perp?:boolean;
  kind?:string;
  transfer?:TransferStatus|null;
  now?:number;
  price?:number|null;
  caption?:string;
  children?:ReactNode;
};
const priceFormat=new Intl.NumberFormat('en-US',{maximumSignificantDigits:7});
export function TradeLeg({side,venue,chain,perp,kind,transfer,now=0,price,caption,children}:Props){
  const buy=side==='buy';
  const action=perp?(buy?'롱 진입':'숏 진입'):(buy?'사는 곳':'파는 곳');
  const hasPrice=typeof price==='number'&&Number.isFinite(price)&&price>0;
  return <div className={'tradeLeg '+side}>
    <div className="legAction">{action}</div>
    <strong className="legVenue">{venueLabel(venue,chain)||'거래소 미확인'}</strong>
    <MarketChain chain={chain} kind={kind} perp={perp}/>
    {price!==undefined&&<div className="legPrice">{hasPrice?<>{priceFormat.format(price)} <small>USDC</small></>:'시세 대기'}</div>}
    {caption&&<small className="legCaption">{caption}</small>}
    <TransferBadges kind={kind} status={transfer} side={side} now={now}/>
    {children}
  </div>;
}

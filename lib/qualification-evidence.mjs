import {isFreshQuoteAt,QUOTE_MAX_AGE_MS} from './quote-freshness.mjs';

export const amountText=n=>Number(n).toLocaleString('ko-KR',{maximumSignificantDigits:6});
export class QuoteFailure extends Error{
  constructor(code,detail){
    super(detail);
    this.diagnosis={code,detail};
  }
}
export function refuse(code,detail){throw new QuoteFailure(code,detail)}
export function checkTime(at,label,now=Date.now()){
  if(isFreshQuoteAt(at,now))return;
  if(Number.isSafeInteger(at)&&at>0&&now-at>=QUOTE_MAX_AGE_MS){
    refuse('stale_quote',label+' 기준 시각으로부터 '+Math.floor((now-at)/1000)+'초 경과 · 유효 시간 '+QUOTE_MAX_AGE_MS/1000+'초');
  }
  refuse('unverified',label+'의 유효한 기준 시각을 확인할 수 없어요.');
}
export function diagnoseError(error,detail){
  return error instanceof QuoteFailure?error.diagnosis:{code:'unverified',detail};
}

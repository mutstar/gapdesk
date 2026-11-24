export const QUOTE_MAX_AGE_MS = 45_000;

export function isFreshQuoteAt(at, now = Date.now()) {
  return Number.isSafeInteger(at) && at > 0 && at <= now && now - at < QUOTE_MAX_AGE_MS;
}

export function matchesQualifiedSettings(row,budget,floor,maxImpact,now=Date.now()){
  return row?.budget===budget&&row.maxImpact===maxImpact&&Number.isFinite(row.profit)&&
    row.profit>0&&row.profit>=floor&&isFreshQualified(row,now);
}

export function isFreshQualified(row, now = Date.now()) {
  return isFreshQuoteAt(row?.buyQuoteAt, now) && isFreshQuoteAt(row?.sellQuoteAt, now) &&
    Number.isSafeInteger(row.expires) && row.expires > now;
}

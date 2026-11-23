export const QUOTE_MAX_AGE_MS = 45_000;

export function isFreshQuoteAt(at, now = Date.now()) {
  return Number.isSafeInteger(at) && at > 0 && at <= now && now - at < QUOTE_MAX_AGE_MS;
}

export function isFreshQualified(row, now = Date.now()) {
  return isFreshQuoteAt(row?.buyQuoteAt, now) && isFreshQuoteAt(row?.sellQuoteAt, now) &&
    Number.isSafeInteger(row.expires) && row.expires > now;
}

import {isFreshQuoteAt} from './quote-freshness.mjs';
import {chainTitle} from './token-contracts.mjs';

export const executionLabels = {
  ready: '바로 시작 가능',
  manual: '수동 출금 필요',
  unverified: '잔액 확인 필요',
};

export function routePath(from, to, bridge, duration) {
  if (!from || !to) return '체인 경로 미확인';
  if (String(from) === String(to)) return chainTitle(from) + ' · 동일 체인';
  const eta = duration > 0 && bridge ? ' · 약 ' + Math.ceil(duration / 60) + '분' : '';
  return chainTitle(from) + ' → ' + (bridge || '브릿지 미확인') + ' → ' + chainTitle(to) + eta;
}

// Called only after the selected notional, profit, depth and quote checks pass.
export function executionStatus(row, address, balances, now) {
  const cexBuy = row.buyKind === 'CEX';
  const cexSell = row.sellKind === 'CEX';
  const blocked = {group: 'blocked', detail: ''};
  if (![row.buyKind, row.sellKind].every(kind => kind === 'CEX' || kind === 'DEX')) return blocked;
  if (!row.from || !row.to || (String(row.from) !== String(row.to) && !row.bridge)) return blocked;
  if (cexBuy && !(row.buyTransfer?.withdraw === true && isFreshQuoteAt(row.buyTransfer.at, now))) return blocked;
  if (cexSell && !(row.sellTransfer?.deposit === true && isFreshQuoteAt(row.sellTransfer.at, now))) return blocked;
  if (cexBuy) return {group: 'manual', detail: row.buy + ' 잔액 미조회 · 매수 후 직접 출금'};
  const unknown = {group: 'unverified', detail: address ? '최신 지갑 잔액·가스비 확인 필요' : '지갑 연결 후 잔액 확인'};
  const source = balances[row.from], destination = balances[row.to];
  if (!address || !isFreshQuoteAt(source?.at, now) || !Number.isFinite(source.usdc)) return unknown;
  if (source.usdc < row.budget) return blocked;
  const sameChain = String(row.from) === String(row.to);
  const charges = [row.buyGas, row.bridgeGas, row.sellGas, row.approvalGas, row.depositGas];
  if (!charges.every(n => Number.isFinite(n) && n >= 0)) return unknown;
  // Older quotes aggregate approvals. Reserve that amount on each possible
  // paying chain for a bridge, and count it only once on a same-chain route.
  const sourceFees = row.buyGas + row.bridgeGas + row.approvalGas;
  const destFees = row.sellGas + row.depositGas;
  const legs = sameChain
    ? [[source, row.gasPriceFrom, sourceFees + destFees]]
    : [[source, row.gasPriceFrom, sourceFees], [destination, row.gasPriceTo, destFees + row.approvalGas]];
  for (const [balance, rate, fees] of legs) {
    if (!isFreshQuoteAt(balance?.at, now) || !Number.isFinite(balance.eth) || !(Number.isFinite(rate) && rate > 0)) return unknown;
    if (balance.eth < (fees * 1.1 + 0.02) / rate) return blocked;
  }
  return {group: 'ready', detail: cexSell ? '지갑 서명으로 시작 · 거래소 입금·매도 직접 진행' : '지갑 서명으로 시작'};
}

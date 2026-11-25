const ordinary = [2, 3].map(maximumFractionDigits =>
  new Intl.NumberFormat('ko-KR', {maximumFractionDigits}));
const superscripts = '⁰¹²³⁴⁵⁶⁷⁸⁹';

export function formatPercentValue(value, fractionDigits = 2) {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) <= 10000) return ordinary[fractionDigits === 3 ? 1 : 0].format(value);

  const [coefficient, exponent] = value.toExponential(2).split('e+');
  const power = [...exponent].map(digit => superscripts[Number(digit)]).join('');
  return Number(coefficient) + ' × 10' + power;
}

export const DEFAULT_IMPACT = 1;
export function validImpact(value){
  return Number.isFinite(value) && value >= 0.01 && value <= 99.99;
}

import {families} from '../lib/venue-family.mjs';

export const products:Record<string,string>={all:'전체',spot_spot:'현물–현물',perp_spot:'현물–선물',perp_perp:'선물–선물'};
function options(family:string){
  if(family==='DEX–DEX')return ['spot_spot'];
  if(family==='DEX–CEX')return ['all','spot_spot','perp_spot'];
  return Object.keys(products);
}
type Props={family:string,product:string,onChange:(family:string,product:string)=>void};
export function MarketTabs({family,product,onChange}:Props){
  function changeFamily(next:string){
    const available=options(next);
    const nextProduct=(next!==family&&family==='DEX–DEX')||!available.includes(product)?available[0]:product;
    onChange(next,nextProduct);
  }
  return <><div className="venueTabs" role="group" aria-label="거래소 조합">{families.map(f=><button type="button" key={f} aria-pressed={family===f} onClick={()=>changeFamily(f)}>{f}</button>)}</div>
    <div className="productTabs" role="group" aria-label="시장 유형">{options(family).map(v=><button type="button" key={v} aria-pressed={product===v} onClick={()=>onChange(family,v)}>{products[v]}</button>)}</div></>;
}

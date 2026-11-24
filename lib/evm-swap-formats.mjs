// Swap ABIs from Aerodrome IPool, Algebra IAlgebraPoolEvents, Balancer IVault,
// Curve StableSwap/StableSwap-NG and LFJ ILBPair.
const solidly='0xb3e2773606abfd36b5bd91394b3a54d1398336c65005baf7bf7a05efeffaf75b';
const algebra='0x121cb44ee54098b1a04743c487e7460d8dd429b27f88b1f4d4767396e1a59f79';
const balancer='0x2170c741c41531aec20e7c107c24eecfdd15e69c9bb0a8dd37b1840b9e0b207b';
const curve=['0x8b3e96f2b889fa771c53c981b40daf005f63f637f1869f707052d15a3dd97140','0xb2e76ae99761dc136e598d4a629bb347eccb9532a5f8bbd72e18467c3c34cc98'];
const liquidityBook='0xad7d6f97abf51ce18e17a38f4d70e975be9c0708474987bb3e26ad21bd93ca70';
export const extraSwapTopics=[solidly,algebra,balancer,...curve,liquidityBook];
const addrTopic=/^0x0{24}[0-9a-f]{40}$/;
function pairPrice(in0,in1,out0,out1){
  if(in0>0n&&out1>0n&&!in1&&!out0)return Number(out1)/Number(in0);
  if(in1>0n&&out0>0n&&!in0&&!out1)return Number(in1)/Number(out0);
  return 0;
}
export function extraSwap(log){
  const [topic,id,a,b]=log.topics??[];
  if(!extraSwapTopics.includes(topic)||!/^0x(?:[0-9a-f]{64}){2,7}$/.test(log.data))return;
  const w=log.data.slice(2).match(/.{64}/g).map(x=>BigInt('0x'+x)),pool=log.address;
  if(topic===solidly&&w.length===4)return {pool,protocol:'AMM',rawRatio:pairPrice(...w)};
  if(topic===algebra&&w.length===7)return {pool,protocol:'Algebra',rawRatio:(Number(w[2])/2**96)**2};
  if(topic===liquidityBook&&w.length===6){
    const mask=(1n<<128n)-1n;
    return {pool,protocol:'LB',axis:'X/Y',rawRatio:pairPrice(w[1]&mask,w[1]>>128n,w[2]&mask,w[2]>>128n)};
  }
  if(curve.includes(topic)&&w.length===4&&w[0]!==w[2]&&w[0]<256n&&w[2]<256n){
    const forward=w[0]<w[2],axis=forward?w[0]+'/'+w[2]:w[2]+'/'+w[0];
    return {pool,protocol:'StableSwap',axis,series:axis,rawRatio:forward?Number(w[3])/Number(w[1]):Number(w[1])/Number(w[3])};
  }
  if(topic===balancer&&w.length===2&&pool==='0xba12222222228d8ba445958a75a0704d566bf2c8'&&
      /^0x[0-9a-f]{64}$/.test(id)&&addrTopic.test(a)&&addrTopic.test(b)&&a!==b){
    const tokens=[a,b].map(t=>'0x'+t.slice(-40)).sort();
    return {pool:id.slice(0,42),protocol:'V2 Vault',venue:'balancer',tokens,series:tokens.join('/'),
      rawRatio:a<b?Number(w[1])/Number(w[0]):Number(w[0])/Number(w[1])};
  }
}

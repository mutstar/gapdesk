// Swap ABIs from Aerodrome IPool, Algebra IAlgebraPoolEvents, Balancer IVault,
// Curve StableSwap/StableSwap-NG and LFJ ILBPair.
const solidly='0xb3e2773606abfd36b5bd91394b3a54d1398336c65005baf7bf7a05efeffaf75b';
const algebra='0x121cb44ee54098b1a04743c487e7460d8dd429b27f88b1f4d4767396e1a59f79';
const balancer='0x2170c741c41531aec20e7c107c24eecfdd15e69c9bb0a8dd37b1840b9e0b207b';
const curve=['0x8b3e96f2b889fa771c53c981b40daf005f63f637f1869f707052d15a3dd97140','0xb2e76ae99761dc136e598d4a629bb347eccb9532a5f8bbd72e18467c3c34cc98'];
const liquidityBook='0xad7d6f97abf51ce18e17a38f4d70e975be9c0708474987bb3e26ad21bd93ca70';
// Official event interfaces: Pancake infinity-core ICLPoolManager/IBinPoolManager,
// Maverick IMaverickV2Pool, Fluid poolT1/events.sol, Ambient CrocSwapDex,
// Balancer IVaultEvents, Mento IBroker and BancorNetwork.TokensTraded.
const infinityCL='0x04206ad2b7c0f463bff3dd4f33c5735b0f2957a351e4f79763a4fa9e775dd237';
const infinityBin='0x3e8aae37f890eb1f9d63dd4d2062f3f0be757848a0f0760e4f3e53dad556e861';
const clInit='0x426cc62fe6a33a40ba2788c2c87a9c34ee4582b95bc9fa5a7bb7ae70b750b99c';
const binInit='0xddfde5903015c0eb1671976c6c8f760f1328bec57f15286b6bdab2f955cab9c9';
const clManager='0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b',binManager='0xc697d2898e0d09264376196696c51d7abbbaa4a9';
const maverick='0x103ed084e94a44c8f5f6ba8e3011507c41063177e29949083c439777d8d63f60';
const fluid='0xdc004dbca4ef9c966218431ee5d9133d337ad018dd5b5c5493722803f75c64f7';
const maverickCreated='0x848331e408557f4b7eb6561ca1c18a3ac43004fbe64b8b5bce613855cfdf22d2';
const fluidDeployed='0x80d4769bbf5966f1c91cdab7c477bd8f74016bd5f5ed3ad18af6b32e29f6da7f';
const ambient='0x5d7a6c346454f5c536b7f52655e780f6db27b15b489f80f2dbb288c9e4f366bd';
const mento='0xe7b046415cac9de47940c3087e06db13a0e058ccf53ac5f0edd49ebb4c2c3a6f';
const bancor='0x5c02c2bb2d1d082317eb23916ca27b3e7c294398b60061a2ad54f1c3c018c318';
const balancer3='0x0874b2d545cb271cdbda4e093020c452328b24af12382ed62c4d00f5c26709db';
const mavChains=['ethereum','arbitrum','base','bsc'];
export const extraSwapTopics=[solidly,algebra,balancer,...curve,liquidityBook,infinityCL,infinityBin,maverick,fluid,ambient,mento,bancor,balancer3];
export function needsPoolIdentity(topic,chain){
  return topic===maverick&&mavChains.includes(chain)||topic===fluid&&chain==='arbitrum';
}
export function extraPoolTopics(chain){
  const topics=[];
  if(chain==='base'||chain==='bsc')topics.push(clInit,binInit);
  if(mavChains.includes(chain))topics.push(maverickCreated);
  if(chain==='arbitrum')topics.push(fluidDeployed);
  return topics;
}
const addrTopic=/^0x0{24}[0-9a-f]{40}$/;
const word=/^0x[0-9a-f]{64}$/;
const asAddress=value=>addrTopic.test(value)?'0x'+value.slice(-40):null;
const dataAddress=n=>n<2n**160n?'0x'+n.toString(16).padStart(40,'0'):null;
function words(data,length){
  if(typeof data!=='string'||data.length!==2+length*64||!/^0x[0-9a-f]+$/.test(data))return;
  return data.slice(2).match(/.{64}/g).map(w=>BigInt('0x'+w));
}
export function extraPool(log,chain){
  const [topic,id,a,b]=log.topics??[];
  if(topic===clInit||topic===binInit){
    const cl=topic===clInit;
    if((chain==='base'||chain==='bsc')&&log.address===(cl?clManager:binManager)&&word.test(id)&&
      log.topics.length===4&&asAddress(a)&&asAddress(b)&&a<b&&words(log.data,cl?5:4)){
      return {pool:id,venue:'pancakeswap',tokens:[asAddress(a),asAddress(b)]};
    }
  }
  if(topic===maverickCreated&&mavChains.includes(chain)&&log.address==='0x0a7e848aca42d879ef06507fca0e7b33a0a63c1e'&&log.topics.length===1){
    const w=words(log.data,11);
    if(w&&w[0]>0n&&dataAddress(w[0])&&w[7]<w[8]&&dataAddress(w[8])){
      return {pool:dataAddress(w[0]),venue:'maverick',tokens:[dataAddress(w[7]),dataAddress(w[8])]};
    }
  }
  if(topic===fluidDeployed&&chain==='arbitrum'&&log.address==='0x91716c4eda1fb55e84bf8b4c7085f84285c19085'&&
    log.topics.length===3&&asAddress(id)&&word.test(a)&&log.data==='0x')return {pool:asAddress(id),venue:'fluid'};
}
export function pairPrice(in0,in1,out0,out1){
  if(in0>0n&&out1>0n&&!in1&&!out0)return Number(out1)/Number(in0);
  if(in1>0n&&out0>0n&&!in0&&!out1)return Number(in1)/Number(out0);
  return 0;
}
function fill(inAmount,outAmount,forward){
  if(!inAmount||!outAmount)return 0;
  return forward?Number(outAmount)/Number(inAmount):Number(inAmount)/Number(outAmount);
}
function signedFlow(a,b){
  a=BigInt.asIntN(256,a);b=BigInt.asIntN(256,b);
  if(a===0n||b===0n||(a<0n)===(b<0n)||BigInt.asIntN(128,a)!==a||BigInt.asIntN(128,b)!==b)return 0;
  return Math.abs(Number(b)/Number(a));
}
function pairedFill(pool,venue,protocol,a,b,amountIn,amountOut){
  if(!a||!b||a===b||!amountIn||!amountOut)return;
  const tokens=[a,b].sort();
  return {pool,venue,protocol,tokens,series:tokens.join('/'),rawRatio:fill(amountIn,amountOut,a<b)};
}
export function extraSwap(log,chain,lookupVenue=()=>null){
  const [topic,id,a,b]=log.topics??[];
  if(!extraSwapTopics.includes(topic)||!/^0x(?:[0-9a-f]{64}){2,10}$/.test(log.data))return;
  const w=log.data.slice(2).match(/.{64}/g).map(x=>BigInt('0x'+x)),pool=log.address;
  if(topic===infinityCL||topic===infinityBin){
    const cl=topic===infinityCL;
    if((chain==='base'||chain==='bsc')&&pool===(cl?clManager:binManager)&&log.topics.length===3&&word.test(id)&&asAddress(a)&&
      w.length===(cl?7:5)&&signedFlow(w[0],w[1])){
      return {pool:id,venue:'pancakeswap',protocol:cl?'Infinity CL':'Infinity Bin',rawRatio:cl?(Number(w[2])/2**96)**2:signedFlow(w[0],w[1])};
    }
  }
  if(topic===maverick&&mavChains.includes(chain)&&log.topics.length===1&&w.length===8&&w[3]<=1n&&w[4]<=1n&&
     ['maverick','maverickv2'].includes(lookupVenue(pool)))return {pool,venue:'maverick',protocol:'V2',series:'fill',rawRatio:fill(w[6],w[7],w[3]===1n)};
  if(topic===fluid&&chain==='arbitrum'&&log.topics.length===1&&w.length===4&&w[0]<=1n&&lookupVenue(pool)==='fluid'){
    return {pool,venue:'fluid',protocol:'T1',series:'fill',rawRatio:fill(w[1],w[2],w[0]===1n)};
  }
  if(topic===ambient&&chain==='scroll'&&pool==='0xaaaaaaaacb71bf2c8cae522ea5fa455571a74106'&&
     log.topics.length===3&&asAddress(id)&&asAddress(a)&&id<a&&w.length===10){
    const tokens=[asAddress(id),asAddress(a)],rawRatio=signedFlow(w[8],w[9]);
    if(rawRatio)return {pool,venue:'ambient',protocol:'CrocSwap',tokens,series:[...tokens,w[0]].join('/'),rawRatio};
  }
  if(topic===mento&&chain==='celo'&&pool==='0x777a8255ca72412f0d706dc03c9d1987306b4cad'&&
     log.topics.length===4&&word.test(id)&&asAddress(a)&&w.length===4&&dataAddress(w[0])==='0x22d9db95e6ae61c104a7b6f6c78d7993b94ec901'){
    return pairedFill(id,'mento','Broker V2',asAddress(b),dataAddress(w[1]),w[2],w[3]);
  }
  // The currently deployed BancorNetwork indexes the trade context, not a pool.
  // Route fills are compared only against the same pair in the same network.
  if(topic===bancor&&chain==='ethereum'&&pool==='0xeef417e1d5cc832e619ae18d2f140de2999dd4fb'&&
     log.topics.length===4&&word.test(id)&&w.length===6)return pairedFill(pool,'bancor','V3 route',asAddress(a),asAddress(b),w[0],w[1]);
  if(topic===balancer3&&['ethereum','arbitrum','base'].includes(chain)&&pool==='0xba1333333333a1ba1108e8412f11850a5c319ba9'&&
    log.topics.length===4&&asAddress(id)&&w.length===4)return pairedFill(asAddress(id),'balancer','V3 Vault',asAddress(a),asAddress(b),w[0],w[1]);
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

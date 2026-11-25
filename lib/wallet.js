import {CHAINS,DIAMOND,NATIVE} from './assets.js';
export const chainName=id=>CHAINS[id]?.name||String(id);
const word=val=>val.replace(/^0x/,'').padStart(64,'0');
const quantity=n=>'0x'+BigInt(n).toString(16);
export const unitsETH=n=>(BigInt(Math.floor(n*1e12))*1000000n).toString();
export const unitsUSDC=n=>String(Math.floor(n*1e6));
function provider(){if(!window.ethereum?.request)throw Error('브라우저 지갑 확장 프로그램 또는 지갑 앱의 브라우저에서 열어주세요.');return window.ethereum}
const request=(method,params=[])=>provider().request({method,params});
export async function connect(){const [account]=await request('eth_requestAccounts');if(!account)throw Error('연결된 계정이 없습니다.');return account}
async function ensureAccount(address,chain){
  const [a]=await request('eth_accounts');
  if(a?.toLowerCase()!==address?.toLowerCase())throw Error('지갑 계정이 바뀌었습니다.');
  if(Number(await request('eth_chainId'))!==chain)await request('wallet_switchEthereumChain',[{chainId:quantity(chain)}]);
  if(Number(await request('eth_chainId'))!==chain)throw Error('네트워크를 확인해주세요.');
}
export async function publicBalances(address){
  const result={};
  await Promise.all(Object.entries(CHAINS).map(async ([id,c])=>{
    async function rpc(method,params){
      const r=await fetch(c.rpc,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(7000)});
      const j=await r.json();return BigInt(j.result);
    }
    try{const [u,e]=await Promise.all([rpc('eth_call',[{to:c.usdc,data:'0x70a08231'+word(address)},'latest']),rpc('eth_getBalance',[address,'latest'])]);
    result[id]={at:Date.now(),usdc:Number(u)/10**c.decimals,eth:Number(e)/1e18}}catch{}
  }));return result;
}
export async function quoteStep(step,address){
 const r=await fetch('/api/quote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...step,address})});
 if(!r.ok)throw Error('현재 실행 견적이 없습니다.');const q=await r.json();
 if(step.cross&&(q.fromChain!==step.from||q.toChain!==step.to||q.fromToken?.toLowerCase()!==step.input?.toLowerCase()||
    q.toToken?.toLowerCase()!==step.output?.toLowerCase()||q.inputUnits!==step.amount||
    (step.side==='bridge'?q.tool!==step.provider:!step.pool||q.pool?.toLowerCase()!==step.pool.toLowerCase())||
    !Number.isFinite(q.at)||q.at<Date.now()-30000||q.at>Date.now()+5000||!Number.isFinite(q.gas)||q.gas<0))throw Error('경로의 CA·풀 또는 브릿지 견적이 변경됐어요.');
 if(BigInt(q.minimum)<BigInt(step.min)||q.gas>step.maxGas+0.001)throw Error('새 견적이 허용 범위를 벗어났습니다. 보유 자산과 경로를 다시 확인해주세요.');
 if(q.tx?.to?.toLowerCase()!==DIAMOND || Number(q.tx.chainId)!==step.from||!/^0x[\da-f]+$/i.test(q.tx.data))throw Error('지원하는 실행 컨트랙트인지 확인할 수 없습니다.');
 const erc=(step.input??(step.side==='buy'?CHAINS[step.from].usdc:NATIVE))!==NATIVE;
 if(erc && (q.approval?.toLowerCase()!==DIAMOND||BigInt(q.tx.value||0)!==0n))throw Error('승인 주소 또는 네이티브 전송액을 확인할 수 없습니다.');
 if(!erc&&BigInt(q.tx.value||0)!==BigInt(step.amount))throw Error('전송 수량이 달라졌습니다.');
 return q;
}
export async function sendStep(step,address,beforeFirst){
 await ensureAccount(address,step.from);
 const q=await quoteStep(step,address);
 let tx={from:address,to:q.tx.to,data:q.tx.data,value:q.tx.value||'0x0'},type='trade';
 const token=step.input??(step.side==='buy'?CHAINS[step.from].usdc:NATIVE);
 if(token!==NATIVE){
   const [bal,allowed]=await Promise.all([
     request('eth_call',[{to:token,data:'0x70a08231'+word(address)},'latest']),
     request('eth_call',[{to:token,data:'0xdd62ed3e'+word(address)+word(DIAMOND)},'latest'])]);
   if(BigInt(bal)<BigInt(step.amount))throw Error('거래에 필요한 토큰 잔액이 부족합니다.');
   if(BigInt(allowed)<BigInt(step.amount)){
     type='approval';tx={from:address,to:token,value:'0x0',data:'0x095ea7b3'+word(DIAMOND)+word(quantity(step.amount))};
   }
 }
 const [gas,price,balance]=await Promise.all([request('eth_estimateGas',[tx]),request('eth_gasPrice'),request('eth_getBalance',[address,'latest'])]);
 if(BigInt(balance)<BigInt(tx.value)+BigInt(gas)*BigInt(price)*12n/10n)throw Error('거래 금액 또는 가스비에 필요한 네이티브 토큰이 부족합니다.');
 if(beforeFirst)await beforeFirst();
 if(Date.now()-q.at>30000)throw Error('견적이 만료됐습니다. 다시 조회해주세요.');
 await ensureAccount(address,step.from);
 return {hash:await request('eth_sendTransaction',[tx]),type,from:step.from,to:step.to};
}
export async function checkTx(p,address){
 await ensureAccount(address,p.from);
 const receipt=await request('eth_getTransactionReceipt',[p.hash]);
 if(!receipt)return 'pending';
 if(BigInt(receipt.status)!==1n)return 'failed';
 if(p.from!==p.to){
   const qp=new URLSearchParams({txHash:p.hash,fromChain:String(p.from),toChain:String(p.to)});
   const r=await fetch('https://li.quest/v1/status?'+qp,{signal:AbortSignal.timeout(8000)});
   if(!r.ok)return 'pending';const j=await r.json();
   if(j.status==='FAILED'||j.status==='DONE'&&j.substatus!=='COMPLETED')return 'review';
   if(j.status!=='DONE')return 'pending';
 }
 return 'done';
}
export function steps(r){
 const list=[];
 const symbol=r.symbol||'ETH',token=r.fromToken||NATIVE,destToken=r.toToken||NATIVE;
 if(r.buyKind==='DEX')list.push({name:r.buy+' 매수',side:'buy',from:r.from,to:r.from,input:CHAINS[r.from].usdc,output:token,amount:r.buyUnits||unitsUSDC(r.budget),min:r.buyMin||unitsETH(r.qty),maxGas:r.buyGas*1.1});
 else list.push({name:r.buy+' 매수 및 출금',manual:r.buy,info:(r.buyQuote==='USDT'?'USDC를 USDT로 환전하고 ':'')+symbol+'/'+(r.buyQuote||'USDC')+' 매수 후 '+chainName(r.from)+' 네트워크로 출금하세요. '+(r.bridge||r.sellKind==='DEX'?'연결한 개인 지갑에서 수령하세요.':'매도 거래소의 본인 입금 주소를 확인하세요.')});
 if(r.bridge)list.push({name:r.bridge+' 브리지',side:'bridge',from:r.from,to:r.to,input:token,output:destToken,amount:r.bridgeInput||unitsETH(r.beforeBridge),min:r.bridgeMin||unitsETH(r.arrival),maxGas:r.bridgeGas*1.1});
 if(r.sellKind==='DEX')list.push({name:r.sell+' 매도',side:'sell',from:r.to,to:r.to,input:destToken,output:CHAINS[r.to].usdc,amount:r.sellInput||unitsETH(r.arrival),min:r.sellMin||unitsUSDC(r.proceeds),maxGas:r.sellGas*1.1});
 else list.push({name:r.sell+' 입금 및 매도',manual:r.sell,info:chainName(r.to)+'의 '+symbol+' 입금 네트워크와 주소를 확인하세요. 입금이 반영되면 '+symbol+'/'+(r.sellQuote||'USDC')+'에서 직접 매도하세요.'+(r.sellQuote==='USDT'?' 순차익 계산에는 USDT를 USDC로 환전하는 비용이 포함됩니다.':'')});
 if(r.targetMatch)return list.map(s=>({...s,cross:true,provider:r.bridge,pool:r.depthChecks?.find(d=>d.side===s.side)?.pool}));
 return list;
}

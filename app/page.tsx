'use client';
import {useState,useEffect,useRef,useCallback} from 'react';
import {Activity,Radio,Wallet,RefreshCw,SlidersHorizontal,Layers,Check,ArrowUpRight,Clock3,ScanLine,ChevronRight,X,Pause,Play,Network,ShieldCheck} from 'lucide-react';
import {chainName,checkTx,connect,publicBalances,sendStep,steps} from '../lib/wallet.js';
type Row=Record<string,any>;
const names:Record<string,string>={bitget:'Bitget',kucoin:'KuCoin',base:'Base DEX',arb:'Arbitrum DEX'};
const venueLinks:Record<string,string>={KuCoin:'https://www.kucoin.com/trade/ETH-USDC',Bitget:'https://www.bitget.com/spot/ETHUSDC'};
const pairs=['전체','DEX–DEX','CEX–DEX','CEX–CEX'];
const format=(v:number,d=2)=>v.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const tm=(v:number)=>new Date(v).toLocaleTimeString('ko-KR',{hour12:false,timeZone:'Asia/Seoul'});
function Plot({data}:{data:Row[]}){
 const ref=useRef<HTMLCanvasElement>(null);
 useEffect(()=>{const el=ref.current;if(!el)return;
 function draw(){if(!el)return;const box=el.getBoundingClientRect(),w=box.width,h=box.height,dpr=window.devicePixelRatio||1;
 el.width=w*dpr;el.height=h*dpr;const ctx=el.getContext('2d');if(!ctx)return;ctx.scale(dpr,dpr);
 ctx.strokeStyle='#a9c9e4';ctx.lineWidth=.7;ctx.setLineDash([3,5]);
 for(let y=12;y<h;y+=27){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke()}
 for(let x=12;x<w;x+=w/8){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke()}
 if(data.length<2)return;const values=data.map(x=>x.price),lo=Math.min(...values),hi=Math.max(...values);
 const pts=values.map((v,i)=>[3+i*(w-10)/(values.length-1),h-10-(v-lo)/(hi-lo||1)*(h-25)]);
 ctx.setLineDash([]);ctx.beginPath();pts.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.lineWidth=2.5;ctx.strokeStyle='#2277b7';ctx.stroke();
 const grad=ctx.createLinearGradient(0,5,0,h);grad.addColorStop(0,'rgba(68,159,228,.22)');grad.addColorStop(1,'rgba(68,159,228,0)');ctx.lineTo(w-7,h);ctx.lineTo(3,h);ctx.closePath();ctx.fillStyle=grad;ctx.fill();
 const [x,y]=pts.at(-1)!;ctx.beginPath();ctx.arc(x,y,4,0,Math.PI*2);ctx.fillStyle='#c75c19';ctx.fill();
 }const obs=new ResizeObserver(draw);obs.observe(el);draw();return()=>obs.disconnect()},[data]);
 return <canvas ref={ref} role="img" aria-label="최근 24개 시간봉의 ETH 가격 추이"/>;
}
function VenueIcon({id}:{id:string}){return <span className={'venueIcon '+id} aria-hidden="true">{({bitget:'↔',kucoin:'K',base:'━',arb:'∕∕'} as Row)[id]}</span>}
async function scan(amount:number,floor:number,address='',only='',signal?:AbortSignal){
 const q=new URLSearchParams({amount:String(amount),floor:String(floor)});if(address)q.set('address',address);if(only)q.set('only',only);
 const r=await fetch('/api/scan?'+q,{cache:'no-store',signal});if(!r.ok)throw Error('스캔 서버에 연결할 수 없습니다.');return r.json() as Promise<Row>;
}
export default function Home(){
 const [view,setView]=useState('스캐너'),[pair,setPair]=useState('전체'),[amount,setAmount]=useState('1000'),[min,setMin]=useState('5');
 const [settings,apply]=useState({amount:1000,min:5}),[own,setOwn]=useState(false),[auto,setAuto]=useState(true),[tick,reset]=useState(0);
 const [snapshot,setSnapshot]=useState<Row|null>(null),[candles,setCandles]=useState<Row[]>([]),[busy,setBusy]=useState(true),[err,setErr]=useState(''),[now,setNow]=useState(0);
 const [address,setAddress]=useState(''),[balances,setBalances]=useState<Row>({}),[note,setNote]=useState(''),[walletOpen,showWallet]=useState(false);
 const [selected,select]=useState<Row|null>(null),[jobState,setJobState]=useState<Row|null>(null),[acting,setActing]=useState(false),[jobNote,setJobNote]=useState('');
 const lock=useRef(false),modalRef=useRef<HTMLDialogElement>(null);
 const job=(j:Row|null)=>{setJobState(j);try{if(j)sessionStorage.setItem('gapdesk-route',JSON.stringify(j));else sessionStorage.removeItem('gapdesk-route')}catch{}};
 useEffect(()=>{try{const s=sessionStorage.getItem('gapdesk-route');if(s)setJobState(JSON.parse(s))}catch{}},[]);
 useEffect(()=>{let active=true;const changed=(a:string[])=>{if(active){setAddress(a[0]||'');setBalances({})}};
 const p=(window as any).ethereum;p?.request({method:'eth_accounts'}).then(changed).catch(()=>{});p?.on?.('accountsChanged',changed);
 return()=>{active=false;p?.removeListener?.('accountsChanged',changed)}},[]);
 useEffect(()=>{let live=true;function load(){if(address)publicBalances(address).then(b=>{if(live)setBalances(b)})}load();const id=setInterval(load,30000);return()=>{live=false;clearInterval(id)}},[address]);
 useEffect(()=>{const f=()=>setNow(Date.now());f();const t=setInterval(f,1000);return()=>clearInterval(t)},[]);
 useEffect(()=>{let live=true;const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
 async function run(){setBusy(true);try{const v=await scan(settings.amount,settings.min,address,'',controller.signal);if(live){setSnapshot(v);setErr('')}}catch{if(live){setSnapshot(null);setErr('데이터를 받지 못했습니다. 새로고침으로 다시 시도하세요.')}}finally{if(live){setBusy(false);if(auto)timer=setTimeout(run,30000)}}}
 setSnapshot(null);run();return()=>{live=false;controller.abort();clearTimeout(timer)}},[settings,address,auto,tick]);
 useEffect(()=>{let active=true;const load=()=>fetch('/api/history').then(r=>r.json()).then(v=>{if(active&&Array.isArray(v))setCandles(v)}).catch(()=>{});load();const t=setInterval(load,300000);return()=>{active=false;clearInterval(t)}},[]);
 const modal=!!selected||walletOpen;
 useEffect(()=>{const d=modalRef.current;if(modal&&!d?.open)d?.showModal();if(!modal&&d?.open)d.close()},[modal]);
 const close=()=>{if(!lock.current){select(null);showWallet(false);setJobNote('')}};
 async function wallet(){try{const a=await connect();setAddress(a);setNote('');showWallet(false)}catch(e:any){setNote(e.message||'연결 요청을 확인해주세요.');showWallet(true)}}
 const sources:Row[]=snapshot?.sources||[],active=sources.filter(s=>s.ok&&now-s.time<45000),liveIds=new Set(active.map(s=>s.id));
 const qualified=(snapshot?.rows||[]).filter((r:Row)=>r.expires>now);
 const rows=qualified.filter((r:Row)=>(pair==='전체'||r.kind===pair)&&(!own||address&&r.buyKind==='DEX'&&r.sellKind==='DEX'&&balances[r.from]?.usdc>=r.budget&&balances[r.from]?.eth>=(r.buyGas+r.bridgeGas+.02)/Math.max(1,r.budget/r.qty)&&balances[r.to]?.eth>=(r.sellGas+.02)/Math.max(1,r.budget/r.qty)));
 const spot=active.find(s=>s.id==='kucoin')||active.find(s=>s.id==='bitget');
 const last=spot?(spot.ask+spot.bid)/2:candles.at(-1)?.price,first=candles.at(0)?.price,change=last&&first?(last/first-1)*100:null;
 const filter=(e:React.FormEvent)=>{e.preventDefault();apply({amount:Number(amount),min:Number(min)});setNote('')};
 const resume=()=>{select(jobState!.row);setJobNote('')};
 const current=selected&&jobState?.row?.id===selected.id?jobState:null;
 const routeSteps=selected?steps(current?.row||selected):[],index=current?.i||0,step=routeSteps[index];
 const start=useCallback(async(r:Row)=>{const data=await scan(r.budget,settings.min,address,r.id);
 const v=data.rows.find((x:Row)=>x.id===r.id&&x.from===r.from&&x.to===r.to);
 if(!v)throw Error('현재 견적으로는 이 경로가 조건을 충족하지 않습니다.');
 return v},[address,settings.min]);
 async function act(){
 if(lock.current||!selected)return;lock.current=true;setActing(true);setJobNote('');
 try{
 if(!current){
   if(jobState)throw Error('먼저 진행 중인 경로를 확인해주세요.');
   if((selected.buyKind==='DEX'||selected.sellKind==='DEX'||selected.bridge)&&!address)throw Error('먼저 상단에서 지갑을 연결해주세요.');
   const r=await start(selected);job({row:r,i:0,account:address});return;
 }
 if((current.account||'').toLowerCase()!==(address||'').toLowerCase())throw Error('이 경로를 시작한 지갑으로 연결해주세요.');
 if(current.pending){
   const status=await checkTx(current.pending,address);
   if(status==='pending'){setJobNote('체인에서 처리 중입니다. 잠시 후 다시 확인해주세요.');return}
   if(status==='review'){job({...current,review:true});setJobNote('브리지에서 일부 수령 또는 환불이 감지됐습니다. 트랜잭션을 확인해주세요.');return}
   if(status==='failed'){job({...current,pending:null});setJobNote('트랜잭션이 실패했습니다. 지갑에서 내역을 확인해주세요.');return}
   job({...current,i:current.i+(current.pending.type==='approval'?0:1),pending:null});return;
 }
 if(step?.manual){job({...current,i:current.i+1});return}
 if(!step)return;
 const recheck= index===0?async()=>{await start(current.row)}:undefined;
 const pending=await sendStep(step,address,recheck);
 job({...current,pending});
 }catch(e:any){setJobNote(e.code===4001?'지갑에서 요청을 취소했습니다.':e.message||'실행할 수 없습니다.')}
 finally{lock.current=false;setActing(false)}
 }
 return <><header className="mast"><div className="mastInner"><a href="/" className="brand"><i className="mark"><b/><b/><b/></i>Gapdesk</a><nav aria-label="주 메뉴">{['스캐너','데이터 소스'].map((n,i)=><button key={n} className={view===n?'navOn':''} onClick={()=>setView(n)}>{i?<Layers size={16}/>:<Activity size={17}/>} {n}</button>)}</nav><button className="wallet" onClick={()=>{setNote('');showWallet(true)}}><Wallet size={16}/>{address?address.slice(0,6)+'…'+address.slice(-4):'지갑 연결'}</button></div></header>
 <main><div className="titleLine"><div><div className="overline"><span className="liveDot"/> ETH / USDC · 현물</div><h1>{view==='스캐너'?'아비트라지 스캐너':'데이터 소스'}</h1></div><div className="liveControls"><button className={'auto '+(auto?'on':'')} onClick={()=>setAuto(!auto)}>{auto?<Pause size={14}/>:<Play size={14}/>}자동 스캔 {auto?'켜짐':'꺼짐'}</button><button aria-label="지금 새로고침" disabled={busy} className="refresh" onClick={()=>reset(tick+1)}><RefreshCw size={17} className={busy?'spin':''}/></button></div></div>
 <section className="overview"><div className="chartBox"><div className="chartData"><div className="chartHeader"><span className="asset"><span className="eth">Ξ</span>Ethereum <small>ETH / USDC</small></span><span className="period">1H × 24</span></div><div className="price">{last?format(last):'—'} <small>USDC</small></div><div className="change">{change!==null?<><b className={change>=0?'up':'down'}>{change>=0?'+':''}{format(change)}%</b> 첫 시간봉 대비</>:'가격 수신 대기'}</div><Plot data={candles}/><div className="axis"><span>{candles.length?'24개 시간봉 · KuCoin':'차트 수신 대기'}</span><span>{spot?'현재 호가 중간값':'최근 시간봉 종가'}</span></div></div><div className="pekoraArt"><img src="/pekora-chart.webp" alt="당근을 든 우사다 페코라 팬아트" /></div></div>
 <div className="metrics"><div><span><Radio size={16}/>연결된 마켓</span><strong>{active.length}<small> / 4</small></strong></div><div><span><Network size={16}/>비교한 경로</span><strong>{snapshot?.checked??'—'}<small> 개</small></strong></div><div><span><ShieldCheck size={16}/>조건 충족 갭</span><strong className="qual">{qualified.length}<small> 건</small></strong></div></div></section>
 {view==='스캐너'?<div className="workspace"><section className="board"><div className="panelHead"><div><h2>실행 가능 갭</h2></div><span className="count">{rows.length}건</span></div><div className="tabs" aria-label="거래소 조합">{pairs.map(p=><button key={p} aria-pressed={pair===p} className={pair===p?'selected':''} onClick={()=>setPair(p)}>{p}</button>)}</div>
 <div className="tableHead"><span>매수 · 매도 마켓</span><span>이동 경로</span><span>예상 순차익</span></div>
 {rows.map((r:Row)=><button className="routeRow" key={r.id} onClick={()=>{select(r);setJobNote('')}}><span><strong>{r.buy} › {r.sell}</strong><small>{r.kind} · ETH</small></span><span>{r.bridge||'직접 전송'}<small>{chainName(r.from)} · {chainName(r.to)}</small></span><span className="gain">+{format(r.profit)}<small>USDC</small></span></button>)}
 {!rows.length&&<div className="empty"><div className={'radar '+(busy?'moving':'')}><i/><b/><em/><ScanLine size={24}/></div><h3>{err?'스캔 연결을 확인해주세요':busy?'실행 경로를 확인하고 있어요':!active.length?'최신 견적을 기다리고 있어요':own&&!address?'연결한 지갑이 필요해요':'현재 조건을 충족한 갭이 없어요'}</h3><p>{err||(own&&!address?'지갑을 연결하면 보유 자산으로 실행할 수 있는 경로를 확인합니다.':'입출금 상태와 이동 비용을 반영한 순차익으로 선별합니다.')}</p></div>}
 <div className="panelFoot"><span><Clock3 size={14}/> {snapshot?tm(snapshot.at)+' KST':'첫 스캔 대기'}</span><span>{busy?'스캔 중':auto?'30초 간격 갱신':'자동 갱신 일시정지'}</span></div>
 {jobState&&<button className="resume" onClick={resume}>진행 중인 경로 확인 <ChevronRight size={16}/></button>}</section>
 <aside className="controls"><div className="panelHead"><h2><SlidersHorizontal size={20}/> 스캔 설정</h2></div><form onSubmit={filter}><label>거래 금액<div className="field"><input aria-label="거래 금액" required type="number" min="10" max="100000" step=".01" value={amount} onChange={e=>setAmount(e.target.value)}/><span>USDC</span></div></label><label>최소 예상 순차익<div className="field"><input aria-label="최소 예상 순차익" required type="number" min="0" max="100000" step=".01" value={min} onChange={e=>setMin(e.target.value)}/><span>USDC</span></div></label><label className="switchLine"><span>내 지갑으로 실행 가능</span><input type="checkbox" checked={own} onChange={e=>setOwn(e.target.checked)}/><i/></label><button className="apply">조건 적용</button></form></aside></div>:null}
 <section className="feeds"><div className="panelHead"><div><h2>마켓 피드</h2></div><span className="secondary">ETH / USDC</span></div><div className="feedGrid">{Object.entries(names).map(([id,n])=>{const s=sources.find(x=>x.id===id),ok=liveIds.has(id);return <div className="feed" key={id}><VenueIcon id={id}/><div><strong>{n}</strong><small><i className={ok?'greenDot':'greyDot'}/>{ok?'견적 수신':busy?'조회 중':'수신 대기'} · {['base','arb'].includes(id)?'DEX':'CEX'}</small></div>{view==='데이터 소스'&&s?.ok&&<p>매수 {format(s.ask)}<br/>매도 {format(s.bid)}<br/>{tm(s.time)} KST</p>}</div>})}</div>{view==='데이터 소스'&&<p className="sourceNote">CEX는 ETH/USDC 호가 잔량과 네트워크별 입출금 상태를, DEX는 LI.FI의 거래 금액별 견적을 사용합니다. KuCoin은 기본 테이커 수수료 0.1%와 종목 계수를 적용합니다. 별도 입금 전송은 1 USDC, 토큰 사용 승인은 0.1 USDC를 비용으로 추정합니다. 가스는 USD와 USDC를 1:1로 추정하며 10% 여유분을 반영합니다. 브리지 대기 중 가격이 변할 수 있습니다.</p>}</section>
 <footer><span>Gapdesk</span><span>Base · Arbitrum One</span></footer></main>
 <dialog ref={modalRef} onCancel={e=>{e.preventDefault();close()}}><div className="dialogHead"><h2>{walletOpen?'내 지갑':selected?'경로 확인':''}</h2><button className="iconButton" aria-label="닫기" disabled={acting} onClick={close}><X size={20}/></button></div>
 {walletOpen?<><div className="dialogBody"><Wallet size={28}/><h3>{address?address.slice(0,8)+'…'+address.slice(-6):'브라우저 지갑 연결'}</h3><p>계정 주소로 Base와 Arbitrum의 USDC·ETH 잔액을 조회합니다. 거래를 실행할 때 지갑에서 요청을 확인하고 서명합니다.</p>{address&&Object.entries(balances).map(([id,b])=><p key={id}>{chainName(Number(id))} · {format(b.usdc)} USDC · {format(b.eth,5)} ETH</p>)}{note&&<p role="status" className="message">{note}</p>}</div><button className="apply" onClick={address?close:wallet}>{address?'확인':'지갑에서 연결'}</button></>:selected?<><div className="dialogBody"><div className="routeTitle">{selected.buy} <ChevronRight/> {selected.sell}</div><p>{format(selected.budget)} USDC 기준 · 예상 순차익 <b>+{format(selected.profit)} USDC</b></p><p>{chainName(selected.from)} · {selected.bridge||'직접 전송'} · {chainName(selected.to)}{selected.duration>0?' · 브리지 약 '+Math.ceil(selected.duration/60)+'분':''}</p><div className="steps">{routeSteps.map((s:Row,i:number)=><div key={i} className={index===i?'current':''}><span>{i<index?<Check size={14}/>:i+1}</span>{s.name}</div>)}</div>
 {current&&step?.manual?<p>{step.info} <a target="_blank" rel="noreferrer" href={venueLinks[step.manual]}>거래소 열기 <ArrowUpRight size={13}/></a></p>:<p>각 단계의 견적을 다시 확인합니다. 브리지 이동 중 매도 가격이 바뀌면 다음 단계가 중단될 수 있습니다.</p>}
 {current?.pending&&<p><a target="_blank" rel="noreferrer" href={(current.pending.from===8453?'https://basescan.org/tx/':'https://arbiscan.io/tx/')+current.pending.hash}>트랜잭션 확인 <ArrowUpRight size={14}/></a></p>}
 {jobNote&&<p className="message" role="status">{jobNote}</p>}</div>
 {step||!current?<button className="apply" onClick={act} disabled={acting}>{acting?'확인 중…':!current?'최신 견적으로 경로 확인':current.pending?'체결 상태 확인':step?.manual?'거래소에서 완료했어요':'지갑에서 승인 또는 실행'}</button>:<button className="apply" onClick={()=>{job(null);close()}}>경로 완료</button>}
 {current&&step&&(!current.pending||current.review)&&<button className="stop" disabled={acting} onClick={()=>{job(null);close()}}>경로 추적 종료</button>}</>:null}</dialog></>
}


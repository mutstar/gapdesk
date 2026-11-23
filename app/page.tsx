'use client';
import {useState,useEffect,useRef,useCallback} from 'react';
import {Activity,Radio,Wallet,RefreshCw,SlidersHorizontal,Layers,Check,ArrowUpRight,Clock3,ScanLine,ChevronRight,X,Pause,Play,Network,ShieldCheck} from 'lucide-react';
import {TradeLeg} from '../components/trade-leg';
import {ContractCopy} from '../components/contract-copy';
import {FuturesBoard} from '../components/futures-board';
import {SignalHistory} from '../components/signal-history';
import {TokenUniverse} from '../components/token-universe';
import {CHAINS} from '../lib/assets.js';
import {chainName,checkTx,connect,publicBalances,sendStep,steps} from '../lib/wallet.js';
type Row=Record<string,any>;
function venuePage(row:Row,buy:boolean){
 const venue=buy?row.buy:row.sell,pair=buy?row.buyPair:row.sellPair;
 return venue==='KuCoin'?'https://www.kucoin.com/trade/'+encodeURIComponent(pair||'ETH-USDC'):'https://www.bitget.com/spot/'+encodeURIComponent(pair||'ETHUSDC');
}
const chains:Record<string,{name:string,gas:string,explorer:string}>=CHAINS;
const pairs=['전체','DEX–DEX','CEX–DEX','CEX–CEX'];
const format=(v:number,d=2)=>v.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const tm=(v:number)=>new Date(v).toLocaleTimeString('ko-KR',{hour12:false,timeZone:'Asia/Seoul'});
async function scan(amount:number,floor:number,maxImpact:number,address='',only='',signal?:AbortSignal,cursor='',pool=0,updates=false,revision=''){
 const q=new URLSearchParams({amount:String(amount),floor:String(floor),impact:String(maxImpact)});if(address)q.set('address',address);if(only)q.set('only',only);if(cursor)q.set('cursor',cursor);q.set('pool',String(pool));
 if(updates){q.set('updates','1');q.set('revision',revision)}
 const r=await fetch('/api/scan?'+q,{cache:'no-store',signal});if(r.status===204)return null;if(!r.ok)throw Error('스캔 서버에 연결할 수 없습니다.');return r.json() as Promise<Row>;
}
function QualifiedPair({r}:{r:Row}){
 return <div className="tradePair">
   <TradeLeg side="buy" venue={r.buy} caption={r.buyPair||chainName(r.from)}><span className="legTotal">투입 {format(r.budget)} USDC</span></TradeLeg>
   <TradeLeg side="sell" venue={r.sell} caption={r.sellPair||chainName(r.to)}><span className="legTotal">예상 수령 {format(r.proceeds)} USDC</span></TradeLeg>
 </div>;
}
export default function Home(){
 const [view,setView]=useState('전체 토큰'),[pair,setPair]=useState('전체'),[amount,setAmount]=useState('1000'),[min,setMin]=useState('5'),[impact,setImpact]=useState('1');
 const [settingsNote,setSettingsNote]=useState('');
 const [settings,apply]=useState({amount:1000,min:5,maxImpact:1}),[own,setOwn]=useState(false),[auto,setAuto]=useState(true),[tick,reset]=useState(0);
 const [snapshot,setSnapshot]=useState<Row|null>(null),[busy,setBusy]=useState(true),[err,setErr]=useState(''),[now,setNow]=useState(0);
 const [address,setAddress]=useState(''),[balances,setBalances]=useState<Row>({}),[note,setNote]=useState(''),[walletOpen,showWallet]=useState(false);
 const [selected,select]=useState<Row|null>(null),[jobState,setJobState]=useState<Row|null>(null),[acting,setActing]=useState(false),[jobNote,setJobNote]=useState('');
 const cycle=useRef({cursor:'',pool:0}),lock=useRef(false),modalRef=useRef<HTMLDialogElement>(null);
 const job=(j:Row|null)=>{setJobState(j);try{if(j)sessionStorage.setItem('gapdesk-route',JSON.stringify(j));else sessionStorage.removeItem('gapdesk-route')}catch{}};
 useEffect(()=>{try{const s=sessionStorage.getItem('gapdesk-route');if(s)setJobState(JSON.parse(s))}catch{}},[]);
 useEffect(()=>{let active=true;const changed=(a:string[])=>{if(active){setAddress(a[0]||'');setBalances({})}};
 const p=(window as any).ethereum;p?.request({method:'eth_accounts'}).then(changed).catch(()=>{});p?.on?.('accountsChanged',changed);
 return()=>{active=false;p?.removeListener?.('accountsChanged',changed)}},[]);
 useEffect(()=>{let live=true;function load(){if(address)publicBalances(address).then(b=>{if(live)setBalances(b)})}load();const id=setInterval(load,30000);return()=>{live=false;clearInterval(id)}},[address]);
 useEffect(()=>{const f=()=>setNow(Date.now());f();const t=setInterval(f,1000);return()=>clearInterval(t)},[]);
 useEffect(()=>{let live=true;const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
 let revision='',lastFull=0;
 async function run(){
 const updates=!!revision&&Date.now()-lastFull<30000;
 if(!updates){lastFull=Date.now();setBusy(true)}
 try{const v=await scan(settings.amount,settings.min,settings.maxImpact,address,'',controller.signal,cycle.current.cursor,cycle.current.pool,updates,revision);
 if(!v)return;
 revision=v.revision||'';
 if(live){cycle.current={cursor:v.nextCursor||'',pool:v.poolCursor||0};
 const freshIds=new Set(v.eligible),attempted=new Set(v.attempted);
 setSnapshot((old:Row|null)=>{const retained=v.revision?[]:(old?.rows||[]).filter((r:Row)=>r.expires>Date.now()&&freshIds.has(r.id)&&!attempted.has(r.id));return {...v,rows:[...v.rows,...retained].sort((a,b)=>b.profit-a.profit)}});setErr('')}}catch{if(live&&!updates){setSnapshot(null);setErr('데이터를 받지 못했습니다. 새로고침으로 다시 시도하세요.')}}finally{if(live){setBusy(false);if(auto)timer=setTimeout(run,revision?5000:Math.max(1000,lastFull+30000-Date.now()))}}}
 setSnapshot(null);run();return()=>{live=false;controller.abort();clearTimeout(timer)}},[settings,address,auto,tick]);
 const isFutures=view==='선물 갭';
 const [settingsOpen,setSettingsOpen]=useState(false);
 const modal=!!selected||walletOpen;
 useEffect(()=>{const d=modalRef.current;if(modal&&!d?.open)d?.showModal();if(!modal&&d?.open)d.close()},[modal]);
 const close=()=>{if(!lock.current){select(null);showWallet(false);setJobNote('')}};
 async function wallet(){try{const a=await connect();setAddress(a);setNote('');showWallet(false)}catch(e:any){setNote(e.message||'연결 요청을 확인해주세요.');showWallet(true)}}
 const sources:Row[]=snapshot?.sources||[],active=sources.filter(s=>s.ok&&now-s.time<45000);
 const coverage=snapshot?.poolCoverage, reads:Row[]=coverage?.chainReads||[];
 const registry=coverage?.registry;
 const qualified=(snapshot?.rows||[]).filter((r:Row)=>r.expires>now);
 const rows=qualified.filter((r:Row)=>(pair==='전체'||r.kind===pair)&&(!own||address&&r.buyKind==='DEX'&&r.sellKind==='DEX'&&balances[r.from]?.usdc>=r.budget&&balances[r.from]?.eth>=(r.buyGas+r.bridgeGas+(r.approvalGas||0)+.02)/(r.gasPriceFrom||1)&&balances[r.to]?.eth>=(r.sellGas+(r.approvalGas||0)+.02)/(r.gasPriceTo||1)));
 const filter=async(e:React.FormEvent)=>{e.preventDefault();const cfg={amount:Number(amount),min:Number(min),maxImpact:Number(impact)};apply(cfg);setSettingsNote('');
 try{const r=await fetch('/api/scan?mode=settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(cfg)});if(!r.ok)throw Error();setSettingsNote('모니터링 금액을 저장했어요.')}catch{setSettingsNote('현재 화면에 적용했습니다. 서버 저장을 확인해주세요.')}};
 useEffect(()=>{let mounted=true;fetch('/api/settings',{cache:'no-store'}).then(r=>r.json()).then((v:any)=>{if(mounted&&v?.amount&&Number.isFinite(v.min)&&(v.amount!==1000||v.min!==5||(v.maxImpact??1)!==1)){apply({...v,maxImpact:v.maxImpact??1});setAmount(String(v.amount));setMin(String(v.min));setImpact(String(v.maxImpact??1))}}).catch(()=>{});return()=>{mounted=false}},[]);
 const resume=()=>{select(jobState!.row);setJobNote('')};
 const current=selected&&jobState?.row?.id===selected.id?jobState:null;
 const routeSteps=selected?steps(current?.row||selected):[],index=current?.i||0,step=routeSteps[index];
 const start=useCallback(async(r:Row)=>{const data=await scan(r.budget,settings.min,settings.maxImpact,address,r.id);
 const v=data?.rows.find((x:Row)=>x.id===r.id&&x.from===r.from&&x.to===r.to);
 if(!v)throw Error('현재 견적으로는 이 경로가 조건을 충족하지 않습니다.');
 return v},[address,settings.min,settings.maxImpact]);
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
 return <><header className="mast"><div className="mastInner"><a href="/" className="brand"><i className="mark"><b/><b/><b/></i>Gapdesk</a><nav aria-label="주 메뉴">{['전체 토큰','먹을 수 있는 갭','선물 갭','신규 갭','거래소별 급등락'].map((n,i)=><button key={n} aria-pressed={view===n} className={view===n?'navOn':''} onClick={()=>setView(n)}>{[<Activity key="a" size={17}/>,<Layers key="b" size={16}/>,<Network key="e" size={16}/>,<Clock3 key="c" size={16}/>,<Radio key="d" size={16}/>][i]} {n}</button>)}</nav><button className="wallet" onClick={()=>{setNote('');showWallet(true)}}><Wallet size={16}/>{address?address.slice(0,6)+'…'+address.slice(-4):'지갑 연결'}</button></div></header>
 <main><div className="titleLine"><div><div className="overline"><span className="liveDot"/> {isFutures?'USDT 무기한 선물':'CEX · DEX 현물'}</div><h1>{view}</h1></div><div className="liveControls"><button className={'auto '+(auto?'on':'')} onClick={()=>setAuto(!auto)}>{auto?<Pause size={14}/>:<Play size={14}/>}화면 갱신 {auto?'켜짐':'꺼짐'}</button><button aria-label="지금 새로고침" disabled={busy} className="refresh" onClick={()=>reset(tick+1)}><RefreshCw size={17} className={busy?'spin':''}/></button></div></div>
 <section className="scanSummary" aria-label="스캔 현황">
   <dl>
     <div><dt><Radio size={16}/>{isFutures?'가격 수신 선물 계약':'감시 중인 토큰 심볼'}</dt><dd>{(isFutures?snapshot?.futures?.priced:snapshot?.tokens?.length)?.toLocaleString()??'—'}<small>개</small></dd></div>
     <div><dt><Network size={16}/>{isFutures?'비교한 선물 조합':'비교한 경로'}</dt><dd>{(isFutures?snapshot?.futures?.compared:snapshot?.checked)?.toLocaleString()??'—'}<small>개</small></dd></div>
     <div><dt><ShieldCheck size={16}/>{isFutures?'기초자산 매칭 계약':'조건 충족 갭'}</dt><dd className="qual">{isFutures?snapshot?.futures?.matched?.toLocaleString()??'—':snapshot?qualified.length.toLocaleString():'—'}<small>{isFutures?'개':'건'}</small></dd></div>
   </dl>
   <div className="pekoraArt"><img src="/pekora-chart.webp" alt="당근을 든 우사다 페코라 팬아트" /></div>
 </section>
 {<div className={'workspace '+(isFutures||view==='신규 갭'||view==='거래소별 급등락'?'historyWorkspace':'')}><section className="board">{isFutures?<FuturesBoard book={snapshot?.futures} now={now} budget={settings.amount} busy={busy}/>:view==='신규 갭'||view==='거래소별 급등락'?<SignalHistory key={view} kind={view==='신규 갭'?'gaps':'spikes'} revision={snapshot?.revision||snapshot?.at||tick}/>:view==='전체 토큰'?<TokenUniverse tokens={snapshot?.tokens||[]} busy={busy} at={snapshot?.at||0} budget={settings.amount} floor={settings.min} address={address} now={now} verified={qualified}/>:<><div className="panelHead"><div><h2>금액별 검증 결과</h2></div><span className="count">{rows.length}건</span></div><div className="tabs" aria-label="거래소 조합">{pairs.map(p=><button key={p} aria-pressed={pair===p} className={pair===p?'selected':''} onClick={()=>setPair(p)}>{p}</button>)}</div>
 {rows.map((r:Row)=><article className="marketCard" key={r.id}><header className="marketCardHead"><h3>{r.symbol}</h3><div className="gapValue qualifiedGain"><span>예상 순차익</span><strong>+{format(r.profit)} USDC</strong></div></header>
 <QualifiedPair r={r}/><div className="marketTools"><span className="marketState">{r.bridge||'동일 네트워크'} · {chainName(r.from)}{r.from!==r.to?' → '+chainName(r.to):''}</span><button type="button" className="bridgeAction" onClick={()=>{select(r);setJobNote('')}}>경로 확인</button></div><div className="marketActions">{r.fromToken&&<ContractCopy item={{chain:r.from,token:r.fromToken}}/>}{r.toToken&&(r.to!==r.from||r.toToken!==r.fromToken)&&<ContractCopy item={{chain:r.to,token:r.toToken}}/>}</div></article>)}
 {!rows.length&&<div className="empty"><div className={'radar '+(busy?'moving':'')}><i/><b/><em/><ScanLine size={24}/></div><h3>{err?'스캔 연결을 확인해주세요':busy?'실행 경로를 확인하고 있어요':!active.length?'최신 견적을 기다리고 있어요':own&&!address?'연결한 지갑이 필요해요':'현재 조건을 충족한 갭이 없어요'}</h3><p>{err||(own&&!address?'지갑을 연결하면 보유 자산으로 실행할 수 있는 경로를 확인합니다.':'입출금 상태와 이동 비용을 반영한 순차익으로 선별합니다.')}</p></div>}
 <div className="panelFoot"><span><Clock3 size={14}/> {snapshot?tm(snapshot.at)+' KST':'첫 스캔 대기'}</span><span>{busy?'새 견적 확인 중':auto?'다음 스캔 대기':'자동 갱신 일시정지'}</span></div>
 </>}{jobState&&<button className="resume" onClick={resume}>진행 중인 경로 확인 <ChevronRight size={16}/></button>}</section>
 <aside className={'controls '+(settingsOpen?'settingsExpanded':'')}><div className="panelHead"><h2><SlidersHorizontal size={20}/> 스캔 설정</h2><button type="button" className="mobileSettings" aria-expanded={settingsOpen} aria-controls="scan-settings-form" onClick={()=>setSettingsOpen(v=>!v)}>{settings.amount.toLocaleString()} USDC · {settingsOpen?'접기':'변경'}</button></div><form id="scan-settings-form" onSubmit={filter}><label>거래 금액<div className="field"><input aria-label="거래 금액" required type="number" min="10" max="100000" step=".01" value={amount} onChange={e=>setAmount(e.target.value)}/><span>USDC</span></div></label>{!isFutures&&<label>최소 예상 순차익<div className="field"><input aria-label="최소 예상 순차익" required type="number" min="0" max="100000" step=".01" value={min} onChange={e=>setMin(e.target.value)}/><span>USDC</span></div></label>}<label>DEX 한쪽 최대 체결가 차이<div className="field"><input aria-label="DEX 한쪽 최대 체결가 차이" required type="number" min="0.01" max="99.99" step=".01" value={impact} onChange={e=>setImpact(e.target.value)}/><span>%</span></div><small>풀 현물가 대비 불리한 차이로, 풀 수수료를 포함해요.</small></label>{!isFutures&&<label className="switchLine"><span>내 지갑으로 실행 가능</span><input type="checkbox" checked={own} onChange={e=>setOwn(e.target.checked)}/><i/></label>}<button className="apply">조건 적용</button>{settingsNote&&<small role="status">{settingsNote}</small>}</form><div className="scanCounts"><b>{snapshot?.mode||'이번 스캔'}</b>{snapshot?.depthCoverage&&<p>DEX 매수·매도 중 한 방향 이상 <b>{snapshot.depthCoverage.passed.toLocaleString()}개 통과</b> · {snapshot.depthCoverage.excluded.toLocaleString()}개 제외</p>}{isFutures&&<p>선물 진입 갭은 거래소 최우선 호가 잔량과 DEX 풀 깊이로 확인합니다. 신규 갭에는 1% 이상을 기록해요.</p>}<p>현물 예비 후보 {snapshot?.candidateCount??'—'}개 · 정밀 조회 {snapshot?.tested??'—'}개</p><p>목록 기준가 수신 {coverage?.referenceContracts?.toLocaleString()??'—'} / {coverage?.contracts?.toLocaleString()??'—'}개 컨트랙트</p>{registry&&<><p>이번 주기 DEX 가격 확인 <b>{registry.pricedPools.toLocaleString()} / {registry.registeredPools.toLocaleString()}개 풀</b></p><small>온체인 {reads.reduce((n,c)=>n+c.priced,0).toLocaleString()}개 · 풀 목록 조사 {registry.checkedContracts.toLocaleString()} / {registry.contracts.toLocaleString()}개 컨트랙트</small>{registry.factories&&<small>팩토리 조회 {registry.factories.checkedContracts.toLocaleString()}개 · 이번 주기 풀 가격을 확보한 토큰 {registry.pricedContracts.toLocaleString()}개 컨트랙트</small>}</>}<p>최근 시세 수집 {snapshot?tm(snapshot.at)+' KST':'대기 중'}{snapshot&&now-snapshot.at>45000?' · 지연':''}</p><small>{snapshot?.intervalMs===30000?'PC에서 30초마다 지원 토큰과 등록 풀을 확인합니다.':'클라우드에서 시세를 조회합니다.'} 정밀 견적은 후보별로 확인합니다. PC가 꺼지면 백그라운드 기록은 시간당 한 번입니다.</small></div></aside></div>}
 <section className="feeds"><div className="panelHead"><h2>데이터 소스</h2><span className="secondary">{active.length}개 응답</span></div><div className="feedGrid">{sources.map(s=><div className="feed" key={s.id}><div><strong>{s.name}</strong><small><i className={s.ok?'greenDot':'greyDot'}/>{s.ok?Number(s.count||0).toLocaleString()+'개 수신':'수신 대기'}</small></div></div>)}</div><p className="sourceNote">빗썸 KRW 호가는 시세 관찰에 사용합니다. 실행 경로는 같은 자산임을 확인한 뒤 호가 잔량과 환전·출금·브리지·가스 비용을 반영합니다. 이동 중 가격은 변할 수 있습니다.</p></section>
 <footer><span>Gapdesk</span><span>Ethereum · BNB Chain · Base · Arbitrum</span></footer></main>
 <dialog ref={modalRef} onCancel={e=>{e.preventDefault();close()}}><div className="dialogHead"><h2>{walletOpen?'내 지갑':selected?'경로 확인':''}</h2><button className="iconButton" aria-label="닫기" disabled={acting} onClick={close}><X size={20}/></button></div>
 {walletOpen?<><div className="dialogBody"><Wallet size={28}/><h3>{address?address.slice(0,8)+'…'+address.slice(-6):'브라우저 지갑 연결'}</h3><p>계정 주소로 지원 체인의 USDC·가스 토큰 잔액을 조회합니다. 거래를 실행할 때 지갑에서 요청을 확인하고 서명합니다.</p>{address&&Object.entries(balances).map(([id,b])=><p key={id}>{chainName(Number(id))} · {format(b.usdc)} USDC · {format(b.eth,5)} {chains[id]?.gas}</p>)}{note&&<p role="status" className="message">{note}</p>}</div><button className="apply" onClick={address?close:wallet}>{address?'확인':'지갑에서 연결'}</button></>:selected?<><div className="dialogBody"><h3>{selected.symbol}</h3><QualifiedPair r={selected}/><p>{format(selected.budget)} USDC 기준 · 예상 순차익 <b>+{format(selected.profit)} USDC</b></p><p>{chainName(selected.from)} · {selected.bridge||'직접 전송'} · {chainName(selected.to)}{selected.duration>0?' · 브리지 약 '+Math.ceil(selected.duration/60)+'분':''}</p>{selected.depthChecks?.map((d:Row)=><p key={d.side}>DEX {d.side==='buy'?'매수':'매도'} · 풀 예상 불이익 {format(d.poolImpactPct,3)}% · 라우터 최소 수령량 기준 {format(d.quoteImpactPct,3)}%</p>)}<div className="addressList">{selected.fromToken&&<ContractCopy item={{chain:selected.from,token:selected.fromToken}}/>}{selected.toToken&&(selected.to!==selected.from||selected.toToken!==selected.fromToken)&&<ContractCopy item={{chain:selected.to,token:selected.toToken}}/>}</div><p>예상 도착 {format(selected.arrival,6)} {selected.symbol||'ETH'} · 예상 매도 대금 {format(selected.proceeds)} USDC · 별도 가스 등 {format(selected.cost)} USDC</p><div className="steps">{routeSteps.map((s:Row,i:number)=><div key={i} className={index===i?'current':''}><span>{i<index?<Check size={14}/>:i+1}</span>{s.name}</div>)}</div>
 {current&&step?.manual?<p>{step.info} <a target="_blank" rel="noreferrer" href={venuePage(selected,step.manual===selected.buy)}>거래소 열기 <ArrowUpRight size={13}/></a></p>:<p>각 단계의 견적을 다시 확인합니다. 브리지 이동 중 매도 가격이 바뀌면 다음 단계가 중단될 수 있습니다.</p>}
 {current?.pending&&<p><a target="_blank" rel="noreferrer" href={(chains[current.pending.from]?.explorer+'/tx/')+current.pending.hash}>트랜잭션 확인 <ArrowUpRight size={14}/></a></p>}
 {jobNote&&<p className="message" role="status">{jobNote}</p>}</div>
 {step||!current?<button className="apply" onClick={act} disabled={acting}>{acting?'확인 중…':!current?'최신 견적으로 경로 확인':current.pending?'체결 상태 확인':step?.manual?'거래소에서 완료했어요':'지갑에서 승인 또는 실행'}</button>:<button className="apply" onClick={()=>{job(null);close()}}>경로 완료</button>}
 {current&&step&&(!current.pending||current.review)&&<button className="stop" disabled={acting} onClick={()=>{job(null);close()}}>경로 추적 종료</button>}</>:null}</dialog></>
}


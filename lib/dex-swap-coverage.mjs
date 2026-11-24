import {dexVenues} from './dex-venues.mjs';

// Describe the scope of each decoder separately from the evidence collected in production.
const scopes={
  uniswap:'V2 · V3 · V4 PoolManager',aero:'Slipstream · Solidly 계열',curve:'StableSwap TokenExchange',
  pancakeswap:'V2 · V3 · Infinity CL/Bin (BSC·Base)',balancer:'V2 Vault · V3 Vault (Ethereum·Arbitrum·Base)',sushiswap:'V2 · V3',
  maverick:'V2 PoolSwap',syncswap:'Classic · Stable',dragonswap:'V2 · V3 호환 풀',traderjoe:'V2 호환 · Liquidity Book',
  velodrome:'Solidly · Slipstream',aerodrome:'Solidly · Slipstream',camelot:'V2 호환 · Algebra',
  cetus:'Sui CLMM SwapEvent',etherex:'V2 · 집중유동성 호환 풀',hyperswap:'V2 · V3',katana:'V2 · V3',
  pangolin:'V2 · 집중유동성 호환 풀',quickswap:'V2 · Algebra',raydium:'CPMM · CLMM',
  saucerswap:'V1 · V2 호환 풀',sparkdex:'V2 · V3 호환 풀',sunswap:'SunSwap V2 · V3 호환 풀',
  thena:'Solidly · Fusion',thruster:'V2 · V3 호환 풀',xswap:'V2 · V3 호환 풀',agni:'V3 호환 풀',
  ambient:'Scroll CrocSwap',apeswap:'V2 호환 풀',bakeryswap:'V2 호환 풀',bancor:'V3 Network 경로 체결',
  biswap:'V2 호환 풀',dooar:'V2 호환 풀',duality:'Neutron DEX 유동성 풀 체결',
  ekubo:'Starknet Core Swapped',enosys:'V2 · V3 호환 풀',fluid:'T1 Swap',fstswap:'V2 호환 풀',
  hydrex:'Solidly · Algebra',hyperion:'Aptos SwapEventV3',kayen:'V2 · V3 호환 풀',kodiak:'V2 · V3 호환 풀',
  mento:'Celo Broker · V2 호환 풀',meteora:'DLMM · DAMM V2',merchantmoe:'V2 호환 · Liquidity Book',
  momentum:'Sui CLMM SwapEvent',orca:'Whirlpool',osmosis:'GAMM · token_swapped',projectx:'V3 호환 풀',
  shadow:'Solidly · 집중유동성 호환 풀',stellarx:'Stellar Classic 공용 LP 체결 (Horizon)',
  swappi:'V2 호환 풀',tinyman:'Algorand V2 · 라우터 내부 스왑',vvsfinance:'V2 · V3 호환 풀',
  minswap:'V2 단일 풀·단일 주문 exact-in/out (2블록 확인)',xrpl:'확정 원장별 주문장 종가',xexchange:'공식 라우터 등록 페어 · shard 1', 'rhea-finance':'Ref AMM · DCL 체결',hydration:'Omnipool · StableSwap · XYK · LBP',stonfi:'블록 구간별 스왑',hyperliquid:'현물 주문장 체결 (연결 중)',
};
const rpcChains=new Set(['seiv2','kaia','ronin','cronos','conflux','chiliz','xdc','hedera','tron','blast','worldchain','tempo','robinhood','arc','elysium']);
const providers={sui:'Sui GraphQL 이벤트',aptos:'Aptos 원장 트랜잭션',algorand:'Algod 블록',solana:'SQD 프로그램 명령',starknet:'Starknet RPC 이벤트',
  cardano:'Koios 원장 UTxO·리디머',xrpl:'XRPL 노드 book_changes',multiversx:'MultiversX 확정 샤드 블록',osmosis:'CometBFT 블록 결과',neutron:'CometBFT 블록 결과',stellar:'Horizon LP 체결',near:'NEARData 블록·실행 결과',hydration:'SQD 블록 아카이브',ton:'STON.fi 체결 API',hyperliquid:'HyperCore WebSocket'};
const specialModes={xrpl:'aggregate',stellarx:'ledger',stonfi:'export',hydration:'archive',hyperliquid:'orderbook'};
const scopeChains={aero:['base','ethereum','arbitrum','optimism','ink','unichain','soneium']};
/**
 * @param {{venue:string,chain:string,at:number,protocol:string,pool:string}[]} receipts
 * @param {{chain:string,venue?:string,at?:number,error?:string,head?:number,processed?:number,backlog?:boolean,lastQuoteAt?:number}[]} streams
 */
export function dexSwapCoverage(receipts=[],streams=[]){
  return dexVenues.map(venue=>{
    const chains=scopeChains[venue.id]??venue.chains;
    const mode=specialModes[venue.id]??(scopes[venue.id]?'direct':'index');
    const scope=scopes[venue.id]??(mode==='state'?'Omnipool 상태 조회':'풀·거래 인덱스 조회');
    const evidence=receipts.filter(r=>r.venue===venue.id&&chains.includes(r.chain)).sort((a,b)=>b.at-a.at);
    const feeds=scopes[venue.id]?streams.filter(s=>chains.includes(s.chain)&&(!s.venue||s.venue===venue.id)):[];
    const transport=['direct','ledger','archive','export','orderbook','aggregate'].includes(mode)?[...new Set(chains.map(c=>providers[c]??(rpcChains.has(c)?'노드 RPC 로그':'SQD 원본 로그')))].join(' · '):'';
    return {id:venue.id,name:venue.name,mode,scope,chains,transport,evidence,feeds};
  });
}

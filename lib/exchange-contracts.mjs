import {strictContractKey} from './contract-identity.mjs';
import {NATIVE} from './assets.js';

// These names come from each venue's own currency-network records.
const chains={
  htx:{ETH:1,BSC:56,SOLANA:'solana',BASE:8453,TRX:'tron',ARB:42161,MATIC:137,SUI:'sui',AVAXCCHAIN:43114,
    CHZ2:88888,NEAR:'near',TON:'ton',KLAY:8217,ADA:'cardano',CELO:42220,OPTIMISM:10,ROBINHOODCHAIN:4663,
    LINEAETH:59144,ZKSYNCERA:324,APTOS:'aptos',SONIC:146,BTC:'bitcoin'},
  coinbaseexchange:{ethereum:1,base:8453,solana:'solana',arbitrum:42161,optimism:10,polygon:137,avacchain:43114,
    tempo:4217,aptos:'aptos',bsc:56,sui:'sui',unichain:130,monad:143,bitcoin:'bitcoin'},
  gate:{ETH:1,BSC:56,BASEEVM:8453,ARBEVM:42161,OPETH:10,MATIC:137,AVAX_C:43114,SOL:'solana',TRX:'tron',BTC:'bitcoin',
    SUI:'sui',SUINEW:'sui',TON:'ton',APT:'aptos',ADA:'cardano',NEAR:'near',ALGO:'algorand',EGLD:'multiversx',STRKETH:'starknet',
    CHZ2:88888,KAIA:8217,ZKSERA:324,LINEAETH:59144,MNT:5000,BERA:80094,FTM:250,CELO:42220,S:146,RON:2020,
    HYPE:999,MODEETH:34443,ROBINHOOD:4663,SEIEVM:1329,SCROLLETH:534352,MON:143,FLR:14,OPBNB:204,
    DOGE:'dogecoin',LTC:'litecoin',BCH:'bitcoin-cash',XRP:'xrpl'},
  kucoin:{eth:1,base:8453,arbitrum:42161,bsc:56,optimism:10,matic:137,avaxc:43114,btc:'bitcoin',sol:'solana',
    xrp:'xrpl',doge:'dogecoin',ltc:'litecoin',ada:'cardano',bchn:'bitcoin-cash',trx:'tron',sui:'sui',aptos:'aptos',
    ton:'ton',ton2:'ton',near:'near',egld:'multiversx',algo:'algorand',starknet:'starknet',kcc:321,klay:8217,
    robinhood:4663,linea:59144,zksync2:324,hype:999,bera:80094,celo:42220,movr:1285,scroll:534352,blast:81457,
    ronin:2020,seievm:1329,monad:143,sonic:146},
  bitget:{ETH:1,ERC20:1,BASE:8453,ArbitrumOne:42161,BEP20:56,BSC:56,Optimism:10,OPTIMISM:10,Polygon:137,POLYGON:137,
    'AVAXC-Chain':43114,BTC:'bitcoin',SOL:'solana',XRP:'xrpl',DOGE:'dogecoin',LTC:'litecoin',Cardano:'cardano',BCH:'bitcoin-cash',
    TRX:'tron',TRC20:'tron',SUI:'sui',TON:'ton',Aptos:'aptos',NEARProtocol:'near',Starknet:'starknet',Elrond:'multiversx',
    Morph:2818,Kaia:8217,zkSyncEra:324,Fantom:250,CELO:42220,RONIN:2020,LINEA:59144,OASYS:248,SONIC:146,HYPE:999,
    BERA:80094,Robinhood:4663,SEIEVM:1329,Monad:143,CronosChain:25,Blast:81457,SCROLL:534352,MODE:34443}
};
const native={1:'ETH',8453:'ETH',42161:'ETH',56:'BNB',10:'ETH',137:'POL',43114:'AVAX',bitcoin:'BTC',solana:'SOL',
  xrpl:'XRP',dogecoin:'DOGE',litecoin:'LTC',cardano:'ADA','bitcoin-cash':'BCH',tron:'TRX',sui:'SUI',aptos:'APT',
  near:'NEAR',algorand:'ALGO',multiversx:'EGLD',321:'KCS',8217:'KAIA',324:'ETH',59144:'ETH',5000:'MNT',80094:'BERA',
  250:'FTM',42220:'CELO',146:'S',2020:'RON',999:'HYPE',143:'MON'};

export function exchangeContract(venue,network,address,symbol){
  const chain=Object.hasOwn(chains[venue]??{},network)?chains[venue][network]:null;
  if(!chain)return null;
  if(address===null||address===''||address===NATIVE){
    return native[chain]===symbol?{chain,token:NATIVE,native:true}:null;
  }
  const key=strictContractKey({chain,token:address});
  return key?{chain,token:key.slice(key.indexOf(':')+1)}:null;
}

// A failed bulk request may reuse identity, never transfer permissions or fees.
export function createIdentityCache(){
  const cache=new Map();
  return (venue,records,id,parse,time,now=Date.now())=>{
    if(Array.isArray(records)&&records.length&&time>now-7200000&&time<=now+5000){
      const live=new Map();
      for(const record of records){
        const symbol=id(record);
        if(!symbol)continue;
        live.set(symbol,live.has(symbol)?[]:parse(record,symbol));
      }
      cache.set(venue,{time,bySymbol:new Map([...live].map(([symbol,nets])=>[symbol,nets.map(({chain,token,native})=>({
        chain,token,...(native?{native:true}:{}),deposit:false,withdraw:false,depositOpen:null,withdrawOpen:null
      }))]))});
      if(now-time<45000)return {time,bySymbol:live};
    }
    const old=cache.get(venue);
    return old&&now-old.time<7200000?old:{time:0,bySymbol:new Map()};
  };
}

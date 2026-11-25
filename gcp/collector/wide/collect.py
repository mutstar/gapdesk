"""Read-only, independently paced public CCXT adapters for the GCP collector."""
import asyncio
import email.utils
import json
import logging
import math
import os
import re
import sys
import time
from pathlib import Path

import ccxt.async_support as ccxt
from regional import regional

OUT = Path(os.getenv("GAPDESK_WIDE_DIR", "/var/lib/gapdesk/cex-wide"))
LOAD = asyncio.Semaphore(2)
REQUEST = asyncio.Semaphore(28)
NETWORK = {"ETH": 1, "ERC20": 1, "BSC": 56, "BEP20": 56, "BASE": 8453, "ARBITRUM": 42161,
           "ARBITRUMONE": 42161, "OPTIMISM": 10, "POLYGON": 137, "AVAXC": 43114, "SOL": "solana", "TRX": "tron"}
NATIVE_SPOT = {"kucoin", "gate", "bitget"}
PRIORITY = ["binance", "okx", "bybit", "upbit", "mexc", "gate", "kraken", "coinbase", "coinone", "htx", "bitmart", "coinex"]
now_ms = lambda: int(time.time() * 1000)


def number(value):
    try:
        n = float(value)
        return n if math.isfinite(n) and n > 0 else None
    except (ValueError, TypeError, OverflowError):
        return None


def write(name, data):
    target = OUT / (name + ".json")
    tmp = target.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    tmp.replace(target)


def chains(currency):
    unique = {}
    networks=currency.get("networks") if isinstance(currency,dict) else None
    for key, n in (networks if isinstance(networks,dict) else {}).items():
        if not isinstance(n,dict):continue
        chain = NETWORK.get(str(n.get("network") or key).upper())
        info = n["info"] if isinstance(n.get("info"),dict) else {}
        ca = n.get("contract") or next((info.get(k) for k in ("contractAddress", "contract_address", "ctAddr", "contract") if info.get(k)), None)
        if not chain or not isinstance(ca, str):
            continue
        if isinstance(chain, int):
            if not re.fullmatch("0x[0-9a-fA-F]{40}", ca) or int(ca[2:], 16) == 0:
                continue
            ca = ca.lower()
        unique[chain, ca] = [chain, ca]
    return list(unique.values())


def canonical(adapter):
    return {"binancecoinm": "binance", "binanceusdm": "binance", "kucoinfutures": "kucoin"}.get(adapter, adapter)


def mode_for(adapter, m):
    if m.get("active") is False:
        return None
    venue = canonical(adapter)
    if m.get("spot"):
        if adapter in ("binanceusdm", "binancecoinm", "kucoinfutures"):
            return None
        if venue in NATIVE_SPOT and m["quote"] in ("USDT", "USDC") or venue=="bithumb" and m["quote"]=="KRW":
            return None
        return "spot"
    if m.get("swap"):
        if adapter == "binance" or venue in ("binance", "bitget", "kucoin") and m.get("linear") and m["quote"]=="USDT" and m.get("settle")=="USDT":
            return None
        return "inverse" if m.get("inverse") else "swap"
    return None


def response_time(ex):
    h = {k.lower(): v for k, v in (ex.last_response_headers or {}).items()}
    try:
        at = int(email.utils.parsedate_to_datetime(h["date"]).timestamp()*1000)
        age = max(float(h.get("age", 0)), 0)
        return min(at, int(now_ms()-1000*age)) if at<=now_ms()+5000 else 0
    except (ValueError, KeyError, TypeError, OverflowError):
        return 0


def reason(e):
    if isinstance(e, ccxt.RateLimitExceeded): return "요청 제한"
    if isinstance(e, (ccxt.AuthenticationError, ccxt.PermissionDenied)): return "인증·접근 제한"
    if isinstance(e, ccxt.NotSupported): return "공개 조회 미지원"
    if isinstance(e, (ccxt.RequestTimeout, TimeoutError)): return "응답 지연"
    if isinstance(e, ccxt.NetworkError): return "API 연결 실패"
    return "피드 오류"


class Venue:
    def __init__(self, ex):
        self.ex = ex
        self.groups = {}
        self.currencies = {}
        self.market_time = 0
        self.cursor = {}
        self.latest = {}
        self.failures = {}
        self.retry = {}
        self.rotate_until = {}
        self.anchor_cache = {}
        self.anchor_cursor = 0

    async def catalog(self):
        async with LOAD:
            try:
                await asyncio.wait_for(self.ex.load_markets(reload=bool(self.market_time)), 35)
            except (ccxt.ExchangeError,ccxt.NetworkError):
                if self.ex.has.get("fetchCurrencies") is not True: raise
                self.ex.has["fetchCurrencies"]=False
                try:await asyncio.wait_for(self.ex.load_markets(reload=True),20)
                finally:self.ex.has["fetchCurrencies"]=True
        self.currencies = {k: n for k,c in self.ex.currencies.items() if (n:=chains(c))}
        groups = {}
        for sym,m in self.ex.markets.items():
            kind = mode_for(self.ex.id,m)
            if kind and m.get("base") and m.get("quote") and len(sym)<120:
                groups.setdefault(kind,[]).append(sym)
        self.groups = groups
        self.market_time = now_ms()
        # Ticker parsers use unified market and currency objects. Release bulky
        # original catalogue payloads and omit unmonitored option chains.
        keep = {k:m for k,m in self.ex.markets.items() if m.get("spot") or m.get("swap")}
        for m in keep.values():
            info = m.get("info")
            if isinstance(info,dict):
                m["info"] = {k:v for k,v in info.items() if isinstance(v,(str,bool,int,float)) and k in
                             ("symbol","instId","contractSize","contract_type","type","status","priceScale","volScale","category")}
        self.ex.markets.clear()
        self.ex.markets.update(keep)
        self.ex.markets_by_id = {k:[keep[m["symbol"]] for m in ms if m.get("symbol") in keep] for k,ms in self.ex.markets_by_id.items() if any(m.get("symbol") in keep for m in ms)}
        self.ex.symbols = list(keep)
        self.ex.ids = list(self.ex.markets_by_id)
        for c in self.ex.currencies.values():
            if not isinstance(c,dict):continue
            c["info"] = None
            for n in (c.get("networks") or {}).values():
                if isinstance(n,dict):n["info"]=None

    async def books(self, syms):
        data = {}
        for i in range(0,len(syms),60):
            books = await self.ex.fetch_order_books(syms[i:i+60],1)
            for sym,b in books.items():
                if b.get("asks") and b.get("bids"):
                    a,q=b["asks"][0][:2]; p,r=b["bids"][0][:2]
                    data[sym] = dict(ask=a,bid=p,askVolume=q,bidVolume=r,timestamp=b["timestamp"])
        return data

    async def quotes(self, mode, symbols):
        ex=self.ex
        params={"type":"spot" if mode=="spot" else "swap"}
        if mode!="spot": params["subType"]="inverse" if mode=="inverse" else "linear"
        if ex.id=="upbit":
            # One batched top-of-book request, symbol keys resolved by the exchange catalogue.
            ids={ex.markets[s]["id"]:s for s in symbols}
            data={}
            keys=list(ids)
            for start in range(0,len(keys),90):
                raw=await ex.publicGetOrderbook({"markets":",".join(keys[start:start+90]),"count":1})
                for item in raw:
                    sym=ids.get(item.get("market"))
                    levels=item.get("orderbook_units") or []
                    if sym and levels:
                        top=levels[0]
                        data[sym]=dict(ask=top.get("ask_price"),bid=top.get("bid_price"),askVolume=top.get("ask_size"),bidVolume=top.get("bid_size"),timestamp=item.get("timestamp"))
            return data
        if self.rotate_until.get(mode,0)>now_ms():
            return await self.rotating_quotes(mode,symbols)
        if ex.id in ("binance","binanceus","binanceusdm","binancecoinm","mexc") and ex.has.get("fetchBidsAsks") and (ex.id!="mexc" or mode=="spot"):
            return await ex.fetch_bids_asks(None,params)
        if ex.has.get("fetchTickers") is True:
            return await ex.fetch_tickers(None,params)
        return await self.rotating_quotes(mode,symbols)

    async def rotating_quotes(self,mode,symbols):
        ex=self.ex
        start=self.cursor.get(mode,0)
        batch=(symbols[start:]+symbols[:start])[:5]
        self.cursor[mode]=(start+len(batch))%len(symbols)
        if ex.has.get("fetchOrderBooks"): return await self.books(batch)
        data={}
        for sym in batch:
            if ex.has.get("fetchOrderBook"):
                b=await ex.fetch_order_book(sym)
                if b.get("asks") and b.get("bids"):
                    data[sym]=dict(ask=b["asks"][0][0],bid=b["bids"][0][0],askVolume=b["asks"][0][1],bidVolume=b["bids"][0][1],timestamp=b.get("timestamp") or response_time(ex))
            elif ex.has.get("fetchTicker"):
                data[sym]=await ex.fetch_ticker(sym)
        return data

    def parse(self,mode,symbols,tickers):
        ex=self.ex
        received=response_time(ex)
        rows={}
        for sym in symbols:
            t=tickers.get(sym)
            if not t: continue
            m=ex.markets[sym]
            a,b=number(t.get("ask")),number(t.get("bid"))
            book=bool(b and a and a>=b)
            last=number(t.get("last"))
            if not book and not last: continue
            published=number(t.get("timestamp"))
            at=int(published or (received if book else 0))
            if received: at=min(at,received)
            if not now_ms()-45000<at<=now_ms()+5000: continue
            size=number(m.get("contractSize")) or 1
            aq,bq=number(t.get("askVolume")),number(t.get("bidVolume"))
            precision=(m.get("precision") or {}).get("amount")
            step=number(precision)
            if ex.precisionMode==ccxt.DECIMAL_PLACES and isinstance(precision,(int,float)) and 0<=precision<=30:
                step=10**(-precision)
            if ex.precisionMode not in (ccxt.DECIMAL_PLACES,ccxt.TICK_SIZE): step=None
            if m.get("inverse"): aq=bq=step=None
            rows[sym]=[m["base"],m["quote"],m.get("settle"),str(m["id"]),a if book else None,b if book else None,
                       aq*size if aq else None,bq*size if bq else None,step*size if step else None,at,last]
        return rows

    async def anchors(self, mode, symbols):
        if mode!="swap" or self.ex.id not in ("okx","bybit"): return
        api=self.ex
        contracts=[api.markets[s] for s in symbols if api.markets[s].get("settle")=="USDT" and api.markets[s]["quote"]=="USDT"]
        if not contracts:return
        async def one(m):
            base=m["base"]
            if self.anchor_cache.get(m["id"],(0,))[0]>now_ms():return
            if not re.fullmatch("[A-Za-z0-9]+",base):return
            try:
                if api.id=="okx":
                    if m["id"]!=base+"-USDT-SWAP":return
                    j=await api.publicGetMarketIndexComponents({"index":base+"-USDT"})
                    parts=j["data"]["components"]
                else:
                    if m["id"]!=base+"USDT":return
                    url="https://api.bybit.com/v5/market/index-price-components?indexName="+m["id"]
                    j=await api.fetch(url)
                    if j["result"]["indexName"]!=m["id"]:return
                    parts=j["result"]["components"]
                ids=set()
                for c in parts:
                    venue=str(c.get("exchange") or c.get("exch")).lower()
                    if not number(c.get("weight") or c.get("wgt")) or float(c.get("multiplier",1))!=1:continue
                    pair=c.get("spotPair") or c.get("symbol")
                    if pair not in (base+"USDT",base+"/USDT",base+"-USDT",base+"_USDT"):continue
                    if venue in ("gate","gateio","gate.io"):ids.add("gate:"+base+"_USDT")
                    if venue=="bitget":ids.add("bitget:"+base+"USDT")
                    if venue=="kucoin":ids.add("kucoin:"+base+"-USDT")
                self.anchor_cache[m["id"]]=(now_ms()+1800000,sorted(ids))
            except Exception:
                self.anchor_cache[m["id"]]=(now_ms()+120000,[])
        start=self.anchor_cursor
        self.anchor_cursor=(start+6)%len(contracts)
        await asyncio.gather(*(one(m) for m in (contracts[start:]+contracts[:start])[:6]))

    async def scan(self):
        for mode,syms in self.groups.items():
            if self.retry.get(mode,0)>now_ms(): continue
            try:
                async with REQUEST:
                    ticks=await asyncio.wait_for(self.quotes(mode,syms),15 if self.ex.id=="upbit" else 10)
                rows=self.parse(mode,syms,ticks)
                self.latest.setdefault(mode,{}).update(rows)
                self.failures[mode]=None if rows else "최신 시세 대기"
                if not rows and self.ex.has.get("fetchOrderBook"):
                    self.rotate_until[mode]=now_ms()+180000
                if mode=="swap" and self.ex.id in ("okx","bybit"):
                    self.publish()
                    try:await asyncio.wait_for(self.anchors(mode,syms),3)
                    except TimeoutError:pass
            except Exception as exc:
                self.failures[mode]=reason(exc)
                if self.ex.has.get("fetchOrderBook") and not isinstance(exc,(ccxt.RateLimitExceeded,ccxt.PermissionDenied)):
                    self.rotate_until[mode]=now_ms()+180000
                self.retry[mode]=now_ms()+60000
            self.publish()
        if not self.groups:self.publish()

    def publish(self,error=None):
        modes={}
        for mode,syms in self.groups.items():
            live={k:r for k,r in self.latest.get(mode,{}).items() if r[9]>now_ms()-45000 and k in self.ex.markets}
            self.latest[mode]=live
            modes[mode]={"total":len(syms),"rows":list(live.values()),"status":self.failures.get(mode)}
        anchors={k:v for k,(until,v) in self.anchor_cache.items() if until>now_ms() and v}
        write(self.ex.id,{"id":self.ex.id,"venue":canonical(self.ex.id),"name":self.ex.name,"time":now_ms(),"anchors":anchors,
                          "catalogAt":self.market_time,"networks":self.currencies,"modes":modes,"status":error})

    async def run(self):
        delay=15
        while True:
            start=time.monotonic()
            try:
                if not self.market_time or now_ms()-self.market_time>=3600000: await self.catalog()
                await self.scan()
                delay=15
            except Exception as exc:
                self.publish(reason(exc))
                await asyncio.sleep(delay)
                delay=min(300,delay*2)
            await asyncio.sleep(max(1,30-(time.monotonic()-start)))


def adapters(allowed=None):
    venues=[]
    for id in sorted(ccxt.exchanges,key=lambda k:(PRIORITY.index(k) if k in PRIORITY else 100,k)):
        if allowed is not None and id not in allowed:continue
        settings={"timeout":6500,"enableRateLimit":True,"enableLastHttpResponse":False,"enableLastJsonResponse":False}
        if id=="binance":settings["options"]={"fetchMarkets":{"types":["spot"]}}
        ex=getattr(ccxt,id)(settings)
        if not ex.dex and not ex.alias and (ex.has.get("spot") or ex.has.get("swap")):venues.append(Venue(ex))
    return venues


def registry(venues):
    return [{"id":v.ex.id,"venue":canonical(v.ex.id),"name":v.ex.name} for v in venues]


async def legacy_worker(python,ids):
    while True:
        child=await asyncio.create_subprocess_exec(python,__file__,"--only",*ids)
        await child.wait()
        await asyncio.sleep(30)


async def main():
    OUT.mkdir(parents=True,exist_ok=True)
    subset=sys.argv[1:2]==["--only"]
    venues=adapters(set(sys.argv[2:]) if subset else None)
    entries=registry(venues)
    if sys.argv[1:]==["--list"]:
        print(json.dumps(entries))
        return
    jobs=[]
    if not subset:
        legacy=os.getenv("GAPDESK_LEGACY_PYTHON")
        if legacy and Path(legacy).is_file():
            proc=await asyncio.create_subprocess_exec(legacy,__file__,"--list",stdout=asyncio.subprocess.PIPE)
            data,_=await proc.communicate()
            if proc.returncode==0:
                existing={e["id"] for e in entries}
                prior=[e for e in json.loads(data) if e["id"] not in existing]
                entries.extend(prior)
                if prior:jobs.append(legacy_worker(legacy,[e["id"] for e in prior]))
        for id,name in [("korbit","코빗"),("gopax","고팍스")]:
            if not any(e["id"]==id for e in entries):
                entries.append({"id":id,"venue":id,"name":name})
                jobs.append(regional(id,name,write,number,now_ms,NETWORK))
        write("registry",entries)
    try: await asyncio.gather(*(v.run() for v in venues),*jobs)
    finally: await asyncio.gather(*(v.ex.close() for v in venues),return_exceptions=True)

if __name__=="__main__":
    logging.basicConfig(level=logging.ERROR)
    asyncio.run(main())

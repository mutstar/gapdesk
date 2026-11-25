"""Domestic exchanges without a CCXT adapter, using their public spot catalogues."""
import asyncio
import email.utils
import json
import urllib.request


def fetch(url):
    req=urllib.request.Request(url,headers={"User-Agent":"Gapdesk/1.0","Accept":"application/json"})
    with urllib.request.urlopen(req,timeout=5) as res:
        data=json.load(res)
        at=int(email.utils.parsedate_to_datetime(res.headers["Date"]).timestamp()*1000)
        age=int(res.headers.get("Age","0") or 0)
        return data,at,age


async def regional(id,name,write,number,now_ms,network_ids):
    while True:
        start=now_ms()
        try:
            if id=="korbit":
                root="https://api.korbit.co.kr/v2/"
                urls=[root+"currencyPairs",root+"tickers",root+"currencies"]
            else:
                root="https://api.gopax.co.kr/"
                urls=[root+"trading-pairs",root+"tickers"]
            responses=await asyncio.gather(*(asyncio.to_thread(fetch,u) for u in urls))
            times=[min(ts,now_ms()-age*1000) if ts<=now_ms()+5000 and age>=0 else 0 for _,ts,age in responses]
            if any(t<now_ms()-45000 for t in times[:2]):raise ValueError("stale")
            rows=[];nets={}
            if id=="korbit":
                if any(r[0].get("success") is not True for r in responses):raise ValueError("feed")
                pairs={m["symbol"]:(m["baseCurrency"].upper(),m["quoteCurrency"].upper()) for m in responses[0][0]["data"] if m.get("status")=="launched"}
                prices=responses[1][0]["data"]
                for c in responses[2][0]["data"]:
                    coin=c["name"].upper()
                    for n in c.get("networkList") or []:
                        chain=network_ids.get(n.get("name"))
                        if n.get("name")=="BNB" and "smart chain" in str(n.get("fullName")).lower():chain=56
                        ca=n.get("contractAddress")
                        if chain and ca:
                            nets.setdefault(coin,[]).append([chain,ca,n.get("depositStatus")=="launched" if n.get("depositStatus") else None,
                                                           n.get("withdrawalStatus")=="launched" if n.get("withdrawalStatus") else None])
            else:
                pairs={m["name"]:(m["baseAsset"],m["quoteAsset"]) for m in responses[0][0]}
                prices=responses[1][0]
            for t in prices:
                pair=t.get("symbol") if id=="korbit" else t.get("tradingPairName")
                if pair not in pairs:continue
                a=number(t.get("bestAskPrice") if id=="korbit" else t.get("lowestAsk"))
                b=number(t.get("bestBidPrice") if id=="korbit" else t.get("highestBid"))
                if a and b and a>=b:
                    rows.append([*pairs[pair],None,pair,a,b,None,None,None,times[1],None])
            state=None if rows else ("활성 거래쌍 없음" if not pairs else "최신 호가 대기")
            modes={"spot":{"total":len(pairs),"rows":rows,"status":state}}
            write(id,{"id":id,"venue":id,"name":name,"time":now_ms(),"catalogAt":min(times),"networks":nets,"modes":modes,"status":state})
        except Exception:
            write(id,{"id":id,"venue":id,"name":name,"time":now_ms(),"networks":{},"modes":{},"status":"공개 시세 수신 대기"})
        await asyncio.sleep(max(1,30-(now_ms()-start)/1000))

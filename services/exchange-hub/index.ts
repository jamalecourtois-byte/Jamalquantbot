import ccxt from "ccxt";
import { handlePrivateConnectorRequest } from "./private-connectors.ts";
const DASHBOARD_HTML = await Bun.file(new URL("./dashboard.html", import.meta.url)).text();
const exchangeClients=new Map<string,any>();
const brokerCatalog=[
 {id:"interactive_brokers",name:"Interactive Brokers",markets:["stocks","options","futures","forex","bonds"],protocol:"TWS API / Client Portal API",status:"catalogue-only-needs-account-and-gateway"},
 {id:"oanda",name:"OANDA",markets:["forex","commodities-cfd","indices-cfd"],protocol:"v20 REST / streaming",status:"catalogue-only-needs-api-token"},
 {id:"alpaca",name:"Alpaca",markets:["stocks","options","crypto"],protocol:"Trading API v2",status:"catalogue-only-needs-api-keys"},
 {id:"tradier",name:"Tradier",markets:["stocks","options"],protocol:"Brokerage API",status:"catalogue-only-needs-oauth"},
 {id:"saxo",name:"Saxo Bank",markets:["stocks","forex","options","futures","bonds"],protocol:"OpenAPI",status:"catalogue-only-needs-oauth"},
 {id:"ig",name:"IG",markets:["forex","indices-cfd","shares-cfd","commodities-cfd"],protocol:"REST / streaming",status:"catalogue-only-needs-api-key"},
 {id:"capital_com",name:"Capital.com",markets:["forex","indices-cfd","shares-cfd","commodities-cfd","crypto-cfd"],protocol:"REST / WebSocket",status:"catalogue-only-needs-api-key"},
 {id:"ctrader",name:"cTrader",markets:["forex","cfd"],protocol:"Open API / OAuth",status:"catalogue-only-needs-oauth"},
 {id:"metatrader5",name:"MetaTrader 5",markets:["forex","cfd","futures"],protocol:"MT5 terminal bridge / Expert Advisor",status:"catalogue-only-needs-user-side-bridge"},
 {id:"schwab",name:"Charles Schwab",markets:["stocks","options","futures"],protocol:"Trader API / OAuth",status:"catalogue-only-needs-developer-app"},

];
const allowed = new Set(ccxt.exchanges);
const json = (data: unknown, status=200) => new Response(JSON.stringify(data), {status,headers:{"content-type":"application/json; charset=utf-8","access-control-allow-origin":"*","cache-control":"no-store"}});
const durations:Record<string,number>={"1m":60000,"3m":180000,"5m":300000,"15m":900000,"30m":1800000,"1h":3600000,"2h":7200000,"4h":14400000,"6h":21600000,"8h":28800000,"12h":43200000,"1d":86400000,"3d":259200000,"1w":604800000,"1M":2678400000};
Bun.serve({port:Number(Bun.env.PORT||3000),websocket:{
 open(ws:any){
  void (async()=>{
   const {exchangeId,symbol}=ws.data||{};
   const pro=(ccxt as any).pro;
   const Constructor=pro?.[exchangeId];
   if(typeof Constructor!=="function")throw new Error("Flux WebSocket CCXT Pro indisponible pour "+exchangeId);
   const stream=new Constructor({enableRateLimit:true,timeout:20000});
   ws.data.stream=stream;
   await stream.loadMarkets();
   if(!stream.markets[symbol])throw new Error("Marché indisponible : "+symbol);
   ws.send(JSON.stringify({ok:true,type:"connected",exchange:exchangeId,symbol,timestamp:Date.now()}));
   while(ws.readyState===1){
    const book=await stream.watchOrderBook(symbol,10);
    if(ws.readyState!==1)break;
    ws.send(JSON.stringify({ok:true,type:"orderbook",exchange:exchangeId,symbol,timestamp:book.timestamp||Date.now(),bids:(book.bids||[]).slice(0,10),asks:(book.asks||[]).slice(0,10)}));
   }
  })().catch((error:any)=>{
   try{if(ws.readyState===1)ws.send(JSON.stringify({ok:false,type:"error",error:error instanceof Error?error.message:"Erreur WebSocket"}));}catch{}
   try{ws.close(1011,"Flux indisponible");}catch{}
  }).finally(async()=>{try{await ws.data?.stream?.close();}catch{}});
 },
 close(ws:any){try{ws.data?.stream?.close();}catch{}}
},async fetch(req,server){
 const privateResponse = await handlePrivateConnectorRequest(req);
 if (privateResponse) return privateResponse;
 const u=new URL(req.url);
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers:{"access-control-allow-origin":"*","access-control-allow-methods":"GET,OPTIONS","access-control-allow-headers":"content-type"}});
 if(req.method!=="GET")return json({ok:false,error:"Méthode non autorisée"},405);
 if(u.pathname==="/"||u.pathname==="/dashboard")return new Response(DASHBOARD_HTML,{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store"}});
 if(u.pathname==="/ws/orderbook"){
  const id=(u.searchParams.get("exchange")||"").toLowerCase(),symbol=(u.searchParams.get("symbol")||"").trim();
  if(!allowed.has(id))return json({ok:false,error:"Exchange non pris en charge par CCXT"},400);
  if(!/^[A-Z0-9]{2,20}\/[A-Z0-9]{2,20}(:[A-Z0-9]{2,20})?$/.test(symbol))return json({ok:false,error:"Symbole invalide. Format attendu : BTC/USDT"},400);
  if(typeof (ccxt as any).pro?.[id]!=="function")return json({ok:false,error:"Flux CCXT Pro indisponible pour cet exchange"},501);
  const upgraded=server.upgrade(req,{data:{exchangeId:id,symbol,stream:null}});
  return upgraded?undefined:json({ok:false,error:"Impossible d'ouvrir le flux WebSocket"},500);
 }
 if(u.pathname==="/health")return json({ok:true,service:"JamalQuant Exchange Hub",mode:"public-read-only",tradingEnabled:false,ccxtVersion:ccxt.version,exchangeCount:ccxt.exchanges.length});
 if(u.pathname==="/connectors")return json({ok:true,library:"CCXT",count:ccxt.exchanges.length,connectors:ccxt.exchanges.map((id:string)=>({id,name:id==="myokx"?"OKX Europe (EEE)":id==="okx"?"OKX Global":id,region:id==="myokx"?"EEA":id==="okx"?"Global":null,publicMarketData:"exchange-dependent",ohlcv:"requires-market-check",privateAccount:false,placeOrders:false,status:"catalogued-not-yet-validated"})),brokerCount:brokerCatalog.length,brokers:brokerCatalog,limitations:"Les courtiers natifs sont répertoriés, mais non connectés. Les accès privés et les ordres exigent une intégration API et des identifiants autorisés par plateforme."});
 if(u.pathname==="/resolve-symbol"){
  const id=(u.searchParams.get("exchange")||"").toLowerCase(),asset=(u.searchParams.get("asset")||"").toUpperCase();
  if(!allowed.has(id))return json({ok:false,error:"Exchange non pris en charge par CCXT"},400);
  if(!/^[A-Z0-9]{2,20}$/.test(asset))return json({ok:false,error:"Actif invalide"},400);
  if(id==="binance")return json({ok:true,exchange:id,asset,symbol:asset+"/USDT",market:"spot",source:"binance-public-rest"});
  let ex=exchangeClients.get(id);if(!ex){const Ex=(ccxt as any)[id];ex=new Ex({enableRateLimit:true,timeout:15000});exchangeClients.set(id,ex);}
  try{await ex.loadMarkets();const preferred=["USDT","USDC","USD","EUR","BTC","ETH"];const found=preferred.map(q=>asset+"/"+q).find(pair=>!!ex.markets[pair]&&ex.markets[pair].active!==false);if(!found)return json({ok:false,error:"Aucune paire spot active trouvée pour "+asset,exchange:id},404);return json({ok:true,exchange:id,asset,symbol:found,market:ex.markets[found].type||"spot"});}
  catch(err){return json({ok:false,error:err instanceof Error?err.message:"Erreur marché"},502);}
 }
 if(u.pathname==="/ohlcv"||u.pathname==="/ticker"){
  const id=(u.searchParams.get("exchange")||"").toLowerCase(),symbol=(u.searchParams.get("symbol")||"").trim();
  if(id==="yahoo"){
   const validSymbols=new Set(["EURUSD=X","GBPUSD=X","XAUUSD=X","XAGUSD=X","CL=F","^GSPC","^IXIC","AAPL","MSFT","NVDA","AMZN"]);
   if(!validSymbols.has(symbol))return json({ok:false,error:"Symbole Yahoo non autorisé"},400);
   const requested=u.searchParams.get("timeframe")||"1m",intervalMap:Record<string,string>={"1m":"1m","5m":"5m","15m":"15m","1h":"60m","4h":"60m","1d":"1d"};
   const interval=intervalMap[requested];if(!interval)return json({ok:false,error:"Timeframe Yahoo non pris en charge"},400);
   const range=requested==="1d"?"1mo":requested==="1h"||requested==="4h"?"5d":"1d";
   try{
    const endpoint="https://query1.finance.yahoo.com/v8/finance/chart/"+encodeURIComponent(symbol)+"?range="+range+"&interval="+interval+"&includePrePost=false";
    const response=await fetch(endpoint,{headers:{"accept":"application/json","user-agent":"Mozilla/5.0 (compatible; JamalQuant/1.0)"},signal:AbortSignal.timeout(15000)});
    const payload:any=await response.json().catch(()=>({}));
    const result=payload?.chart?.result?.[0],meta=result?.meta,quote=result?.indicators?.quote?.[0];
    if(!response.ok||!result||!meta||!quote)return json({ok:false,error:payload?.chart?.error?.description||"Yahoo Finance indisponible (HTTP "+response.status+")",source:"yahoo-finance-unofficial"},502);
    const timestamps=result.timestamp||[],rows=timestamps.map((ts:number,i:number)=>[ts*1000,quote.open?.[i],quote.high?.[i],quote.low?.[i],quote.close?.[i],quote.volume?.[i]??0]).filter((row:any[])=>row.slice(0,5).every((v:any)=>Number.isFinite(Number(v))&&v!==null)&&Number(row[3])>0&&Number(row[2])>=Math.max(Number(row[1]),Number(row[4]))&&Number(row[3])<=Math.min(Number(row[1]),Number(row[4])));
    const previous=Number(meta.chartPreviousClose??meta.previousClose??0),last=Number(meta.regularMarketPrice??rows.at(-1)?.[4]);
    if(!Number.isFinite(last)||last<=0)return json({ok:false,error:"Cours Yahoo absent ou invalide",source:"yahoo-finance-unofficial"},502);
    if(u.pathname==="/ticker")return json({ok:true,exchange:id,symbol,timestamp:Number(meta.regularMarketTime||timestamps.at(-1))*1000,last,open:previous,percentage:previous>0?(last-previous)/previous*100:null,high:Number(meta.regularMarketDayHigh||Math.max(...rows.map((r:any[])=>r[2]))),low:Number(meta.regularMarketDayLow||Math.min(...rows.map((r:any[])=>r[3]))),currency:meta.currency||"USD",marketState:meta.marketState||"UNKNOWN",source:"yahoo-finance-unofficial"});
    const limit=Math.min(500,Math.max(2,Number(u.searchParams.get("limit")||60))),now=Date.now(),duration=durations[requested]||60000,closed=rows.filter((row:any[])=>row[0]+duration<=now+1000).slice(-limit);
    if(closed.length<2)return json({ok:false,error:"Moins de deux bougies clôturées disponibles",source:"yahoo-finance-unofficial"},502);
    return json({ok:true,exchange:id,symbol,timeframe:requested,count:closed.length,lastCandleTime:closed.at(-1)?.[0]||null,candles:closed,source:"yahoo-finance-unofficial",marketState:meta.marketState||"UNKNOWN",currency:meta.currency||"USD"});
   }catch(err){return json({ok:false,error:err instanceof Error?err.message:"Erreur Yahoo Finance",source:"yahoo-finance-unofficial"},502);}
  }
  if(!allowed.has(id))return json({ok:false,error:"Exchange non pris en charge par CCXT"},400);
  if(!/^[A-Z0-9]{2,20}\/[A-Z0-9]{2,20}(:[A-Z0-9]{2,20})?$/.test(symbol))return json({ok:false,error:"Symbole invalide. Format attendu : BTC/USDT"},400);
  if(id==="binance"){
   const pair=symbol.split(":")[0].replace("/","");
   if(u.pathname==="/ticker"){
    const r=await fetch("https://data-api.binance.vision/api/v3/ticker/24hr?symbol="+pair,{signal:AbortSignal.timeout(12000)}),t:any=await r.json().catch(()=>({}));
    if(!r.ok||!Number.isFinite(Number(t.lastPrice)))return json({ok:false,error:t.msg||"Binance ticker HTTP "+r.status},502);
    return json({ok:true,exchange:id,symbol,timestamp:Number(t.closeTime)||Date.now(),last:Number(t.lastPrice),bid:Number(t.bidPrice),ask:Number(t.askPrice),open:Number(t.openPrice),percentage:Number(t.priceChangePercent),high:Number(t.highPrice),low:Number(t.lowPrice),baseVolume:Number(t.volume),quoteVolume:Number(t.quoteVolume),source:"binance-public-rest"});
   }
   const timeframe=u.searchParams.get("timeframe")||"1h",limit=Math.min(500,Math.max(60,Number(u.searchParams.get("limit")||150)));
   if(!durations[timeframe])return json({ok:false,error:"Timeframe non pris en charge"},400);
   const r=await fetch("https://data-api.binance.vision/api/v3/klines?symbol="+pair+"&interval="+timeframe+"&limit="+limit,{signal:AbortSignal.timeout(15000)}),rows:any=await r.json().catch(()=>null);
   if(!r.ok||!Array.isArray(rows))return json({ok:false,error:"Binance OHLCV HTTP "+r.status},502);
   const now=Date.now(),candles=rows.filter((v:any[])=>Array.isArray(v)&&v.length>=6&&v.slice(0,6).every((x:any)=>Number.isFinite(Number(x)))&&Number(v[0])+durations[timeframe]<now&&Number(v[3])>0&&Number(v[2])>=Math.max(Number(v[1]),Number(v[4]))&&Number(v[3])<=Math.min(Number(v[1]),Number(v[4])));
   return json({ok:true,exchange:id,symbol,timeframe,count:candles.length,lastCandleTime:candles.at(-1)?.[0]||null,candles,source:"binance-public-rest"});
  }
  let ex=exchangeClients.get(id);if(!ex){const Ex=(ccxt as any)[id];ex=new Ex({enableRateLimit:true,timeout:15000});exchangeClients.set(id,ex);}
  try{
   await ex.loadMarkets();
   if(!ex.markets[symbol])return json({ok:false,error:"Marché indisponible sur cet exchange",exchange:id,symbol},404);
   if(u.pathname==="/ticker"){
    const t=await ex.fetchTicker(symbol);
    return json({ok:true,exchange:id,symbol,timestamp:t.timestamp,datetime:t.datetime,last:t.last,bid:t.bid,ask:t.ask,open:t.open,percentage:t.percentage,high:t.high,low:t.low,baseVolume:t.baseVolume,quoteVolume:t.quoteVolume,source:"exchange-public-api"});
   }
   const timeframe=u.searchParams.get("timeframe")||"1h",limit=Math.min(500,Math.max(60,Number(u.searchParams.get("limit")||150)));
   if(!durations[timeframe])return json({ok:false,error:"Timeframe non pris en charge"},400);
   if(!ex.has.fetchOHLCV)return json({ok:false,error:"OHLCV non disponible sur cet exchange"},501);
   const candles=await ex.fetchOHLCV(symbol,timeframe,undefined,limit);
   if(!Array.isArray(candles))return json({ok:false,error:"Réponse OHLCV invalide"},502);
   const now=Date.now(),clean=candles.filter((r:any[])=>Array.isArray(r)&&r.length>=6&&r.slice(0,6).every((v:any)=>Number.isFinite(Number(v)))&&Number(r[0])+durations[timeframe]-1<now-1000&&Number(r[3])>0&&Number(r[2])>=Math.max(Number(r[1]),Number(r[4]))&&Number(r[3])<=Math.min(Number(r[1]),Number(r[4])));
   return json({ok:true,exchange:id,symbol,timeframe,count:clean.length,lastCandleTime:clean.at(-1)?.[0]||null,candles:clean,source:"exchange-public-api"});
  }catch(err){console.warn("Exchange request failed",id,u.pathname,symbol,err instanceof Error?err.message:String(err));return json({ok:false,exchange:id,symbol,error:err instanceof Error?err.message:"Erreur exchange"},502);}
  finally{}
 }
 if(u.pathname==="/account"||u.pathname==="/orders")return json({ok:false,error:"Trading privé désactivé : aucune clé API ni autorisation de compte configurée.",tradingEnabled:false},403);
 return json({ok:false,error:"Route inconnue",routes:["/health","/connectors","/ticker","/ohlcv","/ws/orderbook?exchange=myokx&symbol=BTC/USDT"]},404);
}});

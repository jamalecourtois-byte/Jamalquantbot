import postgres from "postgres@3.4.7";
import { runAgentPipeline, warmNews } from "./agent-pipeline.ts";
const env=Bun.env;
if(!env.DATABASE_URL||!env.AUTO_ENGINE_SECRET)throw new Error("DATABASE_URL ou AUTO_ENGINE_SECRET manquant");
const db=postgres(env.DATABASE_URL,{max:8,idle_timeout:20,connect_timeout:10});
await db`CREATE TABLE IF NOT EXISTS sandbox_client_ledgers (telegram_user_id BIGINT PRIMARY KEY, currency TEXT NOT NULL DEFAULT 'USDT' CHECK(currency='USDT'), balance NUMERIC(24,8) NOT NULL DEFAULT 0 CHECK(balance>=0), total_credited NUMERIC(24,8) NOT NULL DEFAULT 0, total_debited NUMERIC(24,8) NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','FROZEN')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
await db`CREATE TABLE IF NOT EXISTS sandbox_client_ledger_entries (id BIGSERIAL PRIMARY KEY, telegram_user_id BIGINT NOT NULL REFERENCES sandbox_client_ledgers(telegram_user_id), entry_type TEXT NOT NULL CHECK(entry_type IN ('OPENING_VIRTUAL','CREDIT_VIRTUAL','DEBIT_VIRTUAL','PAPER_PNL')), amount NUMERIC(24,8) NOT NULL CHECK(amount>0), balance_after NUMERIC(24,8) NOT NULL CHECK(balance_after>=0), reference TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(telegram_user_id,reference))`;
await db`CREATE INDEX IF NOT EXISTS sandbox_ledger_entries_user_created_idx ON sandbox_client_ledger_entries(telegram_user_id,created_at DESC)`;

await db`CREATE TABLE IF NOT EXISTS paper_auto_portfolios (telegram_user_id BIGINT PRIMARY KEY,initial_capital NUMERIC(24,8) NOT NULL,cash NUMERIC(24,8) NOT NULL,realized_pnl NUMERIC(24,8) NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'STOPPED',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
await db`ALTER TABLE paper_auto_portfolios ADD COLUMN IF NOT EXISTS last_scan_at TIMESTAMPTZ`;
await db`CREATE TABLE IF NOT EXISTS paper_auto_positions (telegram_user_id BIGINT NOT NULL REFERENCES paper_auto_portfolios(telegram_user_id) ON DELETE CASCADE,symbol TEXT NOT NULL,market_type TEXT NOT NULL,quantity NUMERIC(30,12) NOT NULL,entry_price NUMERIC(24,10) NOT NULL,entry_fee NUMERIC(24,8) NOT NULL,mark_price NUMERIC(24,10) NOT NULL,stop_price NUMERIC(24,10) NOT NULL,target_price NUMERIC(24,10) NOT NULL,highest_price NUMERIC(24,10) NOT NULL,initial_risk NUMERIC(24,10) NOT NULL,last_candle_time BIGINT NOT NULL,cooldown_until TIMESTAMPTZ,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(telegram_user_id,symbol))`;
await db`CREATE TABLE IF NOT EXISTS paper_auto_trades (id BIGSERIAL PRIMARY KEY,telegram_user_id BIGINT NOT NULL,symbol TEXT NOT NULL,market_type TEXT NOT NULL,side TEXT NOT NULL,quantity NUMERIC(30,12) NOT NULL,price NUMERIC(24,10) NOT NULL,fee NUMERIC(24,8) NOT NULL,pnl NUMERIC(24,8),reason TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
await db`CREATE TABLE IF NOT EXISTS paper_auto_cooldowns (telegram_user_id BIGINT NOT NULL,symbol TEXT NOT NULL,cooldown_until TIMESTAMPTZ NOT NULL,PRIMARY KEY(telegram_user_id,symbol))`;
await db`CREATE TABLE IF NOT EXISTS paper_auto_equity_history (id BIGSERIAL PRIMARY KEY,telegram_user_id BIGINT NOT NULL,session_started_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),equity NUMERIC(24,8) NOT NULL,pnl NUMERIC(24,8) NOT NULL)`;
await db`CREATE INDEX IF NOT EXISTS paper_auto_equity_history_user_created_idx ON paper_auto_equity_history(telegram_user_id,created_at DESC)`;
await db`CREATE INDEX IF NOT EXISTS paper_auto_positions_user_idx ON paper_auto_positions(telegram_user_id)`;
await db`CREATE INDEX IF NOT EXISTS paper_auto_trades_user_created_idx ON paper_auto_trades(telegram_user_id,created_at DESC)`;
await db`CREATE TABLE IF NOT EXISTS testnet_auto_accounts (telegram_user_id BIGINT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'STOPPED', starting_usdt NUMERIC(24,8) NOT NULL DEFAULT 0, last_scan_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
await db`CREATE TABLE IF NOT EXISTS testnet_auto_positions (telegram_user_id BIGINT NOT NULL REFERENCES testnet_auto_accounts(telegram_user_id) ON DELETE CASCADE, symbol TEXT NOT NULL, quantity NUMERIC(30,12) NOT NULL, entry_price NUMERIC(24,10) NOT NULL, stop_price NUMERIC(24,10) NOT NULL, target_price NUMERIC(24,10) NOT NULL, highest_price NUMERIC(24,10) NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(telegram_user_id,symbol))`;
await db`CREATE TABLE IF NOT EXISTS testnet_auto_orders (id BIGSERIAL PRIMARY KEY, telegram_user_id BIGINT NOT NULL, client_order_id TEXT NOT NULL UNIQUE, exchange_order_id TEXT, symbol TEXT NOT NULL, side TEXT NOT NULL, quantity NUMERIC(30,12) NOT NULL DEFAULT 0, filled NUMERIC(30,12) NOT NULL DEFAULT 0, average NUMERIC(24,10) NOT NULL DEFAULT 0, cost NUMERIC(24,8) NOT NULL DEFAULT 0, status TEXT NOT NULL, reason TEXT NOT NULL, requested_amount NUMERIC(30,12) NOT NULL DEFAULT 0, candle_time BIGINT NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
await db`ALTER TABLE testnet_auto_orders ADD COLUMN IF NOT EXISTS requested_amount NUMERIC(30,12) NOT NULL DEFAULT 0`;
await db`ALTER TABLE testnet_auto_orders ADD COLUMN IF NOT EXISTS candle_time BIGINT NOT NULL DEFAULT 0`;
await db`CREATE INDEX IF NOT EXISTS testnet_auto_orders_user_created_idx ON testnet_auto_orders(telegram_user_id,created_at DESC)`;
await db`CREATE TABLE IF NOT EXISTS testnet_auto_cooldowns (telegram_user_id BIGINT NOT NULL, symbol TEXT NOT NULL, cooldown_until TIMESTAMPTZ NOT NULL, PRIMARY KEY(telegram_user_id,symbol))`;

const fmt=(n:number)=>Number(n||0).toLocaleString("fr-FR",{minimumFractionDigits:2,maximumFractionDigits:2});
const universe=[{symbol:"BTCUSDT",type:"crypto"},{symbol:"ETHUSDT",type:"crypto"},{symbol:"SOLUSDT",type:"crypto"},{symbol:"BNBUSDT",type:"crypto"},{symbol:"XRPUSDT",type:"crypto"},{symbol:"DOGEUSDT",type:"crypto"},{symbol:"LINKUSDT",type:"crypto"},{symbol:"AVAXUSDT",type:"crypto"},{symbol:"EURUSD=X",type:"forex"},{symbol:"GBPUSD=X",type:"forex"},{symbol:"GC=F",type:"commodity"},{symbol:"SI=F",type:"commodity"},{symbol:"CL=F",type:"commodity"},{symbol:"^GSPC",type:"index"},{symbol:"^IXIC",type:"index"},{symbol:"AAPL",type:"stock"},{symbol:"MSFT",type:"stock"},{symbol:"NVDA",type:"stock"},{symbol:"AMZN",type:"stock"}];
const MIN_CAPITAL=10,MAX_CAPITAL=1000000;
const agentState=new Map<string,any>();
async function telegram(message:string,userId:number){if(!env.BOT_TOKEN)return;const r=await fetch("https://api.telegram.org/bot"+env.BOT_TOKEN+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:userId,text:message}),signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error("Telegram HTTP "+r.status);}
async function getMarket(item:any){
 if(item.type==="crypto"){
  const pair=item.symbol;
  const [pr,cr]=await Promise.all([fetch("https://data-api.binance.vision/api/v3/ticker/price?symbol="+pair,{signal:AbortSignal.timeout(8000)}),fetch("https://data-api.binance.vision/api/v3/klines?symbol="+pair+"&interval=5m&limit=200",{signal:AbortSignal.timeout(9000)})]);
  const pj:any=await pr.json(),rows:any=await cr.json();const price=Number(pj.price);
  if(!pr.ok||!cr.ok||!Number.isFinite(price)||!Array.isArray(rows))throw new Error("Binance data unavailable "+pair);
  const now=Date.now(),candles=rows.map((x:any[])=>({t:+x[0],end:+x[6],o:+x[1],h:+x[2],l:+x[3],c:+x[4],v:+x[5]})).filter((x:any)=>[x.t,x.end,x.o,x.h,x.l,x.c].every(Number.isFinite)&&x.end<now-1000&&x.l>0&&x.h>=Math.max(x.o,x.c)&&x.l<=Math.min(x.o,x.c)&&x.h>=x.l);
  if(candles.length<170||now-candles[candles.length-1].end>660000)throw new Error("Bougies 5m insuffisantes ou anciennes "+pair);
  return { ...item,price,candles:candles.slice(-180),currency:"USDT",marketOpen:true,dataAgeMs:0 };
 }
 const url=new URL("https://query1.finance.yahoo.com/v8/finance/chart/"+encodeURIComponent(item.symbol));
 url.searchParams.set("interval","5m");url.searchParams.set("range","5d");
 const r=await fetch(url,{headers:{"user-agent":"Mozilla/5.0"},signal:AbortSignal.timeout(10000)}),j:any=await r.json().catch(()=>null),z=j?.chart?.result?.[0],q=z?.indicators?.quote?.[0];
 if(!r.ok||!z||!q)throw new Error("Yahoo data unavailable "+item.symbol);
 const times=z.timestamp||[],now=Date.now(),candles=times.map((t:number,i:number)=>({t:t*1000,end:t*1000+300000,o:+q.open?.[i],h:+q.high?.[i],l:+q.low?.[i],c:+q.close?.[i],v:+q.volume?.[i]})).filter((x:any)=>[x.t,x.end,x.o,x.h,x.l,x.c].every(Number.isFinite)&&x.end<now-1000&&x.l>0&&x.h>=Math.max(x.o,x.c)&&x.l<=Math.min(x.o,x.c)&&x.h>=x.l);
 if(candles.length<170)throw new Error("Pas assez de bougies Yahoo "+item.symbol);
 const dataAgeMs=Math.max(0,now-candles[candles.length-1].end),marketOpen=dataAgeMs<=20*60*1000;
 const price=Number(z.meta?.regularMarketPrice||candles[candles.length-1].c);
 if(!Number.isFinite(price)||price<=0)throw new Error("Prix Yahoo invalide "+item.symbol);
 return {...item,price,candles:candles.slice(-180),currency:"USD",marketOpen,dataAgeMs};
}
function ema(v:number[],n:number){let x=v.slice(0,n).reduce((a,b)=>a+b,0)/n,k=2/(n+1);for(const z of v.slice(n))x=z*k+x*(1-k);return x;}
function rsi(v:number[]){const d=v.slice(1).map((x,i)=>x-v[i]);let g=0,l=0;for(const x of d.slice(0,14)){g+=Math.max(0,x);l+=Math.max(0,-x);}g/=14;l/=14;for(const x of d.slice(14)){g=(g*13+Math.max(0,x))/14;l=(l*13+Math.max(0,-x))/14;}return l===0?(g===0?50:100):100-100/(1+g/l);}
function atr(a:any[]){const t:number[]=[];for(let i=Math.max(1,a.length-15);i<a.length;i++)t.push(Math.max(a[i].h-a[i].l,Math.abs(a[i].h-a[i-1].c),Math.abs(a[i].l-a[i-1].c)));return t.reduce((x,y)=>x+y,0)/Math.max(1,t.length);}
let cycleBusy=false;
let testnetCycleBusy=false;
async function closePosition(row:any,price:number,reason:string,stop=false){
 const qty=Number(row.quantity),entry=Number(row.entry_price),entryFee=Number(row.entry_fee),exitPrice=price*(1-0.0002),gross=qty*exitPrice,fee=gross*0.0005,proceeds=gross-fee,pnl=proceeds-(qty*entry+entryFee);
 await db.begin(async(tx:any)=>{
  await tx`UPDATE paper_auto_portfolios SET cash=cash+${proceeds},realized_pnl=realized_pnl+${pnl},updated_at=NOW() WHERE telegram_user_id=${row.telegram_user_id}`;
  await tx`INSERT INTO paper_auto_trades(telegram_user_id,symbol,market_type,side,quantity,price,fee,pnl,reason) VALUES(${row.telegram_user_id},${row.symbol},${row.market_type},'SELL',${qty},${exitPrice},${fee},${pnl},${reason})`;
  await tx`DELETE FROM paper_auto_positions WHERE telegram_user_id=${row.telegram_user_id} AND symbol=${row.symbol}`;
  await tx`INSERT INTO paper_auto_cooldowns(telegram_user_id,symbol,cooldown_until) VALUES(${row.telegram_user_id},${row.symbol},NOW()+INTERVAL '5 minutes') ON CONFLICT(telegram_user_id,symbol) DO UPDATE SET cooldown_until=EXCLUDED.cooldown_until`;
 });
 void telegram("🔔 JAMALQUANT · SORTIE SIMULÉE\n"+row.symbol+" ("+row.market_type+")\n"+reason+"\nP/L net estimé : "+(pnl>=0?"+":"")+fmt(pnl)+" USD\nAucun ordre réel.",Number(row.telegram_user_id)).catch(err=>console.warn("Close notification failed:",err instanceof Error?err.message:String(err)));
}
async function scanPortfolio(account:any,positions:any[]){
 const uid=Number(account.telegram_user_id),now=Date.now();
 await warmNews(universe);
 const held=new Map(positions.map((p:any)=>[p.symbol,p]));
 const results:any[]=[];let errors=0;
 for(let i=0;i<universe.length;i+=6){
  const batch=universe.slice(i,i+6);
  const settled=await Promise.allSettled(batch.map(getMarket));
  for(let j=0;j<settled.length;j++){
   const s=settled[j];if(s.status==="rejected"){errors++;const reason=String(s.reason);agentState.set(batch[j].symbol,{...(agentState.get(batch[j].symbol)||{}),symbol:batch[j].symbol,type:batch[j].type,state:/FERM/.test(reason)?"MARCHÉ FERMÉ":"DONNÉES INDISPONIBLES",updatedAt:Date.now()});console.warn("Market scan failed",batch[j].symbol,reason);continue;}
   const m=s.value,cs=m.candles,closes=cs.map((x:any)=>x.c),e20=ema(closes,20),e50=ema(closes,50),rv=rsi(closes),vol=atr(cs),last=cs[cs.length-1],prev=cs[cs.length-2];
   const vote=await runAgentPipeline({item:m,candles:cs,price:m.price,ema20:e20,ema50:e50,rsi:rv,atr:vol,riskBudget:Math.min(Number(account.initial_capital)*0.003,Number(account.cash)*0.01),availableCash:Number(account.cash),maxOrderNotional:Number(account.cash)*0.12,minimumOrderNotional:10,onProgress:(rows:any[])=>{const current=agentState.get(m.symbol)||{};agentState.set(m.symbol,{...current,symbol:m.symbol,type:m.type,price:m.price,ema20:e20,ema50:e50,rsi:rv,trend:e20>e50?"HAUSSIER":"BAISSIER",pipelineValid:false,agentVotes:rows.map(x=>({name:x.name,bullish:!!x.ok,verdict:x.verdict,group:x.group,detail:x.detail||""})),agentCount:19,state:"ANALYSE DES AGENTS "+rows.length+"/19",updatedAt:Date.now()});}});const signal=vote.valid;
   agentState.set(m.symbol,{symbol:m.symbol,type:m.type,price:m.price,ema20:e20,ema50:e50,rsi:rv,trend:e20>e50?"HAUSSIER":"BAISSIER",signal:Boolean(m.marketOpen)&&signal,score:vote.bullishVotes,agentCount:vote.totalAgents,agentVotes:vote.agentVotes,pipelineValid:vote.valid,consensus:vote.consensus,newsBias:vote.newsBias,simulation:vote.simulation,risk:vote.risk,state:!m.marketOpen?"MARCHÉ FERMÉ · ANALYSE HISTORIQUE":held.has(m.symbol)?"EN POSITION":signal?"CONSENSUS ACHAT":"ANALYSÉ · ATTENTE",changePct:(m.price/cs[0].c-1)*100,spark:cs.slice(-40).map((x:any)=>x.c),chartCandles:cs.slice(-60).map((x:any)=>({t:x.t,o:x.o,h:x.h,l:x.l,c:x.c})),dataAgeMinutes:Math.round((Number(m.dataAgeMs)||0)/60000),updatedAt:Date.now()});
   results.push(m);
   // Closed markets remain analyzable from their last valid candles, but never generate paper orders or stale-price exits.
   if(!m.marketOpen)continue;
   const pos:any=held.get(m.symbol);
   if(pos){
    const entry=Number(pos.entry_price),risk=Number(pos.initial_risk),high=Math.max(Number(pos.highest_price),m.price);
    let stop=Number(pos.stop_price);if(high>=entry+risk)stop=Math.max(stop,high-vol*1.2);
    if(m.price<=stop){await closePosition(pos,m.price,"Stop-loss / stop suiveur");continue;}
    if(m.price>=Number(pos.target_price)){await closePosition(pos,m.price,"Objectif théorique 2R atteint");continue;}
    if(e20<e50||rv<45){await closePosition(pos,m.price,"Momentum haussier invalidé");continue;}
    await db`UPDATE paper_auto_positions SET mark_price=${m.price},highest_price=${high},stop_price=${stop},updated_at=NOW() WHERE telegram_user_id=${uid} AND symbol=${m.symbol}`;
    agentState.set(m.symbol,{...agentState.get(m.symbol),state:"EN POSITION",updatedAt:Date.now()});
    continue;
   }
   const fresh=await db`SELECT status FROM paper_auto_portfolios WHERE telegram_user_id=${uid}`;
   if(!fresh.length||fresh[0].status!=="RUNNING")return;
   if(!signal)continue;
   const exists=await db`SELECT 1 FROM paper_auto_positions WHERE telegram_user_id=${uid} AND symbol=${m.symbol}`;if(exists.length)continue;const cooling=await db`SELECT 1 FROM paper_auto_cooldowns WHERE telegram_user_id=${uid} AND symbol=${m.symbol} AND cooldown_until>NOW()`;if(cooling.length)continue;
   const balanceRows=await db`SELECT cash FROM paper_auto_portfolios WHERE telegram_user_id=${uid} AND status='RUNNING'`;if(!balanceRows.length)continue;const availableCash=Number(balanceRows[0].cash);
   const ep=m.price*(1+0.0002),distance=vol*1.5,budget=Math.min(Number(account.initial_capital)*0.003,availableCash*0.01),qtyRisk=budget/distance,qtyCash=availableCash*0.12/ep,qty=Math.min(qtyRisk,qtyCash),notional=qty*ep,fee=notional*0.0005,cost=notional+fee;
   if(!(qty>0&&notional>=10&&cost<=availableCash*0.2))continue;
   const stop=ep-distance,target=ep+distance*2;
   const inserted=await db.begin(async(tx:any)=>{
    const debited=await tx`UPDATE paper_auto_portfolios SET cash=cash-${cost},updated_at=NOW() WHERE telegram_user_id=${uid} AND status='RUNNING' AND cash>=${cost} RETURNING cash`;
    if(!debited.length)return false;
    const made=await tx`INSERT INTO paper_auto_positions(telegram_user_id,symbol,market_type,quantity,entry_price,entry_fee,mark_price,stop_price,target_price,highest_price,initial_risk,last_candle_time,updated_at) VALUES(${uid},${m.symbol},${m.type},${qty},${ep},${fee},${m.price},${stop},${target},${ep},${distance},${last.t},NOW()) ON CONFLICT(telegram_user_id,symbol) DO NOTHING RETURNING symbol`;
    if(!made.length){await tx`UPDATE paper_auto_portfolios SET cash=cash+${cost} WHERE telegram_user_id=${uid}`;return false;}
    await tx`INSERT INTO paper_auto_trades(telegram_user_id,symbol,market_type,side,quantity,price,fee,reason) VALUES(${uid},${m.symbol},${m.type},'BUY',${qty},${ep},${fee},'Signal EMA20/EMA50 + RSI + momentum')`;
    return true;
   });
   if(inserted){agentState.set(m.symbol,{...agentState.get(m.symbol),state:"EN POSITION",updatedAt:Date.now()});await telegram("🟢 JAMALQUANT · ENTRÉE SIMULÉE\n"+m.symbol+" ("+m.type+")\nPrix : "+fmt(ep)+"\nStop : "+fmt(stop)+"\nObjectif 2R : "+fmt(target)+"\nRisque budgété : "+fmt(budget)+" USD\nRSI : "+rv.toFixed(1)+"\nSimulation uniquement.",uid);}
  }
 }
 return {scanned:results.length,errors,markets:results.map(x=>x.symbol)};
}

async function testnetRequest(path:string,payload:any){
 const hub=String(env.EXCHANGE_HUB_URL||"https://jamalquant-exchange-hub-production.up.railway.app").replace(/\/$/,""),token=String(env.CONNECTOR_ADMIN_TOKEN||"");
 if(!hub||token.length<32)throw new Error("Connecteur Testnet non configuré côté moteur.");
 const response=await fetch(hub+path,{method:"POST",headers:{"content-type":"application/json","authorization":"Bearer "+token},body:JSON.stringify(payload),signal:AbortSignal.timeout(20000)});
 const data:any=await response.json().catch(()=>({}));
 if(!response.ok||data.ok===false)throw new Error(data.error||"Connecteur Binance Testnet indisponible (HTTP "+response.status+").");
 return data;
}
async function testnetOrder(uid:number,symbol:string,side:"buy"|"sell",amount:number,reason:string,candleTime:number){
 const normalized=symbol.replace(/USDT$/,"/USDT");
 const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode([uid,symbol,side,candleTime].join(":")));
 const clientOrderId="JQ"+[...new Uint8Array(digest)].slice(0,16).map(x=>x.toString(16).padStart(2,"0")).join("");
 const existing=await db`SELECT * FROM testnet_auto_orders WHERE client_order_id=${clientOrderId}`;
 const payload=side==="buy"?{symbol:normalized,side,quoteAmount:amount,clientOrderId}:{symbol:normalized,side,baseAmount:amount,clientOrderId};
 const result=await testnetRequest("/private/test-order",payload),o=result.order||{};
 await db`INSERT INTO testnet_auto_orders(telegram_user_id,client_order_id,exchange_order_id,symbol,side,quantity,filled,average,cost,status,reason,requested_amount,candle_time) VALUES(${uid},${clientOrderId},${String(o.id||"")},${normalized},${side.toUpperCase()},${Number(o.amount||0)},${Number(o.filled||0)},${Number(o.average||0)},${Number(o.cost||0)},${String(o.status||"submitted")},${reason},${amount},${candleTime}) ON CONFLICT(client_order_id) DO UPDATE SET exchange_order_id=EXCLUDED.exchange_order_id,quantity=EXCLUDED.quantity,filled=EXCLUDED.filled,average=EXCLUDED.average,cost=EXCLUDED.cost,status=EXCLUDED.status`;
 return {clientOrderId,...o};
}
async function scanTestnetAccount(account:any){
 const uid=Number(account.telegram_user_id);
 const cryptoMarkets=universe.filter(x=>x.type==="crypto");
 const accountData=await testnetRequest("/private/account",{exchange:"binance"});
 if(accountData.environment!=="binance-spot-testnet"||accountData.accountConnected!==true)throw new Error("Compte Binance Spot Testnet non confirmé.");
 const usdt=Number((accountData.assets||[]).find((x:any)=>x.asset==="USDT")?.total||0),orderBudget=Math.min(25,usdt*0.10);
 await warmNews(cryptoMarkets);
 let scanned=0,errors=0,orders=0;
 for(const item of cryptoMarkets){
  try{
   const m=await getMarket(item),cs=m.candles,closes=cs.map((x:any)=>x.c),e20=ema(closes,20),e50=ema(closes,50),rv=rsi(closes),vol=atr(cs),last=cs[cs.length-1],prev=cs[cs.length-2];
   const vote=await runAgentPipeline({item:m,candles:cs,price:m.price,ema20:e20,ema50:e50,rsi:rv,atr:vol,riskBudget:usdt*0.01,availableCash:usdt,maxOrderNotional:orderBudget,minimumOrderNotional:10,onProgress:(rows:any[])=>{const current=agentState.get(m.symbol)||{};agentState.set(m.symbol,{...current,symbol:m.symbol,type:"crypto",price:m.price,ema20:e20,ema50:e50,rsi:rv,trend:e20>e50?"HAUSSIER":"BAISSIER",pipelineValid:false,agentVotes:rows.map(x=>({name:x.name,bullish:!!x.ok,verdict:x.verdict,group:x.group,detail:x.detail||""})),agentCount:19,state:"ANALYSE DES AGENTS "+rows.length+"/19",updatedAt:Date.now()});}});
   const signal=vote.valid;
   agentState.set(m.symbol,{symbol:m.symbol,type:"crypto",price:m.price,ema20:e20,ema50:e50,rsi:rv,trend:e20>e50?"HAUSSIER":"BAISSIER",signal,score:vote.bullishVotes,agentCount:vote.totalAgents,agentVotes:vote.agentVotes,pipelineValid:vote.valid,consensus:vote.consensus,newsBias:vote.newsBias,simulation:vote.simulation,risk:vote.risk,state:"TESTNET · "+(signal?"SIGNAL ACHAT":"ANALYSÉ · ATTENTE"),changePct:(m.price/cs[0].c-1)*100,spark:cs.slice(-40).map((x:any)=>x.c),chartCandles:cs.slice(-60).map((x:any)=>({t:x.t,o:x.o,h:x.h,l:x.l,c:x.c})),updatedAt:Date.now()});
   scanned++;
   const pendingRows=await db`SELECT * FROM testnet_auto_orders WHERE telegram_user_id=${uid} AND symbol=${m.symbol.replace(/USDT$/,"/USDT")} AND status NOT IN ('closed','filled','canceled','rejected') ORDER BY created_at DESC LIMIT 1`;
   if(pendingRows.length){
    const po=pendingRows[0],side=String(po.side).toLowerCase()==="buy"?"buy":"sell";
    const refreshed=await testnetOrder(uid,m.symbol,side,Number(po.requested_amount),String(po.reason),Number(po.candle_time));
    const filled=Number(refreshed.filled||0),average=Number(refreshed.average||0),status=String(refreshed.status||"").toLowerCase();
    if(filled>0&&average>0&&["closed","filled"].includes(status)){
     if(side==="buy"){
      const distance=vol*1.5;
      await db`INSERT INTO testnet_auto_positions(telegram_user_id,symbol,quantity,entry_price,stop_price,target_price,highest_price) VALUES(${uid},${m.symbol},${filled},${average},${average-distance},${average+distance*2},${average}) ON CONFLICT(telegram_user_id,symbol) DO NOTHING`;
      orders++;
      void telegram("🟢 JAMALQUANT · ACHAT TESTNET\n"+m.symbol+"\nQuantité exécutée : "+fmt(filled)+"\nPrix moyen : "+fmt(average)+"\nStop : "+fmt(average-distance)+"\nObjectif 2R : "+fmt(average+distance*2)+"\nFonds fictifs Binance Testnet.",uid).catch(()=>{});
     }else{
      await db`DELETE FROM testnet_auto_positions WHERE telegram_user_id=${uid} AND symbol=${m.symbol}`;
      await db`INSERT INTO testnet_auto_cooldowns(telegram_user_id,symbol,cooldown_until) VALUES(${uid},${m.symbol},NOW()+INTERVAL '5 minutes') ON CONFLICT(telegram_user_id,symbol) DO UPDATE SET cooldown_until=EXCLUDED.cooldown_until`;
      orders++;
      void telegram("🔴 JAMALQUANT · VENTE TESTNET\n"+m.symbol+"\nQuantité exécutée : "+fmt(filled)+"\nPrix moyen : "+fmt(average)+"\nStatut : "+status,uid).catch(()=>{});
     }
    }
    continue;
   }
   const posRows=await db`SELECT * FROM testnet_auto_positions WHERE telegram_user_id=${uid} AND symbol=${m.symbol}`;
   if(posRows.length){
    const p=posRows[0],high=Math.max(Number(p.highest_price),m.price),exit=m.price<=Number(p.stop_price)||m.price>=Number(p.target_price)||e20<e50||rv<45;
    await db`UPDATE testnet_auto_positions SET highest_price=${high},updated_at=NOW() WHERE telegram_user_id=${uid} AND symbol=${m.symbol}`;
    if(exit){
     const result=await testnetOrder(uid,m.symbol,"sell",Number(p.quantity),m.price<=Number(p.stop_price)?"STOP_LOSS":m.price>=Number(p.target_price)?"TAKE_PROFIT":"SIGNAL_INVALIDATED",last.t);
     const filled=Number(result.filled||0),average=Number(result.average||m.price);
     if(filled>0&&["closed","filled"].includes(String(result.status||"").toLowerCase())){
      await db`DELETE FROM testnet_auto_positions WHERE telegram_user_id=${uid} AND symbol=${m.symbol}`;
      await db`INSERT INTO testnet_auto_cooldowns(telegram_user_id,symbol,cooldown_until) VALUES(${uid},${m.symbol},NOW()+INTERVAL '5 minutes') ON CONFLICT(telegram_user_id,symbol) DO UPDATE SET cooldown_until=EXCLUDED.cooldown_until`;
      orders++;
      void telegram("🔴 JAMALQUANT · VENTE TESTNET\n"+m.symbol+"\nQuantité exécutée : "+fmt(filled)+"\nPrix moyen : "+fmt(average)+"\nStatut : "+String(result.status),uid).catch(()=>{});
     }
    }
    continue;
   }
   if(!signal)continue;
   const cooling=await db`SELECT 1 FROM testnet_auto_cooldowns WHERE telegram_user_id=${uid} AND symbol=${m.symbol} AND cooldown_until>NOW()`;if(cooling.length)continue;
   const pending=await db`SELECT 1 FROM testnet_auto_orders WHERE telegram_user_id=${uid} AND symbol=${m.symbol.replace(/USDT$/,"/USDT")} AND side='BUY' AND status NOT IN ('closed','filled','canceled','rejected') LIMIT 1`;if(pending.length)continue;
   const running=await db`SELECT status FROM testnet_auto_accounts WHERE telegram_user_id=${uid}`;
   if(!running.length||running[0].status!=="RUNNING")return {scanned,errors,orders,stopped:true};
   const count=await db`SELECT COUNT(*)::int AS n FROM testnet_auto_positions WHERE telegram_user_id=${uid}`;
   if(Number(count[0]?.n||0)>=2)continue;
   const budget=orderBudget;
   if(budget<10)continue;
   const result=await testnetOrder(uid,m.symbol,"buy",budget,"EMA_RSI_CONSENSUS",last.t);
   const filled=Number(result.filled||0),average=Number(result.average||0),status=String(result.status||"").toLowerCase();
   if(filled>0&&average>0&&["closed","filled"].includes(status)){
    const distance=vol*1.5,stop=average-distance,target=average+distance*2;
    await db`INSERT INTO testnet_auto_positions(telegram_user_id,symbol,quantity,entry_price,stop_price,target_price,highest_price) VALUES(${uid},${m.symbol},${filled},${average},${stop},${target},${average}) ON CONFLICT(telegram_user_id,symbol) DO NOTHING`;
    orders++;
    void telegram("🟢 JAMALQUANT · ACHAT TESTNET\n"+m.symbol+"\nQuantité exécutée : "+fmt(filled)+"\nPrix moyen : "+fmt(average)+"\nStop : "+fmt(stop)+"\nObjectif 2R : "+fmt(target)+"\nFonds fictifs Binance Testnet.",uid).catch(()=>{});
   }
  }catch(err){errors++;console.warn("Testnet scan failed",item.symbol,err instanceof Error?err.message:String(err));}
 }
 await db`UPDATE testnet_auto_accounts SET last_scan_at=NOW(),updated_at=NOW() WHERE telegram_user_id=${uid} AND status='RUNNING'`;
 return {scanned,errors,orders};
}
async function testnetCycle(){
 if(testnetCycleBusy)return {testnetBusy:true};
 testnetCycleBusy=true;
 try{
  const accounts=await db`SELECT * FROM testnet_auto_accounts WHERE status='RUNNING' ORDER BY updated_at ASC`;
  for(const account of accounts){
   if(account.last_scan_at&&Date.now()-new Date(account.last_scan_at).getTime()<55000)continue;
   try{const result=await scanTestnetAccount(account);console.log("Binance Spot Testnet scanner",account.telegram_user_id,JSON.stringify(result));}
   catch(err){console.error("Testnet portfolio cycle failed",account.telegram_user_id,err instanceof Error?err.message:String(err));}
  }
  return {testnetAccounts:accounts.length};
 }finally{testnetCycleBusy=false;}
}

async function cycle(){
 if(cycleBusy)return {busy:true};
 cycleBusy=true;
 try{
  const accounts=await db`SELECT * FROM paper_auto_portfolios WHERE status='RUNNING' ORDER BY updated_at ASC`;
  for(const account of accounts){
   try{
    const positions=await db`SELECT * FROM paper_auto_positions WHERE telegram_user_id=${account.telegram_user_id}`;
    if(account.last_scan_at&&Date.now()-new Date(account.last_scan_at).getTime()<55000)continue;
    const result=await scanPortfolio(account,positions);
    await db`UPDATE paper_auto_portfolios SET updated_at=NOW(),last_scan_at=NOW() WHERE telegram_user_id=${account.telegram_user_id} AND status='RUNNING'`;
    const snapshot=await db`SELECT p.cash+COALESCE(SUM(pos.quantity*pos.mark_price),0) AS equity FROM paper_auto_portfolios p LEFT JOIN paper_auto_positions pos ON pos.telegram_user_id=p.telegram_user_id WHERE p.telegram_user_id=${account.telegram_user_id} AND p.status='RUNNING' GROUP BY p.telegram_user_id,p.cash`;
    if(snapshot.length){const equity=Number(snapshot[0].equity),pnl=equity-Number(account.initial_capital);await db`INSERT INTO paper_auto_equity_history(telegram_user_id,session_started_at,equity,pnl) SELECT ${account.telegram_user_id},created_at,${equity},${pnl} FROM paper_auto_portfolios WHERE telegram_user_id=${account.telegram_user_id}`;}
    console.log("Multi-market scan",account.telegram_user_id,JSON.stringify(result));
   }catch(err){console.error("Portfolio cycle error",account.telegram_user_id,err instanceof Error?err.message:String(err));}
  }
  const testnet=await testnetCycle();
  return {ok:true,portfolios:accounts.length,universe:universe.length,...testnet};
 }finally{cycleBusy=false;}
}
async function handle(req:Request){
 const url=new URL(req.url);
 if(url.pathname==="/health"&&req.method==="GET"){const x=await db`SELECT 1 AS ok`;return Response.json({ok:true,engine:"multi-market-paper-v3",database:x.length===1?"connected":"error",mode:"paper-trading-only",liveTradingEnabled:false,universe:universe.length,markets:universe,minCapital:MIN_CAPITAL,maxCapital:MAX_CAPITAL});}
 if(req.headers.get("x-engine-secret")!==env.AUTO_ENGINE_SECRET)return new Response("Unauthorized",{status:401});
 let body:any={};try{body=await req.json();}catch{return new Response("Bad JSON",{status:400});}
 const userId=Number(body.userId);if(!Number.isSafeInteger(userId)||userId<=0)return Response.json({error:"Invalid userId"},{status:400});

 // Comptabilité virtuelle isolée : aucune connexion Binance, aucun dépôt/retrait réel.
 if(url.pathname==="/sandbox-ledger/status"&&req.method==="POST"){
  const rows=await db`SELECT telegram_user_id,currency,balance,total_credited,total_debited,status,created_at,updated_at FROM sandbox_client_ledgers WHERE telegram_user_id=${userId}`;
  const entries=await db`SELECT entry_type,amount,balance_after,reference,description,created_at FROM sandbox_client_ledger_entries WHERE telegram_user_id=${userId} ORDER BY created_at DESC LIMIT 100`;
  return Response.json({ok:true,mode:"SANDBOX_ONLY",realFundsEnabled:false,account:rows[0]?{userId:Number(rows[0].telegram_user_id),currency:rows[0].currency,balance:Number(rows[0].balance),totalCredited:Number(rows[0].total_credited),totalDebited:Number(rows[0].total_debited),status:rows[0].status,createdAt:rows[0].created_at,updatedAt:rows[0].updated_at}:null,entries});
 }
 if(url.pathname==="/sandbox-ledger/open"&&req.method==="POST"){
  const amount=Number(body.virtualStartingBalance);
  if(!Number.isFinite(amount)||amount<=0||amount>1000000)return Response.json({error:"Solde virtuel invalide (0 à 1 000 000 USDT)."}, {status:400});
  const reference=String(body.reference||"").trim();
  if(!/^[A-Za-z0-9_-]{8,64}$/.test(reference))return Response.json({error:"Référence idempotente requise (8 à 64 caractères)."}, {status:400});
  const result=await db.begin(async(tx:any)=>{
   const existing=await tx`SELECT telegram_user_id,balance FROM sandbox_client_ledgers WHERE telegram_user_id=${userId} FOR UPDATE`;
   if(existing.length)return {created:false,balance:Number(existing[0].balance)};
   await tx`INSERT INTO sandbox_client_ledgers(telegram_user_id,balance,total_credited) VALUES(${userId},${amount},${amount})`;
   await tx`INSERT INTO sandbox_client_ledger_entries(telegram_user_id,entry_type,amount,balance_after,reference,description) VALUES(${userId},'OPENING_VIRTUAL',${amount},${amount},${reference},'Solde initial fictif de test — aucun fonds reçu')`;
   return {created:true,balance:amount};
  });
  return Response.json({ok:true,mode:"SANDBOX_ONLY",realFundsEnabled:false,...result});
 }
 if(url.pathname==="/sandbox-ledger/adjust"&&req.method==="POST"){
  const amount=Number(body.amount),direction=String(body.direction||"");
  const reference=String(body.reference||"").trim(),description=String(body.description||"").slice(0,240);
  if(!Number.isFinite(amount)||amount<=0||amount>1000000)return Response.json({error:"Montant virtuel invalide."},{status:400});
  if(direction!=="CREDIT"&&direction!=="DEBIT")return Response.json({error:"direction doit être CREDIT ou DEBIT."},{status:400});
  if(!/^[A-Za-z0-9_-]{8,64}$/.test(reference))return Response.json({error:"Référence idempotente requise (8 à 64 caractères)."}, {status:400});
  const result=await db.begin(async(tx:any)=>{
   const duplicate=await tx`SELECT balance_after FROM sandbox_client_ledger_entries WHERE telegram_user_id=${userId} AND reference=${reference}`;
   if(duplicate.length)return {duplicate:true,balance:Number(duplicate[0].balance_after)};
   const accounts=await tx`SELECT balance,status FROM sandbox_client_ledgers WHERE telegram_user_id=${userId} FOR UPDATE`;
   if(!accounts.length)throw new Error("LEDGER_NOT_FOUND");
   if(accounts[0].status!=="OPEN")throw new Error("LEDGER_FROZEN");
   const current=Number(accounts[0].balance),next=direction==="CREDIT"?current+amount:current-amount;
   if(next<0)throw new Error("INSUFFICIENT_VIRTUAL_BALANCE");
   await tx`UPDATE sandbox_client_ledgers SET balance=${next},total_credited=total_credited+${direction==="CREDIT"?amount:0},total_debited=total_debited+${direction==="DEBIT"?amount:0},updated_at=NOW() WHERE telegram_user_id=${userId}`;
   await tx`INSERT INTO sandbox_client_ledger_entries(telegram_user_id,entry_type,amount,balance_after,reference,description) VALUES(${userId},${direction==="CREDIT"?"CREDIT_VIRTUAL":"DEBIT_VIRTUAL"},${amount},${next},${reference},${description||"Ajustement comptable virtuel"})`;
   return {duplicate:false,balance:next};
  }).catch((err:any)=>{if(String(err?.message).includes("INSUFFICIENT_VIRTUAL_BALANCE"))return {error:"INSUFFICIENT_VIRTUAL_BALANCE"};if(String(err?.message).includes("LEDGER_NOT_FOUND"))return {error:"LEDGER_NOT_FOUND"};if(String(err?.message).includes("LEDGER_FROZEN"))return {error:"LEDGER_FROZEN"};throw err;});
  if((result as any).error)return Response.json({error:(result as any).error},{status:(result as any).error==="INSUFFICIENT_VIRTUAL_BALANCE"?409: (result as any).error==="LEDGER_NOT_FOUND"?404:423});
  return Response.json({ok:true,mode:"SANDBOX_ONLY",realFundsEnabled:false,...result});
 }

 if(url.pathname==="/testnet/start"){
  if(String(env.BINANCE_SPOT_TESTNET||"").toLowerCase()!=="true"||String(env.LIVE_TRADING_ENABLED||"").toLowerCase()==="true")return Response.json({error:"Mode Binance Spot Testnet non confirmé ou mode réel activé."},{status:403});
  const account=await testnetRequest("/private/account",{exchange:"binance"});
  if(account.environment!=="binance-spot-testnet"||account.accountConnected!==true)return Response.json({error:"Compte Binance Spot Testnet non vérifié."},{status:409});
  const usdt=Number((account.assets||[]).find((x:any)=>x.asset==="USDT")?.total||0);
  if(usdt<100)return Response.json({error:"Solde USDT Testnet insuffisant pour respecter le budget de risque : minimum 100 USDT requis (10 % maximum par ordre, ordre minimum 10 USDT). Scanner non démarré."},{status:409});
  const prior=await db`SELECT status,starting_usdt FROM testnet_auto_accounts WHERE telegram_user_id=${userId}`;
  const alreadyRunning=prior.length>0&&String(prior[0].status)==="RUNNING";
  if(!alreadyRunning){
   await db`INSERT INTO testnet_auto_accounts(telegram_user_id,status,starting_usdt,updated_at) VALUES(${userId},'RUNNING',${usdt},NOW()) ON CONFLICT(telegram_user_id) DO UPDATE SET status='RUNNING',starting_usdt=EXCLUDED.starting_usdt,last_scan_at=NULL,updated_at=NOW()`;
   void testnetCycle().catch(err=>console.error("Initial Testnet scan failed",err instanceof Error?err.message:String(err)));
  }
  const startingUsdt=alreadyRunning?Number(prior[0].starting_usdt):usdt;
  return Response.json({ok:true,mode:"BINANCE_SPOT_TESTNET",realTradingEnabled:false,status:"RUNNING",alreadyRunning,startingUsdt,capital:startingUsdt,cash:usdt,available:usdt,equity:usdt,pnl:usdt-startingUsdt,openPositions:0,universe:universe.filter(x=>x.type==="crypto").length,markets:universe.filter(x=>x.type==="crypto").map(x=>x.symbol),maxOrderUsdt:25,maxOpenPositions:2});
 }
 if(url.pathname==="/testnet/status"){
  const cryptoMarkets=universe.filter(x=>x.type==="crypto");
  const rows=await db`SELECT * FROM testnet_auto_accounts WHERE telegram_user_id=${userId}`;
  const positions=await db`SELECT * FROM testnet_auto_positions WHERE telegram_user_id=${userId} ORDER BY updated_at DESC`;
  const orders=await db`SELECT symbol,side,quantity,filled,average,cost,status,reason,created_at FROM testnet_auto_orders WHERE telegram_user_id=${userId} ORDER BY created_at DESC LIMIT 30`;
  let account:any=null,accountError="";try{account=await testnetRequest("/private/account",{exchange:"binance"});}catch(error){accountError=error instanceof Error?error.message:"Échec de connexion Binance Testnet";}
  const assets=account?.assets||[],usdt=Number(assets.find((x:any)=>x.asset==="USDT")?.total||0);
  const mappedPositions=positions.map((p:any)=>{const market=agentState.get(p.symbol)||{};return {symbol:p.symbol,marketType:"crypto",quantity:Number(p.quantity),entry:Number(p.entry_price),price:Number(market.price||p.entry_price),stop:Number(p.stop_price),target:Number(p.target_price)};});
  const invested=mappedPositions.reduce((sum:number,p:any)=>sum+p.quantity*p.price,0);
  const equity=usdt+invested,capital=Number(rows[0]?.starting_usdt||usdt);
  return Response.json({ok:true,mode:"BINANCE_SPOT_TESTNET",status:rows[0]?.status||"STOPPED",environment:account?.environment||"unavailable",accountConnected:account?.accountConnected===true,connectionError:accountError||null,assets,capital,cash:usdt,available:usdt,invested,equity,pnl:equity-capital,openPositions:mappedPositions.length,positions:mappedPositions,trades:orders,universe:cryptoMarkets.length,markets:cryptoMarkets.map(x=>x.symbol),agents:cryptoMarkets.map(u=>agentState.get(u.symbol)||{symbol:u.symbol,type:"crypto",state:"INITIALISATION"}),equityHistory:[],lastScanAt:rows[0]?.last_scan_at?new Date(rows[0].last_scan_at).getTime():null,maxOrderUsdt:25,maxOpenPositions:2});
 }
 if(url.pathname==="/testnet/stop"){
  await db`UPDATE testnet_auto_accounts SET status='STOPPED',updated_at=NOW() WHERE telegram_user_id=${userId}`;
  return Response.json({ok:true,stopped:true,openPositions:(await db`SELECT symbol,quantity FROM testnet_auto_positions WHERE telegram_user_id=${userId}`)});
 }

 if(url.pathname==="/reset"){
  if(cycleBusy)return Response.json({error:"Un scan est en cours. Réessaie dans quelques secondes."},{status:409});
  await db.begin(async(tx:any)=>{
   await tx`UPDATE paper_auto_portfolios SET status='STOPPED',initial_capital=0,cash=0,realized_pnl=0,updated_at=NOW(),last_scan_at=NULL WHERE telegram_user_id=${userId}`;
   await tx`DELETE FROM paper_auto_positions WHERE telegram_user_id=${userId}`;
   await tx`DELETE FROM paper_auto_trades WHERE telegram_user_id=${userId}`;
   await tx`DELETE FROM paper_auto_equity_history WHERE telegram_user_id=${userId}`;
   await tx`DELETE FROM paper_auto_cooldowns WHERE telegram_user_id=${userId}`;
  });
  return Response.json({ok:true,reset:true,status:"STOPPED",capital:0,cash:0,available:0,invested:0,realized:0,unrealized:0,equity:0,pnl:0,equityHistory:[],openPositions:0,positions:[],trades:[],universe:universe.length,markets:universe.map(x=>x.symbol),agents:universe.map(u=>agentState.get(u.symbol)||{symbol:u.symbol,type:u.type,state:"INITIALISATION"})});
 }
 if(url.pathname==="/start"){
  const capital=Number(body.capital);if(!Number.isFinite(capital)||capital<MIN_CAPITAL||capital>MAX_CAPITAL)return Response.json({error:"Capital fictif invalide ("+MIN_CAPITAL+" à "+MAX_CAPITAL.toLocaleString("fr-FR")+" USDT)"},{status:400});
  const existing=await db`SELECT * FROM paper_auto_portfolios WHERE telegram_user_id=${userId}`;
  if(existing.length&&existing[0].status==="RUNNING")return Response.json({ok:true,alreadyRunning:true,capital:Number(existing[0].initial_capital),cash:Number(existing[0].cash),universe:universe.length});
  await db`INSERT INTO paper_auto_portfolios(telegram_user_id,initial_capital,cash,realized_pnl,status,updated_at) VALUES(${userId},${capital},${capital},0,'RUNNING',NOW()) ON CONFLICT(telegram_user_id) DO UPDATE SET initial_capital=EXCLUDED.initial_capital,cash=EXCLUDED.cash,realized_pnl=0,status='RUNNING',created_at=NOW(),updated_at=NOW(),last_scan_at=NULL`;
  await db`DELETE FROM paper_auto_equity_history WHERE telegram_user_id=${userId}`;
  await db`INSERT INTO paper_auto_equity_history(telegram_user_id,session_started_at,equity,pnl) VALUES(${userId},NOW(),${capital},0)`;
  void cycle().catch(err=>console.error('Initial multi-market scan failed',err instanceof Error?err.message:String(err)));
  try{await telegram("🚀 JAMALQUANT MULTI-MARCHÉS ACTIVÉ\nCapital fictif : "+fmt(capital)+" USD\nUnivers : "+universe.length+" marchés (crypto, forex, matières premières, indices, actions)\nScan automatique toutes les ~60 secondes.\nMode simulation : aucun ordre réel, aucun gain garanti.",userId);}catch(err){console.warn("Start notification failed; paper portfolio remains active:",err instanceof Error?err.message:String(err));}
  return Response.json({ok:true,alreadyRunning:false,capital,universe:universe.length,markets:universe.map(x=>x.symbol),scanStarted:true});
 }
 if(url.pathname==="/status"){
  const rows=await db`SELECT * FROM paper_auto_portfolios WHERE telegram_user_id=${userId}`;if(!rows.length)return Response.json({ok:true,status:"STOPPED",capital:0,cash:0,available:0,invested:0,realized:0,unrealized:0,equity:0,pnl:0,equityHistory:[],openPositions:0,positions:[],trades:[],universe:universe.length,markets:universe.map(x=>x.symbol),agents:universe.map(u=>agentState.get(u.symbol)||{symbol:u.symbol,type:u.type,state:"INITIALISATION"}),lastScanAt:null});
  const a=rows[0];
  // Fallback watchdog: a running portfolio must trigger a fresh market scan when its last scan is stale.
  if(a.status==="RUNNING"&&!cycleBusy&&(!a.last_scan_at||Date.now()-new Date(a.last_scan_at).getTime()>55000)){void cycle().catch(err=>console.error("Status-triggered paper scan failed",err instanceof Error?err.message:String(err)));}
  const positions=await db`SELECT * FROM paper_auto_positions WHERE telegram_user_id=${userId} ORDER BY updated_at DESC`,trades=await db`SELECT symbol,side,quantity,price,fee,pnl,reason,created_at FROM paper_auto_trades WHERE telegram_user_id=${userId} ORDER BY created_at DESC LIMIT 50`,historyRows=await db`SELECT created_at,equity,pnl FROM paper_auto_equity_history WHERE telegram_user_id=${userId} ORDER BY created_at DESC LIMIT 240`;
  let unrealized=0;for(const x of positions)unrealized+=(Number(x.mark_price)-Number(x.entry_price))*Number(x.quantity)-Number(x.entry_fee);
  const equity=Number(a.cash)+positions.reduce((s:number,x:any)=>s+Number(x.quantity)*Number(x.mark_price),0);
  return Response.json({ok:true,status:a.status,capital:Number(a.initial_capital),cash:Number(a.cash),available:Number(a.cash),invested:positions.reduce((s:number,x:any)=>s+Number(x.quantity)*Number(x.mark_price),0),realized:Number(a.realized_pnl),unrealized,equity,pnl:equity-Number(a.initial_capital),equityHistory:historyRows.reverse().map((x:any)=>({time:new Date(x.created_at).getTime(),value:Number(x.pnl),equity:Number(x.equity)})),openPositions:positions.length,positions:positions.map((x:any)=>({symbol:x.symbol,marketType:x.market_type,quantity:Number(x.quantity),entry:Number(x.entry_price),price:Number(x.mark_price),stop:Number(x.stop_price),target:Number(x.target_price)})),trades,universe:universe.length,markets:universe.map(x=>x.symbol),agents:universe.map(u=>agentState.get(u.symbol)||{symbol:u.symbol,type:u.type,state:"INITIALISATION"}),lastScanAt:a.last_scan_at?new Date(a.last_scan_at).getTime():null});
 }
 if(url.pathname==="/stop"){
  const a=await db`SELECT * FROM paper_auto_portfolios WHERE telegram_user_id=${userId} AND status='RUNNING'`;if(!a.length)return Response.json({ok:true,stopped:true,alreadyStopped:true,closedPositions:0});
  await db`UPDATE paper_auto_portfolios SET status='STOPPED',updated_at=NOW() WHERE telegram_user_id=${userId}`;
  const positions=await db`SELECT * FROM paper_auto_positions WHERE telegram_user_id=${userId}`;
  for(const x of positions)await closePosition(x,Number(x.mark_price),"Arrêt demandé",true);
  return Response.json({ok:true,stopped:true,closedPositions:positions.length});
 }
 if(url.pathname==="/cycle"){const result=await cycle();return Response.json({ok:true,...result});}
 return new Response("Not found",{status:404});
}
Bun.serve({port:Number(env.PORT||3000),fetch:handle});
// Le moteur doit continuer à scanner les portefeuilles actifs après le démarrage initial.
const cycleIntervalMs=60_000;
setInterval(()=>{void cycle().catch(err=>console.error("Scheduled paper cycle failed:",err instanceof Error?err.message:String(err)));},cycleIntervalMs);
console.log("Paper engine scheduler enabled:",cycleIntervalMs,"ms");
void cycle().catch(err=>console.error("Startup paper cycle failed:",err instanceof Error?err.message:String(err)));

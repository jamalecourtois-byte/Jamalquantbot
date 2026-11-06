import postgres from "postgres@3.4.7";
const env=Bun.env;
if(!env.DATABASE_URL||!env.AUTO_ENGINE_SECRET)throw new Error("DATABASE_URL ou AUTO_ENGINE_SECRET manquant");
const db=postgres(env.DATABASE_URL,{max:8,idle_timeout:20,connect_timeout:10});
await db`CREATE TABLE IF NOT EXISTS paper_auto_portfolios (telegram_user_id BIGINT PRIMARY KEY,initial_capital NUMERIC(24,8) NOT NULL,cash NUMERIC(24,8) NOT NULL,realized_pnl NUMERIC(24,8) NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'STOPPED',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
await db`ALTER TABLE paper_auto_portfolios ADD COLUMN IF NOT EXISTS last_scan_at TIMESTAMPTZ`;
await db`CREATE TABLE IF NOT EXISTS paper_auto_positions (telegram_user_id BIGINT NOT NULL REFERENCES paper_auto_portfolios(telegram_user_id) ON DELETE CASCADE,symbol TEXT NOT NULL,market_type TEXT NOT NULL,quantity NUMERIC(30,12) NOT NULL,entry_price NUMERIC(24,10) NOT NULL,entry_fee NUMERIC(24,8) NOT NULL,mark_price NUMERIC(24,10) NOT NULL,stop_price NUMERIC(24,10) NOT NULL,target_price NUMERIC(24,10) NOT NULL,highest_price NUMERIC(24,10) NOT NULL,initial_risk NUMERIC(24,10) NOT NULL,last_candle_time BIGINT NOT NULL,cooldown_until TIMESTAMPTZ,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(telegram_user_id,symbol))`;
await db`CREATE TABLE IF NOT EXISTS paper_auto_trades (id BIGSERIAL PRIMARY KEY,telegram_user_id BIGINT NOT NULL,symbol TEXT NOT NULL,market_type TEXT NOT NULL,side TEXT NOT NULL,quantity NUMERIC(30,12) NOT NULL,price NUMERIC(24,10) NOT NULL,fee NUMERIC(24,8) NOT NULL,pnl NUMERIC(24,8),reason TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
await db`CREATE TABLE IF NOT EXISTS paper_auto_cooldowns (telegram_user_id BIGINT NOT NULL,symbol TEXT NOT NULL,cooldown_until TIMESTAMPTZ NOT NULL,PRIMARY KEY(telegram_user_id,symbol))`;
await db`CREATE INDEX IF NOT EXISTS paper_auto_positions_user_idx ON paper_auto_positions(telegram_user_id)`;
await db`CREATE INDEX IF NOT EXISTS paper_auto_trades_user_created_idx ON paper_auto_trades(telegram_user_id,created_at DESC)`;
const fmt=(n:number)=>Number(n||0).toLocaleString("fr-FR",{minimumFractionDigits:2,maximumFractionDigits:2});
const universe=[{symbol:"BTCUSDT",type:"crypto"},{symbol:"ETHUSDT",type:"crypto"},{symbol:"SOLUSDT",type:"crypto"},{symbol:"BNBUSDT",type:"crypto"},{symbol:"XRPUSDT",type:"crypto"},{symbol:"DOGEUSDT",type:"crypto"},{symbol:"LINKUSDT",type:"crypto"},{symbol:"AVAXUSDT",type:"crypto"},{symbol:"EURUSD=X",type:"forex"},{symbol:"GBPUSD=X",type:"forex"},{symbol:"GC=F",type:"commodity"},{symbol:"SI=F",type:"commodity"},{symbol:"CL=F",type:"commodity"},{symbol:"^GSPC",type:"index"},{symbol:"^IXIC",type:"index"},{symbol:"AAPL",type:"stock"},{symbol:"MSFT",type:"stock"},{symbol:"NVDA",type:"stock"},{symbol:"AMZN",type:"stock"}];
async function telegram(message:string,userId:number){if(!env.BOT_TOKEN)return;const r=await fetch("https://api.telegram.org/bot"+env.BOT_TOKEN+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:userId,text:message}),signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error("Telegram HTTP "+r.status);}
async function getMarket(item:any){
 if(item.type==="crypto"){
  const pair=item.symbol;
  const [pr,cr]=await Promise.all([fetch("https://data-api.binance.vision/api/v3/ticker/price?symbol="+pair,{signal:AbortSignal.timeout(8000)}),fetch("https://data-api.binance.vision/api/v3/klines?symbol="+pair+"&interval=5m&limit=100",{signal:AbortSignal.timeout(9000)})]);
  const pj:any=await pr.json(),rows:any=await cr.json();const price=Number(pj.price);
  if(!pr.ok||!cr.ok||!Number.isFinite(price)||!Array.isArray(rows))throw new Error("Binance data unavailable "+pair);
  const now=Date.now(),candles=rows.map((x:any[])=>({t:+x[0],end:+x[6],o:+x[1],h:+x[2],l:+x[3],c:+x[4]})).filter((x:any)=>[x.t,x.end,x.o,x.h,x.l,x.c].every(Number.isFinite)&&x.end<now-1000&&x.l>0&&x.h>=Math.max(x.o,x.c)&&x.l<=Math.min(x.o,x.c)&&x.h>=x.l);
  if(candles.length<60||now-candles[candles.length-1].end>660000)throw new Error("Bougies 5m insuffisantes ou anciennes "+pair);
  return { ...item,price,candles:candles.slice(-80),currency:"USDT" };
 }
 const url=new URL("https://query1.finance.yahoo.com/v8/finance/chart/"+encodeURIComponent(item.symbol));
 url.searchParams.set("interval","5m");url.searchParams.set("range","5d");
 const r=await fetch(url,{headers:{"user-agent":"Mozilla/5.0"},signal:AbortSignal.timeout(10000)}),j:any=await r.json().catch(()=>null),z=j?.chart?.result?.[0],q=z?.indicators?.quote?.[0];
 if(!r.ok||!z||!q)throw new Error("Yahoo data unavailable "+item.symbol);
 const times=z.timestamp||[],now=Date.now(),candles=times.map((t:number,i:number)=>({t:t*1000,end:t*1000+300000,o:+q.open?.[i],h:+q.high?.[i],l:+q.low?.[i],c:+q.close?.[i]})).filter((x:any)=>[x.t,x.end,x.o,x.h,x.l,x.c].every(Number.isFinite)&&x.end<now-1000&&x.l>0&&x.h>=Math.max(x.o,x.c)&&x.l<=Math.min(x.o,x.c)&&x.h>=x.l);
 if(candles.length<60)throw new Error("Pas assez de bougies Yahoo "+item.symbol);
 const price=Number(z.meta?.regularMarketPrice||candles[candles.length-1].c);
 if(!Number.isFinite(price)||price<=0)throw new Error("Prix Yahoo invalide "+item.symbol);
 return {...item,price,candles:candles.slice(-80),currency:"USD"};
}
function ema(v:number[],n:number){let x=v.slice(0,n).reduce((a,b)=>a+b,0)/n,k=2/(n+1);for(const z of v.slice(n))x=z*k+x*(1-k);return x;}
function rsi(v:number[]){const d=v.slice(1).map((x,i)=>x-v[i]);let g=0,l=0;for(const x of d.slice(0,14)){g+=Math.max(0,x);l+=Math.max(0,-x);}g/=14;l/=14;for(const x of d.slice(14)){g=(g*13+Math.max(0,x))/14;l=(l*13+Math.max(0,-x))/14;}return l===0?(g===0?50:100):100-100/(1+g/l);}
function atr(a:any[]){const t:number[]=[];for(let i=Math.max(1,a.length-15);i<a.length;i++)t.push(Math.max(a[i].h-a[i].l,Math.abs(a[i].h-a[i-1].c),Math.abs(a[i].l-a[i-1].c)));return t.reduce((x,y)=>x+y,0)/Math.max(1,t.length);}
let cycleBusy=false;
async function closePosition(row:any,price:number,reason:string,stop=false){
 const qty=Number(row.quantity),entry=Number(row.entry_price),entryFee=Number(row.entry_fee),exitPrice=price*(1-0.0002),gross=qty*exitPrice,fee=gross*0.0005,proceeds=gross-fee,pnl=proceeds-(qty*entry+entryFee);
 await db.begin(async(tx:any)=>{
  await tx`UPDATE paper_auto_portfolios SET cash=cash+${proceeds},realized_pnl=realized_pnl+${pnl},updated_at=NOW() WHERE telegram_user_id=${row.telegram_user_id}`;
  await tx`INSERT INTO paper_auto_trades(telegram_user_id,symbol,market_type,side,quantity,price,fee,pnl,reason) VALUES(${row.telegram_user_id},${row.symbol},${row.market_type},'SELL',${qty},${exitPrice},${fee},${pnl},${reason})`;
  await tx`DELETE FROM paper_auto_positions WHERE telegram_user_id=${row.telegram_user_id} AND symbol=${row.symbol}`;
  await tx`INSERT INTO paper_auto_cooldowns(telegram_user_id,symbol,cooldown_until) VALUES(${row.telegram_user_id},${row.symbol},NOW()+INTERVAL '5 minutes') ON CONFLICT(telegram_user_id,symbol) DO UPDATE SET cooldown_until=EXCLUDED.cooldown_until`;
 });
 await telegram("🔔 JAMALQUANT · SORTIE SIMULÉE\n"+row.symbol+" ("+row.market_type+")\n"+reason+"\nP/L net estimé : "+(pnl>=0?"+":"")+fmt(pnl)+" USD\nAucun ordre réel.",Number(row.telegram_user_id));
}
async function scanPortfolio(account:any,positions:any[]){
 const uid=Number(account.telegram_user_id),now=Date.now();
 const held=new Map(positions.map((p:any)=>[p.symbol,p]));
 const results:any[]=[];let errors=0;
 for(let i=0;i<universe.length;i+=3){
  const batch=universe.slice(i,i+3);
  const settled=await Promise.allSettled(batch.map(getMarket));
  for(let j=0;j<settled.length;j++){
   const s=settled[j];if(s.status==="rejected"){errors++;console.warn("Market scan failed",batch[j].symbol,String(s.reason));continue;}
   const m=s.value,cs=m.candles,closes=cs.map((x:any)=>x.c),e20=ema(closes,20),e50=ema(closes,50),rv=rsi(closes),vol=atr(cs),last=cs[cs.length-1],prev=cs[cs.length-2];
   results.push(m);
   const pos:any=held.get(m.symbol);
   if(pos){
    const entry=Number(pos.entry_price),risk=Number(pos.initial_risk),high=Math.max(Number(pos.highest_price),m.price);
    let stop=Number(pos.stop_price);if(high>=entry+risk)stop=Math.max(stop,high-vol*1.2);
    if(m.price<=stop){await closePosition(pos,m.price,"Stop-loss / stop suiveur");continue;}
    if(m.price>=Number(pos.target_price)){await closePosition(pos,m.price,"Objectif théorique 2R atteint");continue;}
    if(e20<e50||rv<45){await closePosition(pos,m.price,"Momentum haussier invalidé");continue;}
    await db`UPDATE paper_auto_positions SET mark_price=${m.price},highest_price=${high},stop_price=${stop},updated_at=NOW() WHERE telegram_user_id=${uid} AND symbol=${m.symbol}`;
    continue;
   }
   const fresh=await db`SELECT status FROM paper_auto_portfolios WHERE telegram_user_id=${uid}`;
   if(!fresh.length||fresh[0].status!=="RUNNING")return;
   if(!(e20>e50&&last.c>e20&&rv>=52&&rv<=68&&last.c>prev.c&&vol>0))continue;
   const exists=await db`SELECT 1 FROM paper_auto_positions WHERE telegram_user_id=${uid} AND symbol=${m.symbol}`;if(exists.length)continue;const cooling=await db`SELECT 1 FROM paper_auto_cooldowns WHERE telegram_user_id=${uid} AND symbol=${m.symbol} AND cooldown_until>NOW()`;if(cooling.length)continue;
   const ep=m.price*(1+0.0002),distance=vol*1.5,budget=Math.min(Number(account.initial_capital)*0.003,Number(account.cash)*0.01),qtyRisk=budget/distance,qtyCash=Number(account.cash)*0.12/ep,qty=Math.min(qtyRisk,qtyCash),notional=qty*ep,fee=notional*0.0005,cost=notional+fee;
   if(!(qty>0&&notional>=10&&cost<=Number(account.cash)*0.2))continue;
   const stop=ep-distance,target=ep+distance*2;
   const inserted=await db.begin(async(tx:any)=>{
    const debited=await tx`UPDATE paper_auto_portfolios SET cash=cash-${cost},updated_at=NOW() WHERE telegram_user_id=${uid} AND status='RUNNING' AND cash>=${cost} RETURNING cash`;
    if(!debited.length)return false;
    const made=await tx`INSERT INTO paper_auto_positions(telegram_user_id,symbol,market_type,quantity,entry_price,entry_fee,mark_price,stop_price,target_price,highest_price,initial_risk,last_candle_time,updated_at) VALUES(${uid},${m.symbol},${m.type},${qty},${ep},${fee},${m.price},${stop},${target},${ep},${distance},${last.t},NOW()) ON CONFLICT(telegram_user_id,symbol) DO NOTHING RETURNING symbol`;
    if(!made.length){await tx`UPDATE paper_auto_portfolios SET cash=cash+${cost} WHERE telegram_user_id=${uid}`;return false;}
    await tx`INSERT INTO paper_auto_trades(telegram_user_id,symbol,market_type,side,quantity,price,fee,reason) VALUES(${uid},${m.symbol},${m.type},'BUY',${qty},${ep},${fee},'Signal EMA20/EMA50 + RSI + momentum')`;
    return true;
   });
   if(inserted)await telegram("🟢 JAMALQUANT · ENTRÉE SIMULÉE\n"+m.symbol+" ("+m.type+")\nPrix : "+fmt(ep)+"\nStop : "+fmt(stop)+"\nObjectif 2R : "+fmt(target)+"\nRisque budgété : "+fmt(budget)+" USD\nRSI : "+rv.toFixed(1)+"\nSimulation uniquement.",uid);
  }
 }
 return {scanned:results.length,errors,markets:results.map(x=>x.symbol)};
}
async function cycle(){
 if(cycleBusy)return {busy:true};
 cycleBusy=true;
 try{
  const accounts=await db`SELECT * FROM paper_auto_portfolios WHERE status='RUNNING' ORDER BY updated_at ASC`;
  for(const account of accounts){
   try{
    const positions=await db`SELECT * FROM paper_auto_positions WHERE telegram_user_id=${account.telegram_user_id}`;
    if(account.last_scan_at&&Date.now()-new Date(account.last_scan_at).getTime()<55000&&positions.length===0)continue;
    const result=await scanPortfolio(account,positions);
    await db`UPDATE paper_auto_portfolios SET updated_at=NOW(),last_scan_at=NOW() WHERE telegram_user_id=${account.telegram_user_id} AND status='RUNNING'`;
    console.log("Multi-market scan",account.telegram_user_id,JSON.stringify(result));
   }catch(err){console.error("Portfolio cycle error",account.telegram_user_id,err instanceof Error?err.message:String(err));}
  }
  return {ok:true,portfolios:accounts.length,universe:universe.length};
 }finally{cycleBusy=false;}
}
async function handle(req:Request){
 const url=new URL(req.url);
 if(url.pathname==="/health"&&req.method==="GET"){const x=await db`SELECT 1 AS ok`;return Response.json({ok:true,engine:"multi-market-paper-v2",database:x.length===1?"connected":"error",mode:"paper-trading-only",liveTradingEnabled:false,universe:universe.length,markets:universe});}
 if(req.headers.get("x-engine-secret")!==env.AUTO_ENGINE_SECRET)return new Response("Unauthorized",{status:401});
 let body:any={};try{body=await req.json();}catch{return new Response("Bad JSON",{status:400});}
 const userId=Number(body.userId);if(!Number.isSafeInteger(userId)||userId<=0)return Response.json({error:"Invalid userId"},{status:400});
 if(url.pathname==="/start"){
  const capital=Number(body.capital);if(!Number.isFinite(capital)||capital<50||capital>10000)return Response.json({error:"Capital fictif invalide (50 à 10 000 USDT)"},{status:400});
  const existing=await db`SELECT * FROM paper_auto_portfolios WHERE telegram_user_id=${userId}`;
  if(existing.length&&existing[0].status==="RUNNING")return Response.json({ok:true,alreadyRunning:true,capital:Number(existing[0].initial_capital),cash:Number(existing[0].cash),universe:universe.length});
  await db`INSERT INTO paper_auto_portfolios(telegram_user_id,initial_capital,cash,realized_pnl,status,updated_at) VALUES(${userId},${capital},${capital},0,'RUNNING',NOW()) ON CONFLICT(telegram_user_id) DO UPDATE SET initial_capital=EXCLUDED.initial_capital,cash=EXCLUDED.cash,realized_pnl=0,status='RUNNING',updated_at=NOW()`;
  void cycle().catch(err=>console.error('Initial multi-market scan failed',err instanceof Error?err.message:String(err)));
  await telegram("🚀 JAMALQUANT MULTI-MARCHÉS ACTIVÉ\nCapital fictif : "+fmt(capital)+" USD\nUnivers : "+universe.length+" marchés (crypto, forex, matières premières, indices, actions)\nScan automatique toutes les ~60 secondes.\nMode simulation : aucun ordre réel, aucun gain garanti.",userId);
  return Response.json({ok:true,alreadyRunning:false,capital,universe:universe.length,markets:universe.map(x=>x.symbol),scanStarted:true});
 }
 if(url.pathname==="/status"){
  const rows=await db`SELECT * FROM paper_auto_portfolios WHERE telegram_user_id=${userId}`;if(!rows.length)return Response.json({error:"Aucun portefeuille"},{status:404});
  const a=rows[0],positions=await db`SELECT * FROM paper_auto_positions WHERE telegram_user_id=${userId} ORDER BY updated_at DESC`,trades=await db`SELECT symbol,side,quantity,price,fee,pnl,reason,created_at FROM paper_auto_trades WHERE telegram_user_id=${userId} ORDER BY created_at DESC LIMIT 20`;
  let unrealized=0;for(const x of positions)unrealized+=(Number(x.mark_price)-Number(x.entry_price))*Number(x.quantity)-Number(x.entry_fee);
  const equity=Number(a.cash)+positions.reduce((s:number,x:any)=>s+Number(x.quantity)*Number(x.mark_price),0);
  return Response.json({ok:true,status:a.status,capital:Number(a.initial_capital),cash:Number(a.cash),realized:Number(a.realized_pnl),unrealized,equity,pnl:equity-Number(a.initial_capital),openPositions:positions.length,positions:positions.map((x:any)=>({symbol:x.symbol,marketType:x.market_type,quantity:Number(x.quantity),entry:Number(x.entry_price),price:Number(x.mark_price),stop:Number(x.stop_price),target:Number(x.target_price)})),trades,universe:universe.length,markets:universe.map(x=>x.symbol)});
 }
 if(url.pathname==="/stop"){
  const a=await db`SELECT * FROM paper_auto_portfolios WHERE telegram_user_id=${userId} AND status='RUNNING'`;if(!a.length)return Response.json({error:"Aucun portefeuille actif"},{status:404});
  const positions=await db`SELECT * FROM paper_auto_positions WHERE telegram_user_id=${userId}`;
  for(const x of positions)await closePosition(x,Number(x.mark_price),"Arrêt demandé",true);
  await db`UPDATE paper_auto_portfolios SET status='STOPPED',updated_at=NOW() WHERE telegram_user_id=${userId}`;
  return Response.json({ok:true,stopped:true,closedPositions:positions.length});
 }
 if(url.pathname==="/cycle"){const result=await cycle();return Response.json({ok:true,...result});}
 return new Response("Not found",{status:404});
}
Bun.serve({port:Number(env.PORT||3000),fetch:handle});

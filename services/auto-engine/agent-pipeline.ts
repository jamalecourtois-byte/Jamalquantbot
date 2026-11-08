type Candle = { t:number; o:number; h:number; l:number; c:number; v?:number };
type Market = { symbol:string; type:string };
type Input = {
  item:Market; candles:Candle[]; price:number; ema20:number; ema50:number; rsi:number; atr:number;
  riskBudget:number; availableCash:number; maxOrderNotional:number; minimumOrderNotional?:number; onProgress?:(agents:any[])=>void;
};
const newsCache = new Map<string,{at:number; headlines:string[]}>();
const clamp=(n:number,min:number,max:number)=>Math.max(min,Math.min(max,n));
const mean=(a:number[])=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
function ema(values:number[],period:number){if(values.length<period)return mean(values);let v=mean(values.slice(0,period)),k=2/(period+1);for(const x of values.slice(period))v=x*k+v*(1-k);return v;}
function rsi(values:number[],end=values.length-1,period=14){const s=values.slice(0,Math.min(values.length,end+1));if(s.length<=period)return 50;let gain=0,loss=0;for(let i=1;i<=period;i++){const d=s[i]-s[i-1];gain+=Math.max(0,d);loss+=Math.max(0,-d);}let avgGain=gain/period,avgLoss=loss/period;for(let i=period+1;i<s.length;i++){const d=s[i]-s[i-1];avgGain=(avgGain*(period-1)+Math.max(0,d))/period;avgLoss=(avgLoss*(period-1)+Math.max(0,-d))/period;}if(avgLoss===0)return avgGain===0?50:100;const rs=avgGain/avgLoss;return 100-100/(1+rs);}
function atrAt(c:Candle[],end:number,period=14){const rows:number[]=[];for(let i=Math.max(1,end-period+1);i<=end;i++)rows.push(Math.max(c[i].h-c[i].l,Math.abs(c[i].h-c[i-1].c),Math.abs(c[i].l-c[i-1].c)));return mean(rows);}
function marketQuery(item:Market){const map:Record<string,string>={"BTCUSDT":"Bitcoin cryptocurrency","ETHUSDT":"Ethereum cryptocurrency","SOLUSDT":"Solana cryptocurrency","BNBUSDT":"Binance Coin cryptocurrency","XRPUSDT":"XRP cryptocurrency","DOGEUSDT":"Dogecoin cryptocurrency","LINKUSDT":"Chainlink cryptocurrency","AVAXUSDT":"Avalanche cryptocurrency","EURUSD=X":"EUR USD euro dollar forex","GBPUSD=X":"GBP USD pound dollar forex","GC=F":"gold commodities","SI=F":"silver commodities","CL=F":"crude oil commodities","^GSPC":"S&P 500 US equities","^IXIC":"Nasdaq technology stocks","AAPL":"Apple stock","MSFT":"Microsoft stock","NVDA":"Nvidia stock","AMZN":"Amazon stock"};return map[item.symbol]||item.symbol;}
async function headlines(item:Market){
 const key=item.symbol,old=newsCache.get(key);if(old&&Date.now()-old.at<300000)return old.headlines;
 const url="https://news.google.com/rss/search?q="+encodeURIComponent(marketQuery(item)+" when:7d")+"&hl=en-US&gl=US&ceid=US:en";
 try{const r=await fetch(url,{headers:{"user-agent":"Mozilla/5.0 JamalQuantBot/1.0"},signal:AbortSignal.timeout(7000)});if(!r.ok)throw new Error("RSS HTTP "+r.status);const xml=await r.text();const titles=[...xml.matchAll(/<title>([\s\S]*?)<\/title>/gi)].slice(1,21).map(m=>m[1].replace(/<!\[CDATA\[|\]\]>/g,"").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/<[^>]*>/g,"").trim()).filter(Boolean);newsCache.set(key,{at:Date.now(),headlines:titles});return titles;}catch{newsCache.set(key,{at:Date.now(),headlines:[]});return [];}
}
const wordSets=[
 {up:["growth","beat estimates","upgrade","surge","rally","record high","bullish","inflow","adoption","partnership","hausse","croissance","rebond"],down:["recession","miss estimates","downgrade","crash","selloff","bearish","outflow","default","baisse","chute","récession"]},
 {up:["rate cut","easing","stimulus","approval","approved","regulation clarity","dovish","tax cut","assouplissement","approbation"],down:["rate hike","tightening","ban","lawsuit","investigation","sanction","hawkish","tariff","interdiction","procès","sanction"]},
 {up:["ceasefire","peace deal","de-escalation","supply restored","trade deal","truce","accord de paix","désescalade"],down:["war","attack","escalation","conflict","blockade","disruption","shortage","invasion","guerre","attaque","blocus"]},
 {up:["launch","product demand","revenue growth","market share","buyback","contract win","earnings beat","lancement","demande","contrat"],down:["recall","outage","data breach","earnings miss","guidance cut","layoffs","bankruptcy","rappel","panne","licenciement","faillite"]}
];
export async function warmNews(items:Market[]){await Promise.all(items.map(item=>headlines(item)));}
function sentiment(titles:string[],set:number){let score=0;for(const title of titles){const t=title.toLowerCase();for(const w of wordSets[set].up)if(t.includes(w))score++;for(const w of wordSets[set].down)if(t.includes(w))score--;}return clamp(score,-8,8);}
function backtest(c:Candle[],variant:number){
 const closes=c.map(x=>x.c),outcomes:number[]=[];
 // Backtest on closed candles only; sequential positions prevent overlapping samples.
 const longHistory=c.length>=800,runs=longHistory?Math.min(900,c.length-63):Math.min(100,Math.max(0,c.length-63));
 const first=c.length-runs-13,last=first+runs-1;let nextAllowed=first;
 for(let i=first;i<=last;i++){
  if(longHistory&&i<nextAllowed)continue;
  const history=closes.slice(0,i+1),fast=ema(history,variant===0?9:variant===1?12:variant===2?20:variant===3?8:14),slow=ema(history,variant===0?21:variant===1?26:variant===2?50:variant===3?18:34);
  const rv=rsi(closes,i),a=atrAt(c,i),p=closes[i];if(!(a>0&&p>0))continue;
  const priorHigh=Math.max(...c.slice(Math.max(0,i-20),i).map(x=>x.h));
  const momentum=p/closes[Math.max(0,i-5)]-1;
  const entry=variant===0?fast>slow&&rv>50&&rv<68:variant===1?fast>slow&&rv>45&&rv<62:variant===2?p>priorHigh&&rv<72:variant===3?momentum>0.002&&rv<70:fast>slow&&momentum>0&&rv>48&&rv<65;
  if(!entry)continue;
  const riskUnit=1.5*a,stop=p-riskUnit,target=p+2*riskUnit;let outcomeR=0,exitIndex=Math.min(i+12,c.length-1);
  for(let j=i+1;j<=exitIndex;j++){const bar=c[j];if(bar.l<=stop){outcomeR=-1;exitIndex=j;break;}if(bar.h>=target){outcomeR=2;exitIndex=j;break;}}
  if(outcomeR===0)outcomeR=(c[exitIndex].c-p)/riskUnit;
  // Approximate round-trip taker fees and slippage: 0.14% of notional, expressed in R.
  outcomeR-=((p*0.0014)/riskUnit);
  outcomes.push(outcomeR);
  if(longHistory)nextAllowed=exitIndex+1;
 }
 const wins=outcomes.filter(x=>x>0),losses=outcomes.filter(x=>x<0),winRate=outcomes.length?wins.length/outcomes.length*100:0;
 const grossProfit=wins.reduce((a,b)=>a+b,0),grossLoss=Math.abs(losses.reduce((a,b)=>a+b,0));
 const rr=grossLoss>0?grossProfit/Math.max(1,wins.length)/(grossLoss/Math.max(1,losses.length)):grossProfit>0?99:0;
 const profitFactor=grossLoss>0?grossProfit/grossLoss:grossProfit>0?99:0;
 const expectancyR=mean(outcomes),minimumTrades=30;
 const fastPeriod=variant===0?9:variant===1?12:variant===2?20:variant===3?8:14,slowPeriod=variant===0?21:variant===1?26:variant===2?50:variant===3?18:34;
 const currentFast=ema(closes,fastPeriod),currentSlow=ema(closes,slowPeriod),currentRsi=rsi(closes),currentPrice=closes[closes.length-1];
 const currentPriorHigh=Math.max(...c.slice(Math.max(0,c.length-21),c.length-1).map(x=>x.h));
 const currentMomentum=currentPrice/closes[Math.max(0,closes.length-6)]-1;
 const currentEntry=variant===0?currentFast>currentSlow&&currentRsi>50&&currentRsi<68:variant===1?currentFast>currentSlow&&currentRsi>45&&currentRsi<62:variant===2?currentPrice>currentPriorHigh&&currentRsi<72:variant===3?currentMomentum>0.002&&currentRsi<70:currentFast>currentSlow&&currentMomentum>0&&currentRsi>48&&currentRsi<65;
 const passed=outcomes.length>=minimumTrades&&expectancyR>=0.05&&profitFactor>=1.1;
 const rejectionReason=outcomes.length<minimumTrades?"Échantillon insuffisant ("+outcomes.length+"/"+minimumTrades+")":expectancyR<0.05?"Espérance nette insuffisante ("+expectancyR.toFixed(2)+" R)":profitFactor<1.1?"Profit factor insuffisant ("+profitFactor.toFixed(2)+")":!currentEntry?"Backtest positif, mais aucun signal d’entrée actuel":"";
 return {runs,samples:outcomes.length,trades:outcomes.length,minimumTrades,winRate:Number(winRate.toFixed(1)),rewardRisk:Number(rr.toFixed(2)),profitFactor:Number(profitFactor.toFixed(2)),expectancyR:Number(expectancyR.toFixed(3)),passed,currentEntry,rejectionReason};
}
export async function runAgentPipeline(input:Input){
 const {item,candles:c,price,ema20,ema50,rsi:rv,atr:a}=input,closes=c.map(x=>x.c),last=c.at(-1)!,prior=c.at(-2)!;
 const recent=c.slice(-20),prior20=c.slice(-40,-20),volNow=mean(recent.map(x=>Number(x.v)||0)),volPrev=mean(prior20.map(x=>Number(x.v)||0));
 const returns=closes.slice(-21).slice(1).map((x,i)=>x/closes.slice(-21)[i]-1),volatility=Math.sqrt(mean(returns.map(x=>x*x)));
 const technical=[
  {name:"Tendance multi-période",ok:ema20>ema50,detail:ema20>ema50?"EMA20 au-dessus EMA50":"EMA20 sous EMA50"},
  {name:"Structure des prix",ok:price>ema20&&last.c>prior.c,detail:"Cours vs EMA20 et clôture précédente"},
  {name:"Momentum RSI",ok:rv>=50&&rv<=68,detail:"RSI "+rv.toFixed(1)},
  {name:"Volatilité",ok:volatility>0.0003&&volatility<0.04,detail:"Volatilité réalisée "+(volatility*100).toFixed(2)+"%"},
  {name:"Volume / activité",ok:volPrev>0&&volNow>=volPrev*0.75,detail:"Volume récent "+(volPrev>0?(volNow/volPrev).toFixed(2):"indisponible")+"×"},
  {name:"Cassure / structure",ok:last.c>Math.max(...recent.slice(0,-1).map(x=>x.h)),detail:"Clôture vs plus haut des 19 bougies précédentes"}
 ];
 input.onProgress?.(technical.map(x=>({...x,group:"TECHNIQUE",verdict:x.ok?"VALIDÉ":"REFUSÉ"})));
 const news=await headlines(item),newsVotes=wordSets.map((_,i)=>{const score=sentiment(news,i);return {name:["Macroéconomie mondiale","Banques centrales et régulation","Géopolitique et offre","Actualités sectorielles"][i],score,bias:score>=2?"HAUSSIER":score<=-2?"BAISSIER":"NEUTRE",detail:news.length?news.length+" titres récents analysés":"Aucune actualité exploitable · neutre"};});
 input.onProgress?.([...technical.map(x=>({...x,group:"TECHNIQUE",verdict:x.ok?"VALIDÉ":"REFUSÉ"})),...newsVotes.map(x=>({...x,group:"ACTUALITÉS",ok:x.bias!=="BAISSIER",verdict:x.bias}))]);
 const simulations=Array.from({length:5},(_,i)=>({name:["Simulation EMA / RSI","Simulation pullback","Simulation breakout","Simulation momentum","Simulation multi-facteurs"][i],...backtest(c,i)}));
 input.onProgress?.([...technical.map(x=>({...x,group:"TECHNIQUE",verdict:x.ok?"VALIDÉ":"REFUSÉ"})),...newsVotes.map(x=>({...x,group:"ACTUALITÉS",ok:x.bias!=="BAISSIER",verdict:x.bias})),...simulations.map(x=>({...x,group:"BACKTEST "+x.runs, ok:x.passed&&x.currentEntry,verdict:x.passed?(x.currentEntry?"VALIDÉ · SIGNAL ACTUEL":"VALIDÉ · ATTENTE"):"REFUSÉ",detail:x.runs+" bougies · "+x.trades+"/"+x.minimumTrades+" trades · "+x.winRate+"% gagnants · PF "+x.profitFactor+" · espérance "+x.expectancyR+" R · "+(x.passed?(x.currentEntry?"historique validé + entrée actuelle":"historique validé, attente signal"):x.rejectionReason)}))]);
 const stopDistance=1.5*a,stopLoss=price-stopDistance,riskBudget=Math.max(0,input.riskBudget),qtyRisk=stopDistance>0?riskBudget/stopDistance:0;
 // Cap the quantity by BOTH available cash and the configured per-order notional.
 // Previously the 12% cash cap could exceed maxOrderNotional and reject every otherwise valid signal.
 const cashCap=Math.max(0,Math.min(input.availableCash*0.12,input.maxOrderNotional));
 const qtyCash=price>0?cashCap/price:0,quantity=Math.max(0,Math.min(qtyRisk,qtyCash)),notional=quantity*price;
 const risk=[
  {name:"Stop-loss et distance de risque",ok:stopLoss>0&&stopDistance/price>=0.0005&&stopDistance/price<=0.05,detail:"Stop "+stopLoss.toPrecision(8)+" · distance "+(stopDistance/price*100).toFixed(2)+"%"},
  {name:"Taille de position",ok:quantity>0&&notional<=input.maxOrderNotional&&notional<=input.availableCash*0.12,detail:"Quantité "+quantity.toPrecision(6)+" · exposition "+notional.toFixed(2)},
  {name:"Minimum d'ordre Binance",ok:notional>=(input.minimumOrderNotional??10),detail:"Notionnel "+notional.toFixed(2)+" · minimum "+(input.minimumOrderNotional??10).toFixed(2)}
 ];
 input.onProgress?.([...technical.map(x=>({...x,group:"TECHNIQUE",verdict:x.ok?"VALIDÉ":"REFUSÉ"})),...newsVotes.map(x=>({...x,group:"ACTUALITÉS",ok:x.bias!=="BAISSIER",verdict:x.bias})),...simulations.map(x=>({...x,group:"BACKTEST "+x.runs, ok:x.passed&&x.currentEntry,verdict:x.passed?(x.currentEntry?"VALIDÉ · SIGNAL ACTUEL":"VALIDÉ · ATTENTE"):"REFUSÉ",detail:x.runs+" tests · "+x.trades+" trades · "+x.winRate+"% réussite · R/R "+x.rewardRisk+" · "+(x.currentEntry?"entrée actuelle confirmée":"pas d’entrée actuelle")})),...risk.map(x=>({...x,group:"RISQUE",verdict:x.ok?"VALIDÉ":"REFUSÉ"}))]);
 const technicalVotes=technical.filter(x=>x.ok).length;
 const newsSupportVotes=newsVotes.filter(x=>x.bias!=="BAISSIER").length;
 const simulationPasses=simulations.filter(x=>x.passed).length;
 // Les cinq backtests sont des stratégies alternatives, pas cinq votes indépendants.
 // Une stratégie doit être validée historiquement ET déclencher son entrée sur la bougie actuelle.
 const eligibleStrategies=simulations.filter(x=>x.passed&&x.currentEntry).sort((a,b)=>b.rewardRisk-a.rewardRisk||b.winRate-a.winRate);
 const selectedStrategy=eligibleStrategies[0]||null;
 const techPass=technicalVotes>=4,newsPass=newsSupportVotes>=3,simPass=!!selectedStrategy,riskPass=risk.every(x=>x.ok);
 const valid=techPass&&newsPass&&simPass&&riskPass;
 const gate={technicalVotes,totalTechnical:technical.length,newsSupportVotes,totalNews:newsVotes.length,simulationPasses,totalSimulations:simulations.length,eligibleStrategies:eligibleStrategies.length,selectedStrategy:selectedStrategy?.name||null,riskPassed:risk.filter(x=>x.ok).length,totalRisk:risk.length,valid};
 const agents=[...technical.map(x=>({...x,group:"TECHNIQUE",verdict:x.ok?"VALIDÉ":"REFUSÉ"})),...newsVotes.map(x=>({...x,group:"ACTUALITÉS",ok:x.bias!=="BAISSIER",verdict:x.bias})),...simulations.map(x=>({...x,group:"BACKTEST "+x.runs, ok:x.passed&&x.currentEntry,verdict:x.passed?(x.currentEntry?"VALIDÉ · SIGNAL ACTUEL":"VALIDÉ · ATTENTE"):"REFUSÉ",detail:x.runs+" tests · "+x.trades+" trades · "+x.winRate+"% réussite · R/R "+x.rewardRisk+" · "+(x.currentEntry?"entrée actuelle confirmée":"pas d’entrée actuelle")})),...risk.map(x=>({...x,group:"RISQUE",verdict:x.ok?"VALIDÉ":"REFUSÉ"})),{name:"Agent 19 · Validation finale",group:"GATE FINAL",ok:valid,verdict:valid?"TRADE VALIDÉ":"PAS DE TRADE",detail:"Technique "+technicalVotes+"/6 (min. 4) · Actualités "+newsSupportVotes+"/4 (min. 3) · Stratégie validée "+(selectedStrategy?.name||"aucune entrée actuelle")+" · Risque "+(riskPass?"3/3 OK":"REFUSÉ")}];
 input.onProgress?.(agents);
 return {valid,gate,agents,agentVotes:agents.map(x=>({name:x.name,bullish:!!x.ok,verdict:x.verdict,group:x.group,detail:x.detail||""})),bullishVotes:agents.filter(x=>x.ok).length,totalAgents:19,consensus:valid?"ACHAT · "+selectedStrategy.name:"PAS DE TRADE",selectedStrategy,newsBias:newsVotes.map(x=>x.bias),simulation:simulations,risk:{stopLoss,quantity,notional}};
}

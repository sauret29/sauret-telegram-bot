// ============================================================
// Bitman Confluencia · Bot de alertas EN VIVO — v2 (señal en 4H)
// ------------------------------------------------------------
// Implementa la estrategia validada en el backtest, ACTUALIZADA
// el 30 de julio de 2026 tras comprobar que la señal en 1H no
// sobrevivía a comisiones reales de Bitget:
//   - Entrada en 4H (no en 1H): el propio 4H tiene que dar su
//     señal completa (AO+ADX+Koncorde), confirmada por el Diario
//     (AO+Koncorde a favor de la misma dirección).
//   - SIN stop loss: la posición solo se cierra por Take Profit
//     (+3% de precio = +15% sobre la posición con 5x) o porque
//     el veredicto deja de confirmar esa dirección.
//   - Recomendación de gestión (se recuerda en cada aviso, pero
//     el bot NO opera ni mueve dinero): 12% del capital por
//     operación, 5x de apalancamiento — validado con comisiones
//     reales incluidas y con los últimos 12 meses reservados
//     como fuera de muestra (ver ESTRATEGIA-confluencia-sin-sl.md).
//
// Este bot lleva la cuenta de si hay o no una posición "abierta"
// (guardado en state-confluencia.json), porque el aviso de salida
// depende de si se tocó el TP o no.
// ============================================================

const fs = require('fs');
const path = require('path');

const SYMBOL = process.env.SYMBOL || 'BTCUSDT';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || '')
  .split(',').map(id => id.trim()).filter(id => id.length > 0);

const LEVERAGE_INFO = 5;     // apalancamiento (se usa también para calcular el TP)
const RISK_PCT_INFO = 12;    // solo informativo, se recuerda en el mensaje (validado 12-20%)

// El TP se define como % de beneficio sobre la POSICIÓN APALANCADA (lo que
// realmente ves en tu cuenta), no como % de movimiento de precio. Con 5x,
// pedir un 15% de beneficio sobre la posición implica que el precio solo
// tiene que moverse un 15/5 = 3%.
const TP_EQUITY_PCT = 15;
const TP_PCT = TP_EQUITY_PCT / LEVERAGE_INFO; // % de movimiento de PRECIO necesario

const STATE_FILE = path.join(__dirname, 'state-confluencia.json');

const HOSTS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com'
];
const SIGNAL_LIMIT = 1000;

async function fetchKlinesRaw(interval, limit, endTime){
  let lastError=null;
  for(const host of HOSTS){
    try{
      let url = `${host}/api/v3/klines?symbol=${encodeURIComponent(SYMBOL)}&interval=${interval}&limit=${limit}`;
      if(endTime) url += `&endTime=${endTime}`;
      const resp = await fetch(url);
      if(!resp.ok){ lastError=new Error(`HTTP ${resp.status}`); continue; }
      const data = await resp.json();
      if(!Array.isArray(data) || data.length===0){ lastError=new Error('Respuesta vacía'); continue; }
      return data;
    }catch(err){ lastError=err; continue; }
  }
  throw lastError || new Error('No se pudo contactar Binance');
}

// Para el bot en vivo basta con un histórico moderado (suficiente para el
// calentamiento de los indicadores) — no hace falta años de datos aquí,
// solo lo justo para que Koncorde/ADX/BBWP tengan su ventana ya estable.
async function fetchRecentCandles(interval, targetCandles){
  let all = await fetchKlinesRaw(interval, SIGNAL_LIMIT);
  if(all.length < targetCandles){
    try{
      const oldestOpenTime = all[0][0];
      const page2 = await fetchKlinesRaw(interval, SIGNAL_LIMIT, oldestOpenTime-1);
      if(page2 && page2.length) all = page2.concat(all);
    }catch(e){ /* seguimos con lo que tenemos */ }
  }
  const map = new Map();
  all.forEach(k=>map.set(k[0],k));
  const sorted = Array.from(map.values()).sort((a,b)=>a[0]-b[0]);
  const capped = sorted.slice(-targetCandles);
  return {
    times:capped.map(k=>k[0]),
    opens:capped.map(k=>parseFloat(k[1])),
    highs:capped.map(k=>parseFloat(k[2])),
    lows:capped.map(k=>parseFloat(k[3])),
    closes:capped.map(k=>parseFloat(k[4])),
    volumes:capped.map(k=>parseFloat(k[5]))
  };
}

function loadState(){
  try{
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }catch(e){
    return { position: null, entryPrice: null, tpPrice: null, entryTime: null };
  }
}
function saveState(state){
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function sendTelegramMessage(text){
  if(!TELEGRAM_BOT_TOKEN || TELEGRAM_CHAT_IDS.length === 0){
    console.log('[SIN CONFIGURAR] Falta TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID.');
    console.log('Mensaje que se habría enviado:\n' + text);
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  for(const chatId of TELEGRAM_CHAT_IDS){
    try{
      const resp = await fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
      });
      if(!resp.ok){
        const body = await resp.text();
        console.error('Error al enviar a Telegram (chat_id ' + chatId + '): HTTP ' + resp.status + ' — ' + body);
      } else {
        console.log('Mensaje enviado correctamente a chat_id ' + chatId + '.');
      }
    }catch(err){
      console.error('Error de red al enviar a Telegram (chat_id ' + chatId + '): ' + err.message);
    }
  }
}

function escapeHtml(str){
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ============================================================
// MOTOR DE INDICADORES (copia exacta, validada en el backtest)
// ============================================================
function safeDiv(a,b){
  if(b===0||b==null||a==null||isNaN(a)||isNaN(b)) return 0;
  const r=a/b; return isFinite(r)?r:0;
}
function sma(values,period){
  const out=new Array(values.length).fill(NaN);
  let sum=0, count=0;
  for(let i=0;i<values.length;i++){
    const v=values[i];
    if(v!=null && !isNaN(v)){ sum+=v; count++; }
    if(i>=period){
      const old=values[i-period];
      if(old!=null && !isNaN(old)){ sum-=old; count--; }
    }
    if(i>=period-1 && count===period) out[i]=sum/period;
  }
  return out;
}
function ema(values,period){
  const out=new Array(values.length).fill(NaN);
  const k=2/(period+1); let seeded=false, prev=NaN;
  for(let i=0;i<values.length;i++){
    if(values[i]==null||isNaN(values[i])){ out[i]=prev; continue; }
    if(!seeded){ prev=values[i]; out[i]=prev; seeded=true; }
    else { prev=values[i]*k+prev*(1-k); out[i]=prev; }
  }
  return out;
}
function stdevPop(values,period){
  const out=new Array(values.length).fill(NaN);
  for(let i=0;i<values.length;i++){
    if(i>=period-1){
      const slice=values.slice(i-period+1,i+1);
      const mean=slice.reduce((a,b)=>a+b,0)/period;
      const varr=slice.reduce((a,b)=>a+(b-mean)*(b-mean),0)/period;
      out[i]=Math.sqrt(Math.max(varr,0));
    }
  }
  return out;
}
function highestPeriod(values,period){
  const out=new Array(values.length).fill(NaN);
  for(let i=0;i<values.length;i++){
    if(i>=period-1) out[i]=Math.max(...values.slice(i-period+1,i+1));
  }
  return out;
}
function lowestPeriod(values,period){
  const out=new Array(values.length).fill(NaN);
  for(let i=0;i<values.length;i++){
    if(i>=period-1) out[i]=Math.min(...values.slice(i-period+1,i+1));
  }
  return out;
}
function rsiWilder(values,period){
  const out=new Array(values.length).fill(NaN);
  let avgGain=0, avgLoss=0;
  for(let i=1;i<values.length;i++){
    const change=values[i]-values[i-1];
    const gain=change>0?change:0, loss=change<0?-change:0;
    if(i<=period){
      avgGain+=gain; avgLoss+=loss;
      if(i===period){
        avgGain/=period; avgLoss/=period;
        const rs=safeDiv(avgGain,avgLoss);
        out[i]=avgLoss===0?100:(100-safeDiv(100,(1+rs)));
      }
    } else {
      avgGain=(avgGain*(period-1)+gain)/period;
      avgLoss=(avgLoss*(period-1)+loss)/period;
      const rs=safeDiv(avgGain,avgLoss);
      out[i]=avgLoss===0?100:(100-safeDiv(100,(1+rs)));
    }
  }
  return out;
}
// ---------- ML RSI [BackQuant] ----------
// Réplica fiel del indicador de TradingView: RSI(14) de Wilder, suavizado con
// EMA(4), y umbrales dinámicos calculados con clustering k-means (3 grupos)
// sobre la ventana de RSI reciente (hasta 3000 valores). El centro del grupo
// más alto es el umbral verde (alcista); el del más bajo, el rojo (bajista).
// Solo se calcula para la última vela (no hace falta el histórico completo
// para decidir el veredicto actual, y así se evita recalcular el clustering
// en cada barra, que sería muy costoso).
function percentileLinearInterpolation(sortedArr, p){
  const n = sortedArr.length;
  if(n===0) return NaN;
  if(n===1) return sortedArr[0];
  const rank = (p/100)*(n-1);
  const lower = Math.floor(rank), upper = Math.ceil(rank);
  const frac = rank - lower;
  if(upper>=n) return sortedArr[n-1];
  return sortedArr[lower] + (sortedArr[upper]-sortedArr[lower])*frac;
}
function kmeans1D(values, maxIter){
  const sorted = values.slice().sort((a,b)=>a-b);
  let centroids = [
    percentileLinearInterpolation(sorted,25),
    percentileLinearInterpolation(sorted,50),
    percentileLinearInterpolation(sorted,75)
  ];
  for(let iter=0; iter<=maxIter; iter++){
    const clusters=[[],[],[]];
    for(const v of values){
      let bestIdx=0, bestDist=Infinity;
      for(let c=0;c<3;c++){
        const d=Math.abs(v-centroids[c]);
        if(d<bestDist){ bestDist=d; bestIdx=c; }
      }
      clusters[bestIdx].push(v);
    }
    const newCentroids = centroids.map((old,idx)=> clusters[idx].length ? clusters[idx].reduce((a,b)=>a+b,0)/clusters[idx].length : old);
    const same = newCentroids.every((c,idx)=>c===centroids[idx]);
    centroids = newCentroids;
    if(same) break;
  }
  return centroids; // [centroide bajo, centroide medio, centroide alto]
}
function computeMLRSI(closes, opts){
  opts = opts || {};
  const length = opts.length || 14;
  const smoothPeriod = opts.smoothPeriod || 4;
  const maxData = opts.maxData || 3000;
  const maxIter = opts.maxIter || 1000;

  const rsiRaw = rsiWilder(closes, length);
  const rsiSmoothed = ema(rsiRaw, smoothPeriod);

  const validIdx = [];
  for(let i=0;i<rsiSmoothed.length;i++){
    if(!isNaN(rsiSmoothed[i])) validIdx.push(i);
  }
  const windowIdx = validIdx.slice(-maxData);
  const values = windowIdx.map(i=>rsiSmoothed[i]);

  if(values.length < 3){
    return { rsi:NaN, longThreshold:NaN, shortThreshold:NaN, signal:'Sin datos' };
  }

  const centroids = kmeans1D(values, maxIter);
  const longS = centroids[2], shortS = centroids[0];
  const lastRsi = rsiSmoothed[rsiSmoothed.length-1];

  let signal = 'Neutral';
  if(!isNaN(lastRsi)){
    if(lastRsi > longS) signal = 'Alcista';
    else if(lastRsi < shortS) signal = 'Bajista';
  }
  return { rsi:lastRsi, longThreshold:longS, shortThreshold:shortS, signal };
}
function formatMLRSI(mlRsi){
  if(!mlRsi || isNaN(mlRsi.rsi)) return 'ML RSI: sin datos suficientes todavía.';
  if(mlRsi.signal==='Alcista') return 'ML RSI: Alcista ('+mlRsi.rsi.toFixed(1)+' cruzó por encima del umbral verde '+mlRsi.longThreshold.toFixed(1)+').';
  if(mlRsi.signal==='Bajista') return 'ML RSI: Bajista ('+mlRsi.rsi.toFixed(1)+' cruzó por debajo del umbral rojo '+mlRsi.shortThreshold.toFixed(1)+').';
  return 'ML RSI: Neutral ('+mlRsi.rsi.toFixed(1)+', entre '+mlRsi.shortThreshold.toFixed(1)+' y '+mlRsi.longThreshold.toFixed(1)+').';
}

function mfiTypical(highs,lows,closes,volumes,period,typicalArr){
  const n=closes.length;
  const typical = typicalArr || highs.map((h,i)=>(h+lows[i]+closes[i])/3);
  const rawFlow = typical.map((tp,i)=>tp*volumes[i]);
  const out=new Array(n).fill(NaN);
  for(let i=period;i<n;i++){
    let pos=0,neg=0;
    for(let j=i-period+1;j<=i;j++){
      if(j===0) continue;
      if(typical[j]>typical[j-1]) pos+=rawFlow[j];
      else if(typical[j]<typical[j-1]) neg+=rawFlow[j];
    }
    if(neg===0) out[i]=100;
    else { const mr=safeDiv(pos,neg); out[i]=100-safeDiv(100,(1+mr)); }
  }
  return out;
}
function stochasticSmoothed(source,highs,lows,period,smoothPeriod){
  const n=source.length;
  const hh=highestPeriod(highs,period), ll=lowestPeriod(lows,period);
  const k=new Array(n).fill(NaN);
  for(let i=0;i<n;i++){
    if(!isNaN(hh[i])&&!isNaN(ll[i])) k[i]=safeDiv((source[i]-ll[i])*100,(hh[i]-ll[i]));
  }
  return sma(k,smoothPeriod);
}
function awesomeOscillator(highs,lows){
  const n=highs.length;
  const median=highs.map((h,i)=>(h+lows[i])/2);
  const fast=sma(median,5), slow=sma(median,34);
  const out=new Array(n).fill(NaN);
  for(let i=0;i<n;i++) if(!isNaN(fast[i])&&!isNaN(slow[i])) out[i]=fast[i]-slow[i];
  return out;
}
function adxWilder(highs,lows,closes,period){
  const n=closes.length;
  const tr=new Array(n).fill(0), plusDM=new Array(n).fill(0), minusDM=new Array(n).fill(0);
  for(let i=1;i<n;i++){
    const hd=highs[i]-highs[i-1], ld=lows[i-1]-lows[i];
    plusDM[i]=(hd>ld&&hd>0)?hd:0;
    minusDM[i]=(ld>hd&&ld>0)?ld:0;
    tr[i]=Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1]));
  }
  const smTR=new Array(n).fill(NaN), smP=new Array(n).fill(NaN), smM=new Array(n).fill(NaN);
  const plusDI=new Array(n).fill(NaN), minusDI=new Array(n).fill(NaN), dx=new Array(n).fill(NaN), adx=new Array(n).fill(NaN);
  let trSum=0,pSum=0,mSum=0;
  for(let i=1;i<=period&&i<n;i++){ trSum+=tr[i]; pSum+=plusDM[i]; mSum+=minusDM[i]; }
  if(period<n){ smTR[period]=trSum; smP[period]=pSum; smM[period]=mSum; }
  for(let i=period+1;i<n;i++){
    smTR[i]=smTR[i-1]-safeDiv(smTR[i-1],period)+tr[i];
    smP[i]=smP[i-1]-safeDiv(smP[i-1],period)+plusDM[i];
    smM[i]=smM[i-1]-safeDiv(smM[i-1],period)+minusDM[i];
  }
  for(let i=period;i<n;i++){
    plusDI[i]=safeDiv(smP[i]*100,smTR[i]);
    minusDI[i]=safeDiv(smM[i]*100,smTR[i]);
    dx[i]=safeDiv(Math.abs(plusDI[i]-minusDI[i])*100,(plusDI[i]+minusDI[i]));
  }
  let firstAdxIndex=period+period, dxSum=0,count=0;
  for(let i=period;i<n;i++){
    if(!isNaN(dx[i])){
      dxSum+=dx[i]; count++;
      if(count===period){ adx[i]=dxSum/period; firstAdxIndex=i; break; }
    }
  }
  for(let i=firstAdxIndex+1;i<n;i++){
    if(isNaN(dx[i])||isNaN(adx[i-1])) continue;
    adx[i]=(adx[i-1]*(period-1)+dx[i])/period;
  }
  return {adx,plusDI,minusDI};
}

function atrWilder(highs, lows, closes, period){
  const n=closes.length;
  const tr=new Array(n).fill(0);
  for(let i=1;i<n;i++){
    tr[i]=Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
  }
  const atr=new Array(n).fill(NaN);
  let sum=0;
  for(let i=1;i<=period && i<n;i++) sum+=tr[i];
  if(period<n) atr[period]=sum/period;
  for(let i=period+1;i<n;i++){
    atr[i]=(atr[i-1]*(period-1)+tr[i])/period;
  }
  return atr;
}
function bbwpSeries(closes,bandPeriod,lookback){
  const n=closes.length;
  const base=sma(closes,bandPeriod), dev=stdevPop(closes,bandPeriod);
  const width=new Array(n).fill(NaN);
  for(let i=0;i<n;i++) if(!isNaN(base[i])&&!isNaN(dev[i])) width[i]=safeDiv(2*dev[i],base[i]);
  const out=new Array(n).fill(NaN);
  for(let i=0;i<n;i++){
    if(isNaN(width[i])) continue;
    const start=Math.max(0,i-lookback+1);
    let count=0,total=0;
    for(let j=start;j<=i;j++){
      if(isNaN(width[j])) continue;
      total++; if(width[j]<=width[i]) count++;
    }
    out[i]=total>0?(count/total)*100:NaN;
  }
  return out;
}

/* =========================================================
   KONCORDE PLUS (fórmula exacta Bitman)
========================================================= */
function koncordePlus(opens,highs,lows,closes,volumes){
  const n=closes.length;
  const tprice=opens.map((o,i)=>(o+highs[i]+lows[i]+closes[i])/4); // ohlc4
  const hlc3=highs.map((h,i)=>(h+lows[i]+closes[i])/3);

  const pvi=new Array(n).fill(1000), nvi=new Array(n).fill(1000);
  for(let i=1;i<n;i++){
    const deltaPct=safeDiv(closes[i]-closes[i-1],closes[i-1]);
    if(volumes[i]>volumes[i-1]){ pvi[i]=pvi[i-1]+deltaPct*pvi[i-1]; nvi[i]=nvi[i-1]; }
    else if(volumes[i]<volumes[i-1]){ nvi[i]=nvi[i-1]+deltaPct*nvi[i-1]; pvi[i]=pvi[i-1]; }
    else { pvi[i]=pvi[i-1]; nvi[i]=nvi[i-1]; }
  }
  const pvim=ema(pvi,15), nvim=ema(nvi,15);
  const hiPvim=highestPeriod(pvim,90), loPvim=lowestPeriod(pvim,90);
  const hiNvim=highestPeriod(nvim,90), loNvim=lowestPeriod(nvim,90);
  const oscp=new Array(n).fill(NaN), azul=new Array(n).fill(NaN);
  for(let i=0;i<n;i++){
    oscp[i]=safeDiv((pvi[i]-pvim[i])*100,(hiPvim[i]-loPvim[i]));
    azul[i]=safeDiv((nvi[i]-nvim[i])*100,(hiNvim[i]-loNvim[i]));
  }

  const basisBB=sma(tprice,25), devBB=stdevPop(tprice,25);
  const oscBB=new Array(n).fill(NaN);
  for(let i=0;i<n;i++) oscBB[i]=safeDiv((tprice[i]-basisBB[i])*100,(4*devBB[i]));

  const xrsi=rsiWilder(tprice,14);
  const xmf=mfiTypical(highs,lows,closes,volumes,14,hlc3);
  const stoc=stochasticSmoothed(tprice,highs,lows,21,3);

  const tendencia=new Array(n).fill(NaN); // marrón / Trend
  const pececillos=new Array(n).fill(NaN); // verde
  for(let i=0;i<n;i++){
    const parts=[xrsi[i],xmf[i],oscBB[i], isNaN(stoc[i])?NaN:stoc[i]/3];
    if(parts.some(p=>p==null||isNaN(p))) continue;
    tendencia[i]=(xrsi[i]+xmf[i]+oscBB[i]+stoc[i]/3)/2;
    pececillos[i]=tendencia[i]+(isNaN(oscp[i])?0:oscp[i]);
  }
  const maTrend=ema(tendencia,15);
  const konVal=new Array(n).fill(NaN);
  for(let i=0;i<n;i++){
    if(isNaN(tendencia[i])||isNaN(pececillos[i])) continue;
    const mx=Math.max(pececillos[i],tendencia[i]);
    konVal[i]= mx<0 ? Math.min(pececillos[i],tendencia[i]) : mx;
  }
  return {tprice,hlc3,oscp,azul,oscBB,xrsi,xmf,stoc,tendencia,pececillos,maTrend,konVal};
}

/* =========================================================
   PIPELINE DE SERIES COMPLETAS
========================================================= */
function computeFullSeries(ohlcv){
  const {opens,highs,lows,closes,volumes,times}=ohlcv;
  const n=closes.length;
  const ao=awesomeOscillator(highs,lows);
  const {adx,plusDI,minusDI}=adxWilder(highs,lows,closes,14);
  const atr=atrWilder(highs,lows,closes,14);
  const bbwp=bbwpSeries(closes,13,252);
  const konc=koncordePlus(opens,highs,lows,closes,volumes);

  const aoState=new Array(n).fill('Sin datos');
  const adxSubiendo=new Array(n).fill(false);
  const koBull=new Array(n).fill(false), koBear=new Array(n).fill(false), koAbove=new Array(n).fill(false);

  for(let i=1;i<n;i++){
    if(!isNaN(ao[i])&&!isNaN(ao[i-1])){
      const subiendo=ao[i]>ao[i-1];
      if(ao[i]>=0&&subiendo) aoState[i]='Alcista';
      else if(ao[i]>=0&&!subiendo) aoState[i]='Retroceso alcista';
      else if(ao[i]<0&&!subiendo) aoState[i]='Bajista';
      else aoState[i]='Retroceso bajista';
    }
    if(!isNaN(adx[i])&&!isNaN(adx[i-1])) adxSubiendo[i]=adx[i]>adx[i-1];
    if(!isNaN(konc.konVal[i])){
      koBull[i]=konc.konVal[i]>0;
      koBear[i]=konc.konVal[i]<0;
      if(!isNaN(konc.maTrend[i])) koAbove[i]=konc.konVal[i]>konc.maTrend[i];
    }
  }

  return {
    n, times, opens, highs, lows, closes, volumes,
    ao, adx, plusDI, minusDI, atr, bbwp,
    oscp:konc.oscp, azul:konc.azul, tendencia:konc.tendencia, pececillos:konc.pececillos,
    maTrend:konc.maTrend, konVal:konc.konVal,
    aoState, adxSubiendo, koBull, koBear, koAbove
  };
}

function alignDailyIndex(dailySeries, targetTimes){
  const dTimes=dailySeries.times;
  const out=new Array(targetTimes.length).fill(-1);
  let j=0;
  for(let i=0;i<targetTimes.length;i++){
    while(j+1<dTimes.length && dTimes[j+1]<=targetTimes[i]) j++;
    if(dTimes[j]<=targetTimes[i]) out[i]=j;
  }
  return out;
}

// Veredicto de la última vela cerrada de 4H: el propio 4H tiene que dar su
// señal completa (AO+ADX+Koncorde), confirmada por el Diario (AO+Koncorde
// a favor de la misma dirección) — idéntico al Análisis K/L del backtest,
// la variante validada tanto en el agregado de 9 años como fuera de muestra.
function verdictoActual(s4h, sD){
  const i = s4h.n - 1;
  const idxD = alignDailyIndex(sD, s4h.times);
  const iD = idxD[i];
  const aoAlcista = s4h.aoState[i]==='Alcista', aoBajista = s4h.aoState[i]==='Bajista';
  const dailyBullish = iD>=0 && sD.aoState[iD]==='Alcista' && sD.koBull[iD];
  const dailyBearish = iD>=0 && sD.aoState[iD]==='Bajista' && sD.koBear[iD];
  let comprarOk = aoAlcista && s4h.adxSubiendo[i] && s4h.koBull[i] && dailyBullish;
  let venderOk  = aoBajista && s4h.adxSubiendo[i] && s4h.koBear[i] && dailyBearish;
  let verdict = comprarOk ? 'COMPRAR' : (venderOk ? 'VENDER' : 'ESPERAR');
  let motivo = '';
  if(verdict==='COMPRAR') motivo = 'AO alcista + ADX subiendo + Koncorde (4H), confirmado por el Diario.';
  else if(verdict==='VENDER') motivo = 'AO bajista + ADX subiendo + Koncorde (4H), confirmado por el Diario.';

  // Cierre forzado de protección (idéntico al backtest y al bot original):
  // manda por encima de cualquier otra condición, tanto si hay una posición
  // que cerrar como si dispara una entrada corta nueva sin más confirmación.
  let forced = false;
  if(!isNaN(s4h.konVal[i]) && !isNaN(s4h.maTrend[i]) && s4h.konVal[i] < s4h.maTrend[i]){
    verdict = 'VENDER';
    motivo = 'Koncorde por debajo de su media (maTrend) — manda por encima del resto de condiciones.';
    forced = true;
  }
  return { verdict, motivo, forced, price: s4h.closes[i], time: s4h.times[i] };
}

// Procesa un "tick" (una comprobación): dado el veredicto actual y el estado
// previo, decide qué mensajes hay que mandar y cómo queda el nuevo estado.
// Separada de main() para poder probarla con datos de control, sin red ni
// sistema de archivos de por medio.
function processTick(s4h, actual, state){
  const messages = [];
  const newState = Object.assign({}, state);

  if(newState.position){
    const last = s4h.n - 1;
    const hitTP = newState.position==='long'
      ? s4h.highs[last] >= newState.tpPrice
      : s4h.lows[last] <= newState.tpPrice;

    if(hitTP){
      const gananciaPct = newState.position==='long'
        ? ((newState.tpPrice/newState.entryPrice - 1) * 100)
        : ((1 - newState.tpPrice/newState.entryPrice) * 100);
      messages.push(
        '🎯 <b>Take Profit alcanzado</b> (' + (newState.position==='long'?'largo':'corto') + ')\n' +
        'Entrada: ' + newState.entryPrice.toFixed(2) + ' → TP: ' + newState.tpPrice.toFixed(2) +
        ' (precio ' + (gananciaPct>=0?'+':'') + gananciaPct.toFixed(2) + '% · posición ' + (gananciaPct>=0?'+':'') + (gananciaPct*LEVERAGE_INFO).toFixed(1) + '% con x' + LEVERAGE_INFO + ')'
      );
      newState.position = null; newState.entryPrice = null; newState.tpPrice = null; newState.entryTime = null;
    } else {
      const stillValid = (newState.position==='long' && actual.verdict==='COMPRAR') || (newState.position==='short' && actual.verdict==='VENDER');
      if(!stillValid){
        const gananciaPct = newState.position==='long'
          ? ((actual.price/newState.entryPrice - 1) * 100)
          : ((1 - actual.price/newState.entryPrice) * 100);
        messages.push(
          '🔻 <b>Cierre por cambio de veredicto</b> (' + (newState.position==='long'?'largo':'corto') + ')\n' +
          'Entrada: ' + newState.entryPrice.toFixed(2) + ' → Cierre: ' + actual.price.toFixed(2) +
          ' (' + (gananciaPct>=0?'+':'') + gananciaPct.toFixed(2) + '% de precio, x' + LEVERAGE_INFO + ' apalancamiento)\n' +
          escapeHtml(actual.forced ? 'Cierre forzado: ' + actual.motivo : actual.motivo)
        );
        newState.position = null; newState.entryPrice = null; newState.tpPrice = null; newState.entryTime = null;
      }
    }
  }

  if(!newState.position){
    if(actual.verdict==='COMPRAR' || actual.verdict==='VENDER'){
      const direction = actual.verdict==='COMPRAR' ? 'long' : 'short';
      const tpPrice = direction==='long' ? actual.price*(1+TP_PCT/100) : actual.price*(1-TP_PCT/100);
      messages.push(
        (direction==='long' ? '🟢' : '🔴') + ' <b>Nueva entrada: ' + (direction==='long'?'LARGO':'CORTO') + '</b>\n' +
        'Precio: ' + actual.price.toFixed(2) + ' · TP: ' + tpPrice.toFixed(2) + ' (precio +' + TP_PCT.toFixed(1) + '% · posición +' + TP_EQUITY_PCT + '% con x' + LEVERAGE_INFO + ')\n' +
        escapeHtml(actual.forced ? 'Entrada forzada solo por Koncorde (sin la confirmación habitual de AO+ADX+4H/Diario): ' + actual.motivo : actual.motivo) + '\n' +
        '<i>Recordatorio de gestión: ' + RISK_PCT_INFO + '% del capital, x' + LEVERAGE_INFO + '. Sin stop loss — cierra por TP o por cambio de veredicto.</i>'
      );
      newState.position = direction; newState.entryPrice = actual.price; newState.tpPrice = tpPrice; newState.entryTime = actual.time;
    }
  }

  return { messages, newState };
}

async function main(){
  const now = new Date();
  console.log('Bitman Confluencia — comprobando ' + SYMBOL + ' a las ' + now.toISOString());

  const ohlcv4h = await fetchRecentCandles('4h', 400);
  const ohlcvD  = await fetchRecentCandles('1d', 400);
  console.log('Velas 4H: ' + ohlcv4h.closes.length + ' · Diario: ' + ohlcvD.closes.length);

  const s4h = computeFullSeries(ohlcv4h);
  const sD  = computeFullSeries(ohlcvD);
  const actual = verdictoActual(s4h, sD);
  console.log('Veredicto actual (4H, vela ' + new Date(actual.time).toISOString() + '): ' + actual.verdict + ' — precio ' + actual.price);

  const state = loadState();
  const { messages, newState } = processTick(s4h, actual, state);

  if(messages.length){
    const header = '📊 <b>Bitman Confluencia · ' + SYMBOL + '</b>\n\n';
    await sendTelegramMessage(header + messages.join('\n\n'));
    console.log(messages.length + ' aviso(s) enviado(s).');
  } else {
    console.log('Sin cambios — no se envía nada. Posición actual: ' + (newState.position || 'ninguna'));
  }

  saveState(newState);
}

main().catch(err=>{
  console.error('Error:', err);
  process.exit(1);
});

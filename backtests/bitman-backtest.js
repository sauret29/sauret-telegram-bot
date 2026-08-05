// ============================================================
// Bitman · Backtest (análisis manual, NO se ejecuta cada 15 min)
// ------------------------------------------------------------
// Dos análisis con datos reales de Binance sobre los últimos
// MESES_HISTORICO meses en temporalidad 1H, apalancamiento 5x:
//
//  A) Compara 4 formas de exigir (o no) el ADX en la entrada,
//     para ver cuál reduce el retraso sin disparar las señales
//     falsas, usando SL fijo y TP fijo.
//  B) Con la lógica ACTUAL (ADX estricto, la que ya usa el bot
//     en vivo), prueba una rejilla de combinaciones de Stop
//     Loss / Take Profit para ver cuál da mejor relación
//     riesgo/beneficio.
//
// Solo lee datos públicos de Binance — no opera, no necesita
// credenciales de Telegram, no toca state.json ni el bot real.
// Los resultados se imprimen en el log de esta ejecución.
// ============================================================

const MESES_HISTORICO = parseInt(process.env.MESES_HISTORICO || '6', 10);
const MESES_RESERVADOS = parseInt(process.env.MESES_RESERVADOS || '12', 10);
const LEVERAGE = 5;
const SL_DEFAULT_PCT = 5;   // %
const TP_DEFAULT_PCT = 15;  // %

const SYMBOL = process.env.SYMBOL || 'BTCUSDT';
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

// Descarga velas 1H hasta cubrir MESES_HISTORICO meses + margen extra,
// paginando hacia atrás. El margen (~3000 velas) es necesario para que
// el ML RSI tenga su ventana completa de clustering ya disponible desde
// el PRIMER día del periodo analizado (no solo al final) — si no,
// las primeras semanas del backtest usarían un ML RSI "mal calentado",
// con menos historial del que tendría en una situación real.
async function fetchCandlesForMonths(interval, months, warmupMargin){
  if(warmupMargin==null) warmupMargin = 3050; // por defecto, margen para el ML RSI (solo se usa en 1H)
  const msPerCandle = { '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000, '1d': 86400000, '1w': 604800000 }[interval] || 3600000;
  const monthsCandles = Math.ceil((months * 30 * 86400000) / msPerCandle);
  const targetCandles = monthsCandles + warmupMargin;
  let all = await fetchKlinesRaw(interval, SIGNAL_LIMIT);
  let pages = 1;
  while(all.length < targetCandles && pages < 150){
    const oldestOpenTime = all[0][0];
    let nextPage;
    try{ nextPage = await fetchKlinesRaw(interval, SIGNAL_LIMIT, oldestOpenTime-1); }
    catch(e){ break; }
    if(!nextPage || nextPage.length===0) break;
    all = nextPage.concat(all);
    pages++;
    if(nextPage.length < SIGNAL_LIMIT) break;
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

// ============================================================
// MOTOR DE INDICADORES (copia exacta del bot de alertas)
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
/* =========================================================
   UTILIDADES DE MEDIAS MÓVILES (para el Trend Speed Analyzer)
========================================================= */
// RMA de Wilder como función independiente (réplica de ta.rma de Pine):
// semilla = media simple de los primeros 'period' valores, después
// suavizado exponencial con peso 1/period.
function rmaSeries(values, period){
  const n = values.length;
  const out = new Array(n).fill(NaN);
  let sum = 0;
  for(let i=0;i<n;i++){
    if(i<period-1){ sum += values[i]; continue; }
    if(i===period-1){ sum += values[i]; out[i] = sum/period; continue; }
    if(isNaN(out[i-1])) continue;
    out[i] = (out[i-1]*(period-1) + values[i]) / period;
  }
  return out;
}

// Media móvil ponderada (réplica de ta.wma): el peso crece linealmente
// hacia la vela más reciente. Si alguna vela de la ventana es NaN, el
// resultado de esa vela también es NaN (mismo criterio que Pine).
function wmaSeries(values, period){
  const n = values.length;
  const out = new Array(n).fill(NaN);
  const denom = period*(period+1)/2;
  for(let i=period-1;i<n;i++){
    let sum=0, huboNaN=false;
    for(let k=0;k<period;k++){
      const v = values[i-k];
      if(isNaN(v)){ huboNaN=true; break; }
      sum += v*(period-k);
    }
    if(!huboNaN) out[i] = sum/denom;
  }
  return out;
}

// Hull Moving Average (réplica de ta.hma): WMA(2*WMA(n/2) - WMA(n), √n).
function hmaSeries(values, period){
  const halfPeriod = Math.round(period/2);
  const sqrtPeriod = Math.round(Math.sqrt(period));
  const wmaHalf = wmaSeries(values, halfPeriod);
  const wmaFull = wmaSeries(values, period);
  const n = values.length;
  const diff = new Array(n).fill(NaN);
  for(let i=0;i<n;i++){
    if(!isNaN(wmaHalf[i]) && !isNaN(wmaFull[i])) diff[i] = 2*wmaHalf[i] - wmaFull[i];
  }
  return wmaSeries(diff, sqrtPeriod);
}

// Máximo/mínimo móvil (réplica de ta.highest/ta.lowest): ventana de
// 'period' velas terminando EN la vela actual (inclusive).
function rollingMax(values, period){
  const n = values.length;
  const out = new Array(n).fill(NaN);
  for(let i=0;i<n;i++){
    const desde = Math.max(0, i-period+1);
    let max=-Infinity, huboValor=false;
    for(let k=desde;k<=i;k++){ if(!isNaN(values[k])){ huboValor=true; if(values[k]>max) max=values[k]; } }
    out[i] = huboValor ? max : NaN;
  }
  return out;
}
function rollingMin(values, period){
  const n = values.length;
  const out = new Array(n).fill(NaN);
  for(let i=0;i<n;i++){
    const desde = Math.max(0, i-period+1);
    let min=Infinity, huboValor=false;
    for(let k=desde;k<=i;k++){ if(!isNaN(values[k])){ huboValor=true; if(values[k]<min) min=values[k]; } }
    out[i] = huboValor ? min : NaN;
  }
  return out;
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
   LAGUERRE RSI (Ehlers / Kıvanç Özbilgiç) — réplica exacta del Pine Script
========================================================= */
// Devuelve un array de valores 0-1 (multiplicar por 100 para la escala del
// indicador original). alpha=0.2 por defecto, igual que el Pine original.
function computeLaguerreRSI(closes, alpha){
  if(alpha==null) alpha = 0.2;
  const gamma = 1 - alpha;
  const n = closes.length;
  const larsi = new Array(n).fill(NaN);
  let L0prev=0, L1prev=0, L2prev=0, L3prev=0;
  for(let i=0;i<n;i++){
    const src = closes[i];
    const L0 = (1-gamma)*src + gamma*L0prev;
    const L1 = -gamma*L0 + L0prev + gamma*L1prev;
    const L2 = -gamma*L1 + L1prev + gamma*L2prev;
    const L3 = -gamma*L2 + L2prev + gamma*L3prev;
    const cu = (L0>L1?L0-L1:0) + (L1>L2?L1-L2:0) + (L2>L3?L2-L3:0);
    const cd = (L0<L1?L1-L0:0) + (L1<L2?L2-L1:0) + (L2<L3?L3-L2:0);
    const denom = cu+cd;
    larsi[i] = denom===0 ? 0 : cu/denom;
    L0prev=L0; L1prev=L1; L2prev=L2; L3prev=L3;
  }
  return larsi;
}

// Estado por vela, replicando las dos alertcondition del Pine original:
// "cruza por encima de 20" = señal de compra; "cruza por debajo de 80" = señal
// de venta. El resto de velas quedan "neutral" (sin cruce en ese momento).
function laguerreRSIState(larsi){
  const n = larsi.length;
  const estado = new Array(n).fill('neutral');
  for(let i=1;i<n;i++){
    if(isNaN(larsi[i]) || isNaN(larsi[i-1])) continue;
    const actual = larsi[i]*100, previo = larsi[i-1]*100;
    if(previo<=20 && actual>20) estado[i] = 'compra';
    else if(previo>=80 && actual<80) estado[i] = 'venta';
  }
  return estado;
}

/* =========================================================
   TREND SPEED ANALYZER (Zeiierman) — réplica fiel del Pine Script v6
   Solo se implementa el valor final "trendspeed" (histograma verde/rojo)
   que es lo único que necesitamos para la señal; la tabla de estadísticas
   de olas (bullish/bearish wave arrays) no se replica, no aporta señal.
========================================================= */
function computeTrendSpeedAnalyzer(opens, highs, lows, closes, maxLength, accelMultiplier){
  if(maxLength==null) maxLength = 50;
  if(accelMultiplier==null) accelMultiplier = 5.0;
  const n = closes.length;

  // ~~ Dynamic Average (dyn_length) ~~
  const countsDiff = closes; // counts_diff = close, literal del Pine
  const absCountsDiff = countsDiff.map(v=>Math.abs(v));
  const maxAbsCountsDiff200 = rollingMax(absCountsDiff, 200);
  const dynLength = new Array(n).fill(NaN);
  for(let i=0;i<n;i++){
    if(isNaN(maxAbsCountsDiff200[i]) || maxAbsCountsDiff200[i]===0) continue;
    const countsDiffNorm = (countsDiff[i] + maxAbsCountsDiff200[i]) / (2*maxAbsCountsDiff200[i]);
    dynLength[i] = 5 + countsDiffNorm*(maxLength-5);
  }

  // ~~ Accelerator factor ~~
  const deltaCountsDiff = new Array(n).fill(NaN);
  for(let i=1;i<n;i++) deltaCountsDiff[i] = Math.abs(countsDiff[i]-countsDiff[i-1]);
  const maxDeltaCountsDiff200 = rollingMax(deltaCountsDiff, 200);
  const accelFactor = new Array(n).fill(NaN);
  for(let i=0;i<n;i++){
    let maxDelta = maxDeltaCountsDiff200[i];
    if(isNaN(maxDelta) || maxDelta===0) maxDelta=1;
    accelFactor[i] = isNaN(deltaCountsDiff[i]) ? NaN : deltaCountsDiff[i]/maxDelta;
  }

  // ~~ Alpha ajustado y EMA dinámica (dyn_ema) ~~
  const alpha = new Array(n).fill(NaN);
  for(let i=0;i<n;i++){
    if(isNaN(dynLength[i]) || isNaN(accelFactor[i])) continue;
    const alphaBase = 2/(dynLength[i]+1);
    alpha[i] = Math.min(1, alphaBase*(1+accelFactor[i]*accelMultiplier));
  }
  const dynEma = new Array(n).fill(NaN);
  for(let i=0;i<n;i++){
    if(i===0 || isNaN(dynEma[i-1])) dynEma[i] = closes[i]; // na(dyn_ema[1]) → close
    else if(!isNaN(alpha[i])) dynEma[i] = alpha[i]*closes[i] + (1-alpha[i])*dynEma[i-1];
    else dynEma[i] = dynEma[i-1];
  }
  const trend = dynEma;

  // ~~ Trend Speed: c=RMA(close,10), o=RMA(open,10) ~~
  const c = rmaSeries(closes, 10);
  const o = rmaSeries(opens, 10);

  const speed = new Array(n).fill(0);
  for(let i=1;i<n;i++){
    if(isNaN(c[i]) || isNaN(o[i])){ speed[i] = speed[i-1]; continue; }
    // OJO: réplica literal del Pine — compara bullsrc[1] contra 'trend' SIN
    // desfase (el valor de HOY de dyn_ema), no contra trend[1]. Es así en
    // el original, no un desliz de la traducción.
    const bullCross = closes[i]>trend[i] && closes[i-1]<=trend[i];
    const bearCross = closes[i]<trend[i] && closes[i-1]>=trend[i];
    let s = (bullCross || bearCross) ? (c[i]-o[i]) : speed[i-1];
    s = s + c[i] - o[i];
    speed[i] = s;
  }

  const trendspeed = hmaSeries(speed, 5);
  return { dynEma, speed, trendspeed };
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
  const larsi=computeLaguerreRSI(closes,0.2);
  const larsiState=laguerreRSIState(larsi);
  const trendSpeed=computeTrendSpeedAnalyzer(opens,highs,lows,closes,50,5.0);

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
    aoState, adxSubiendo, koBull, koBear, koAbove,
    larsi, larsiState,
    trendspeed: trendSpeed.trendspeed
  };
}

// Alinea una serie de temporalidad mayor (4H o Diario) contra los timestamps
// de una serie menor (1H): para cada vela de 1H, devuelve el ÍNDICE de la
// última vela de la temporalidad mayor que ya había cerrado en ese momento
// (misma función que usa el bot en vivo para su puerta diaria del modo Pro).
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

// Construye las "puertas" de confluencia: para cada vela de 1H, si la ÚLTIMA
// vela cerrada de 4H o de Diario (la que sea) confirma tendencia alcista
// (AO Alcista Y Koncorde>media), la puerta alcista queda abierta esa vela;
// igual para bajista. Solo hace falta que UNA de las dos confirme (OR).
function buildConfluenceGates(series1H, series4H, seriesD){
  const idx4H = alignDailyIndex(series4H, series1H.times);
  const idxD = alignDailyIndex(seriesD, series1H.times);
  const n = series1H.n;
  const bull4 = new Array(n).fill(false), bear4 = new Array(n).fill(false);
  const bullD = new Array(n).fill(false), bearD = new Array(n).fill(false);
  // Señal COMPLETA del 4H (con ADX incluido, no solo AO+Koncorde) — se usa
  // como generador de entradas propio en la variante "cascada" (Diario→4H→1H).
  const bull4Full = new Array(n).fill(false), bear4Full = new Array(n).fill(false);
  for(let i=0;i<n;i++){
    const i4 = idx4H[i], iD = idxD[i];
    bull4[i] = i4>=0 && series4H.aoState[i4]==='Alcista' && series4H.koBull[i4];
    bear4[i] = i4>=0 && series4H.aoState[i4]==='Bajista' && series4H.koBear[i4];
    bullD[i] = iD>=0 && seriesD.aoState[iD]==='Alcista' && seriesD.koBull[iD];
    bearD[i] = iD>=0 && seriesD.aoState[iD]==='Bajista' && seriesD.koBear[iD];
    bull4Full[i] = i4>=0 && series4H.aoState[i4]==='Alcista' && series4H.adxSubiendo[i4] && series4H.koBull[i4];
    bear4Full[i] = i4>=0 && series4H.aoState[i4]==='Bajista' && series4H.adxSubiendo[i4] && series4H.koBear[i4];
  }
  // 'bullish'/'bearish' (con OR) se mantienen para no romper la variante ya usada.
  const bullish = bull4.map((v,i)=>v||bullD[i]);
  const bearish = bear4.map((v,i)=>v||bearD[i]);
  return {bullish, bearish, bull4, bear4, bullD, bearD, bull4Full, bear4Full};
}


// Calcula el ML RSI para CADA vela de la serie (no solo la última),
// necesario para poder simular la variante "ML RSI en vez de ADX"
// a lo largo de todo el histórico. Es más costoso que en el bot en
// vivo (que solo calcula la vela actual), pero al ser un análisis
// manual de una sola vez, el tiempo extra no supone un problema.
function computeMLRSISeries(closes){
  const rsiRaw = rsiWilder(closes, 14);
  const rsiSmoothed = ema(rsiRaw, 4);
  const n = closes.length;
  const signal = new Array(n).fill('Sin datos');
  const validIdx = [];
  for(let i=0;i<n;i++){
    if(!isNaN(rsiSmoothed[i])){
      validIdx.push(i);
      const windowIdx = validIdx.slice(-3000);
      const values = windowIdx.map(j=>rsiSmoothed[j]);
      if(values.length >= 30){ // no merece la pena calcular clusters fiables con muy pocos datos
        const centroids = kmeans1D(values, 1000);
        const longS = centroids[2], shortS = centroids[0];
        if(rsiSmoothed[i] > longS) signal[i]='Alcista';
        else if(rsiSmoothed[i] < shortS) signal[i]='Bajista';
        else signal[i]='Neutral';
      }
    }
  }
  return signal;
}

// Verdicto por vela según la variante elegida. Todas comparten la
// misma regla de cierre forzado por Koncorde (igual que el bot en
// vivo) — lo único que cambia entre variantes es qué exige la
// ENTRADA respecto al ADX (o su sustituto).
function verdictAtVariant(s, i, variant, mlSignal, gates){
  const aoAlcista = s.aoState[i]==='Alcista';
  const aoBajista = s.aoState[i]==='Bajista';
  const koBull = s.koBull[i], koBear = s.koBear[i];
  const adxSubiendo = s.adxSubiendo[i];
  const adxNoBajando = !isNaN(s.adx[i]) && !isNaN(s.adx[i-1]) && s.adx[i] >= s.adx[i-1];
  const mlAlcista = mlSignal && mlSignal[i]==='Alcista';
  const mlBajista = mlSignal && mlSignal[i]==='Bajista';
  const gateBullish = gates && gates.bullish[i];
  const gateBearish = gates && gates.bearish[i];

  let comprarOk=false, venderOk=false;
  if(variant==='adx_estricto'){
    comprarOk = aoAlcista && adxSubiendo && koBull;
    venderOk  = aoBajista && adxSubiendo && koBear;
  } else if(variant==='sin_adx'){
    comprarOk = aoAlcista && koBull;
    venderOk  = aoBajista && koBear;
  } else if(variant==='adx_no_bajando'){
    comprarOk = aoAlcista && adxNoBajando && koBull;
    venderOk  = aoBajista && adxNoBajando && koBear;
  } else if(variant==='ml_rsi'){
    comprarOk = aoAlcista && mlAlcista && koBull;
    venderOk  = aoBajista && mlBajista && koBear;
  } else if(variant==='confluencia_htf'){
    // Igual que 'adx_estricto' en 1H, pero exige ADEMÁS que 4H o Diario
    // (con que uno de los dos, vale) confirmen la misma tendencia.
    comprarOk = aoAlcista && adxSubiendo && koBull && gateBullish;
    venderOk  = aoBajista && adxSubiendo && koBear && gateBearish;
  } else if(variant==='confluencia_htf_and'){
    // Versión más estricta: exige que 4H Y Diario confirmen los DOS a la vez.
    const gateBullishAnd = gates && gates.bull4[i] && gates.bullD[i];
    const gateBearishAnd = gates && gates.bear4[i] && gates.bearD[i];
    comprarOk = aoAlcista && adxSubiendo && koBull && gateBullishAnd;
    venderOk  = aoBajista && adxSubiendo && koBear && gateBearishAnd;
  } else if(variant==='cascada_diario_4h_1h'){
    // Diario marca la dirección permitida (tendencia principal, AO+Koncorde).
    // 4H tiene que dar su PROPIA señal completa (AO+ADX+Koncorde) — es el
    // que genera la entrada. 1H tiene que dar TAMBIÉN su propia señal
    // completa — al esperar a que el 1H se alinee, la entrada llega más
    // tarde que el simple disparo del 4H, lo cual de forma natural suele
    // capturar un precio algo mejor (más ajustado) que entrar de inmediato.
    const dailyBullish = gates && gates.bullD[i];
    const dailyBearish = gates && gates.bearD[i];
    const cuatroHBullish = gates && gates.bull4Full[i];
    const cuatroHBearish = gates && gates.bear4Full[i];
    comprarOk = dailyBullish && cuatroHBullish && aoAlcista && adxSubiendo && koBull;
    venderOk  = dailyBearish && cuatroHBearish && aoBajista && adxSubiendo && koBear;
  } else if(variant==='pullback_4h_1h'){
    // Diario marca la tendencia principal. El 4H tiene que estar EN CONTRA
    // de esa tendencia (un retroceso/pullback dentro del movimiento mayor).
    // El 1H tiene que dar su señal completa a favor del Diario otra vez
    // (el "impulso contrario" al retroceso del 4H) — ese giro del 1H suele
    // marcar el momento en que el retroceso del 4H se agota y el precio
    // retoma la tendencia principal.
    const dailyBullish = gates && gates.bullD[i];
    const dailyBearish = gates && gates.bearD[i];
    const cuatroHEnRetrocesoBajista = gates && gates.bear4[i]; // 4H bajista dentro de tendencia diaria alcista
    const cuatroHEnRetrocesoAlcista = gates && gates.bull4[i]; // 4H alcista dentro de tendencia diaria bajista
    comprarOk = dailyBullish && cuatroHEnRetrocesoBajista && aoAlcista && adxSubiendo && koBull;
    venderOk  = dailyBearish && cuatroHEnRetrocesoAlcista && aoBajista && adxSubiendo && koBear;
  }

  let verdict = comprarOk ? 'COMPRAR' : (venderOk ? 'VENDER' : 'ESPERAR');
  // Cierre forzado por Koncorde (idéntico al bot en vivo): manda por
  // encima de cualquier condición de la variante.
  if(!isNaN(s.konVal[i]) && !isNaN(s.maTrend[i]) && s.konVal[i] < s.maTrend[i]){
    verdict = 'VENDER';
  }
  return verdict;
}

// Simula una cuenta que sigue los veredictos: entra largo en COMPRAR,
// corto en VENDER, y se queda plana en ESPERAR. Aplica SL y TP fijos
// (% sobre el precio de entrada) comprobados intra-vela con high/low,
// y apalancamiento sobre el resultado. Si en la misma vela se tocan
// SL y TP a la vez, se prioriza el SL (asunción conservadora).
function simulateTrades(s, verdicts, slPct, tpPct, leverage){
  const n = s.n;
  let equity = 1.0, peak = 1.0, maxDrawdown = 0;
  let position = null; // 'long' | 'short' | null
  let entryPrice = null, slPrice = null, tpPrice = null;
  const trades = [];

  const closeTrade = (exitPrice, reason) => {
    const rawReturn = position==='long' ? (exitPrice/entryPrice - 1) : (1 - exitPrice/entryPrice);
    const leveraged = rawReturn * leverage;
    equity *= Math.max(0, 1 + leveraged); // nunca negativo (liquidación total como suelo)
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    trades.push({ direction:position, entryPrice, exitPrice, returnPct:leveraged*100, reason });
    position = null; entryPrice = null; slPrice = null; tpPrice = null;
  };

  for(let i=1;i<n;i++){
    if(position){
      const hitSL = position==='long' ? s.lows[i] <= slPrice : s.highs[i] >= slPrice;
      const hitTP = position==='long' ? s.highs[i] >= tpPrice : s.lows[i] <= tpPrice;
      if(hitSL){ closeTrade(slPrice, 'SL'); }
      else if(hitTP){ closeTrade(tpPrice, 'TP'); }
      else {
        const v = verdicts[i];
        const stillValid = (position==='long' && v==='COMPRAR') || (position==='short' && v==='VENDER');
        if(!stillValid) closeTrade(s.closes[i], 'Cambio de veredicto');
      }
    }
    if(!position){
      const v = verdicts[i];
      if(v==='COMPRAR'){
        position='long'; entryPrice=s.closes[i];
        slPrice = entryPrice*(1-slPct/100); tpPrice = entryPrice*(1+tpPct/100);
      } else if(v==='VENDER'){
        position='short'; entryPrice=s.closes[i];
        slPrice = entryPrice*(1+slPct/100); tpPrice = entryPrice*(1-tpPct/100);
      }
    }
  }
  // Si queda una operación abierta al final, se cierra al último precio
  // (solo para que las métricas cuadren; no afecta a las demás).
  if(position) closeTrade(s.closes[n-1], 'Fin del periodo');

  const wins = trades.filter(t=>t.returnPct>0).length;
  const grossGain = trades.filter(t=>t.returnPct>0).reduce((a,t)=>a+t.returnPct,0);
  const grossLoss = Math.abs(trades.filter(t=>t.returnPct<=0).reduce((a,t)=>a+t.returnPct,0));
  return {
    trades: trades.length,
    winRatePct: trades.length ? (wins/trades.length*100) : 0,
    totalReturnPct: (equity-1)*100,
    maxDrawdownPct: maxDrawdown*100,
    avgReturnPerTradePct: trades.length ? (trades.reduce((a,t)=>a+t.returnPct,0)/trades.length) : 0,
    profitFactor: grossLoss>0 ? (grossGain/grossLoss) : (grossGain>0 ? Infinity : 0)
  };
}

// Igual que simulateTrades, pero en vez de usar SIEMPRE el 100% de la cuenta
// como margen, solo arriesga un % FIJO del capital total en cada operación
// (position sizing). El apalancamiento (leverage) se mantiene igual —
// se aplica dentro de la porción de capital arriesgada, no se toca — pero
// como esa porción es mucho más pequeña que el 100%, una racha de pérdidas
// consecutivas erosiona la cuenta mucho más despacio.
//   marginFraction = riskPct / (slPct * leverage)   (nunca más del 100%)
function simulateTradesRiskSized(s, verdicts, slPct, tpPct, leverage, riskPct){
  const n = s.n;
  let equity = 1.0, peak = 1.0, maxDrawdown = 0;
  let position = null;
  let entryPrice = null, slPrice = null, tpPrice = null;
  const trades = [];

  // Fracción del capital total que se arriesga en cada operación, calculada
  // para que, si salta el SL, la pérdida sea exactamente 'riskPct' de la cuenta.
  const marginFraction = Math.min(1, (riskPct/100) / ((slPct/100) * leverage));

  const closeTrade = (exitPrice, reason) => {
    const rawReturn = position==='long' ? (exitPrice/entryPrice - 1) : (1 - exitPrice/entryPrice);
    const leveraged = rawReturn * leverage;
    // Solo la porción 'marginFraction' de la cuenta participa en este resultado;
    // el resto del capital se queda intacto, sin exponerse a esta operación.
    const equityChange = marginFraction * leveraged;
    equity *= Math.max(0, 1 + equityChange);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    trades.push({ direction:position, entryPrice, exitPrice, returnPct:leveraged*100, equityChangePct:equityChange*100, reason });
    position = null; entryPrice = null; slPrice = null; tpPrice = null;
  };

  for(let i=1;i<n;i++){
    if(position){
      const hitSL = position==='long' ? s.lows[i] <= slPrice : s.highs[i] >= slPrice;
      const hitTP = position==='long' ? s.highs[i] >= tpPrice : s.lows[i] <= tpPrice;
      if(hitSL){ closeTrade(slPrice, 'SL'); }
      else if(hitTP){ closeTrade(tpPrice, 'TP'); }
      else {
        const v = verdicts[i];
        const stillValid = (position==='long' && v==='COMPRAR') || (position==='short' && v==='VENDER');
        if(!stillValid) closeTrade(s.closes[i], 'Cambio de veredicto');
      }
    }
    if(!position){
      const v = verdicts[i];
      if(v==='COMPRAR'){
        position='long'; entryPrice=s.closes[i];
        slPrice = entryPrice*(1-slPct/100); tpPrice = entryPrice*(1+tpPct/100);
      } else if(v==='VENDER'){
        position='short'; entryPrice=s.closes[i];
        slPrice = entryPrice*(1+slPct/100); tpPrice = entryPrice*(1-tpPct/100);
      }
    }
  }
  if(position) closeTrade(s.closes[n-1], 'Fin del periodo');

  const wins = trades.filter(t=>t.equityChangePct>0).length;
  const grossGain = trades.filter(t=>t.equityChangePct>0).reduce((a,t)=>a+t.equityChangePct,0);
  const grossLoss = Math.abs(trades.filter(t=>t.equityChangePct<=0).reduce((a,t)=>a+t.equityChangePct,0));
  return {
    trades: trades.length,
    winRatePct: trades.length ? (wins/trades.length*100) : 0,
    totalReturnPct: (equity-1)*100,
    maxDrawdownPct: maxDrawdown*100,
    avgReturnPerTradePct: trades.length ? (trades.reduce((a,t)=>a+t.equityChangePct,0)/trades.length) : 0,
    profitFactor: grossLoss>0 ? (grossGain/grossLoss) : (grossGain>0 ? Infinity : 0),
    marginFractionPct: marginFraction*100
  };
}

// Igual que simulateTradesRiskSized, pero SIN ningún stop loss: la operación
// solo se cierra por Take Profit o por cambio de veredicto (nunca se corta
// antes por precio). Al no existir una distancia de SL, no se puede calcular
// el tamaño de posición a partir de un "% de riesgo" — aquí se especifica
// directamente qué fracción fija del capital se usa en cada operación
// (marginFraction), para poder comparar en igualdad de condiciones contra
// las mismas fracciones que salieron en el Análisis E.
function simulateTradesNoSL(s, verdicts, tpPct, leverage, marginFraction){
  const n = s.n;
  let equity = 1.0, peak = 1.0, maxDrawdown = 0;
  let position = null, entryPrice = null, tpPrice = null, entryIdx = null;
  const trades = [];
  let peorOperacionPct = 0; // la operación individual más negativa, para vigilar el riesgo de cola

  const closeTrade = (exitPrice) => {
    const rawReturn = position==='long' ? (exitPrice/entryPrice - 1) : (1 - exitPrice/entryPrice);
    const leveraged = rawReturn * leverage;
    const equityChange = marginFraction * leveraged;
    equity *= Math.max(0, 1 + equityChange);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    if(equityChange*100 < peorOperacionPct) peorOperacionPct = equityChange*100;
    trades.push({ direction:position, equityChangePct:equityChange*100, entryIdx });
    position = null; entryPrice = null; tpPrice = null; entryIdx = null;
  };

  for(let i=1;i<n;i++){
    if(position){
      const hitTP = position==='long' ? s.highs[i] >= tpPrice : s.lows[i] <= tpPrice;
      if(hitTP){ closeTrade(tpPrice); }
      else {
        const v = verdicts[i];
        const stillValid = (position==='long' && v==='COMPRAR') || (position==='short' && v==='VENDER');
        if(!stillValid) closeTrade(s.closes[i]);
      }
    }
    if(!position){
      const v = verdicts[i];
      if(v==='COMPRAR'){ position='long'; entryPrice=s.closes[i]; tpPrice = entryPrice*(1+tpPct/100); entryIdx=i; }
      else if(v==='VENDER'){ position='short'; entryPrice=s.closes[i]; tpPrice = entryPrice*(1-tpPct/100); entryIdx=i; }
    }
  }
  if(position) closeTrade(s.closes[n-1]);

  const wins = trades.filter(t=>t.equityChangePct>0).length;
  const grossGain = trades.filter(t=>t.equityChangePct>0).reduce((a,t)=>a+t.equityChangePct,0);
  const grossLoss = Math.abs(trades.filter(t=>t.equityChangePct<=0).reduce((a,t)=>a+t.equityChangePct,0));
  return {
    trades: trades.length,
    winRatePct: trades.length ? (wins/trades.length*100) : 0,
    totalReturnPct: (equity-1)*100,
    maxDrawdownPct: maxDrawdown*100,
    profitFactor: grossLoss>0 ? (grossGain/grossLoss) : (grossGain>0 ? Infinity : 0),
    peorOperacionPct,
    tradeLog: trades
  };
}

// Igual que simulateTradesNoSL, pero descontando comisiones y funding reales
// de Bitget (USDT-M perpetual, nivel estándar, margen aislado — el modo de
// margen no cambia estos costes):
//   - Entrada y cierre por cambio de veredicto: se asumen a mercado → taker (0.06%)
//   - Cierre por Take Profit: se asume con orden límite ya puesta → maker (0.02%)
//   - Funding: cada 8h que la posición sigue abierta, se descuenta un coste
//     estimado (0.01% del NOCIONAL — precio×apalancamiento — por periodo).
//     El funding real fluctúa entre -0.05% y +0.05% y puede ir a tu favor;
//     0.01% es una estimación conservadora de la magnitud típica, no un
//     valor exacto — el funding real depende del sentimiento del mercado.
const BITGET_TAKER_FEE_PCT = 0.06;
const BITGET_MAKER_FEE_PCT = 0.02;
const BITGET_FUNDING_PCT_PER_8H = 0.01;
const HORAS_POR_VELA_1H = 1;

function simulateTradesNoSLConFees(s, verdicts, tpPct, leverage, marginFraction, horasPorVela, slPct){
  if(horasPorVela==null) horasPorVela = 1; // por defecto, velas de 1H (comportamiento anterior)
  // slPct es OPCIONAL — si no se pasa (undefined/null), no hay stop loss,
  // exactamente el comportamiento de siempre. Si se pasa, actúa como
  // cortafuegos: un stop ANCHO pensado solo para cortar movimientos
  // extremos (tipo 2021), no para gestionar el riesgo normal día a día.
  const n = s.n;
  let equity = 1.0, peak = 1.0, maxDrawdown = 0;
  let position = null, entryPrice = null, tpPrice = null, slPrice = null, entryIdx = null;
  const trades = [];
  let peorOperacionPct = 0;
  let totalComisionesPct = 0, totalFundingPct = 0;
  let cierresPorSL = 0;

  // El nocional (tamaño real de la posición en el exchange) es la porción
  // de capital arriesgada multiplicada por el apalancamiento — las
  // comisiones y el funding se cobran sobre ESE valor, no sobre el capital.
  const nocionalFraction = marginFraction * leverage;

  const closeTrade = (exitPrice, feePct, entryIdxLocal, exitIdxLocal) => {
    const rawReturn = position==='long' ? (exitPrice/entryPrice - 1) : (1 - exitPrice/entryPrice);
    const leveraged = rawReturn * leverage;

    // Comisión de entrada (taker, ya se pagó al abrir) + comisión de salida
    const comisionSalidaPct = nocionalFraction * (feePct/100) * 100; // en % de la cuenta
    const comisionTotalPct = comisionSalidaPct; // la de entrada ya se descontó al abrir (ver más abajo)

    // Funding: nº de periodos de 8h completos que estuvo abierta la posición
    const horasAbierta = (exitIdxLocal - entryIdxLocal) * horasPorVela;
    const periodosFunding = Math.floor(horasAbierta / 8);
    const fundingPct = nocionalFraction * (BITGET_FUNDING_PCT_PER_8H/100) * periodosFunding * 100;

    const equityChange = marginFraction * leveraged - comisionTotalPct/100 - fundingPct/100;
    equity *= Math.max(0, 1 + equityChange);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    if(equityChange*100 < peorOperacionPct) peorOperacionPct = equityChange*100;
    totalComisionesPct += comisionTotalPct;
    totalFundingPct += fundingPct;
    trades.push({ direction:position, equityChangePct:equityChange*100, entryIdx });
    position = null; entryPrice = null; tpPrice = null; slPrice = null; entryIdx = null;
  };

  for(let i=1;i<n;i++){
    if(position){
      const hitSL = slPct!=null && (position==='long' ? s.lows[i] <= slPrice : s.highs[i] >= slPrice);
      const hitTP = position==='long' ? s.highs[i] >= tpPrice : s.lows[i] <= tpPrice;
      if(hitSL){ cierresPorSL++; closeTrade(slPrice, BITGET_TAKER_FEE_PCT, entryIdx, i); }
      else if(hitTP){ closeTrade(tpPrice, BITGET_MAKER_FEE_PCT, entryIdx, i); }
      else {
        const v = verdicts[i];
        const stillValid = (position==='long' && v==='COMPRAR') || (position==='short' && v==='VENDER');
        if(!stillValid) closeTrade(s.closes[i], BITGET_TAKER_FEE_PCT, entryIdx, i);
      }
    }
    if(!position){
      const v = verdicts[i];
      if(v==='COMPRAR' || v==='VENDER'){
        position = v==='COMPRAR' ? 'long' : 'short';
        entryPrice = s.closes[i];
        tpPrice = position==='long' ? entryPrice*(1+tpPct/100) : entryPrice*(1-tpPct/100);
        slPrice = slPct!=null ? (position==='long' ? entryPrice*(1-slPct/100) : entryPrice*(1+slPct/100)) : null;
        entryIdx = i;
        // Comisión de entrada (taker), se descuenta ya mismo de la cuenta.
        const comisionEntradaPct = nocionalFraction * (BITGET_TAKER_FEE_PCT/100) * 100;
        equity *= Math.max(0, 1 - comisionEntradaPct/100);
        totalComisionesPct += comisionEntradaPct;
      }
    }
  }
  if(position) closeTrade(s.closes[n-1], BITGET_TAKER_FEE_PCT, entryIdx, n-1);

  const wins = trades.filter(t=>t.equityChangePct>0).length;
  const grossGain = trades.filter(t=>t.equityChangePct>0).reduce((a,t)=>a+t.equityChangePct,0);
  const grossLoss = Math.abs(trades.filter(t=>t.equityChangePct<=0).reduce((a,t)=>a+t.equityChangePct,0));
  return {
    trades: trades.length,
    cierresPorSL,
    winRatePct: trades.length ? (wins/trades.length*100) : 0,
    totalReturnPct: (equity-1)*100,
    maxDrawdownPct: maxDrawdown*100,
    profitFactor: grossLoss>0 ? (grossGain/grossLoss) : (grossGain>0 ? Infinity : 0),
    peorOperacionPct,
    totalComisionesPct,
    totalFundingPct,
    tradeLog: trades
  };
}

// Simulador de la Confluencia en 4H con una SALIDA DISTINTA: en vez de
// cerrar en cuanto cualquiera de las condiciones de entrada deja de
// cumplirse, aguanta mientras solo falle una — y cierra solo cuando el AO
// muestra "Retroceso" del movimiento principal Y el ADX cambia de dirección
// (deja de subir) A LA VEZ, en la misma vela. El TP y el cierre forzado por
// Koncorde se mantienen exactamente igual que en la versión validada.
function simulateConfluenciaSalidaAoAdx(series4H, seriesD, tpPct, leverage, marginFraction, horasPorVela){
  const idxD = alignDailyIndex(seriesD, series4H.times);
  const n = series4H.n;
  let equity = 1.0, peak = 1.0, maxDrawdown = 0;
  let position = null, entryPrice = null, tpPrice = null, entryIdx = null;
  const trades = [];
  const nocionalFraction = marginFraction * leverage;

  const closeTrade = (exitPrice, feePct, i) => {
    const rawReturn = position==='long' ? (exitPrice/entryPrice - 1) : (1 - exitPrice/entryPrice);
    const leveraged = rawReturn * leverage;
    const comisionSalidaPct = nocionalFraction * (feePct/100) * 100;
    const horasAbierta = (i - entryIdx) * horasPorVela;
    const periodosFunding = Math.floor(horasAbierta / 8);
    const fundingPct = nocionalFraction * (BITGET_FUNDING_PCT_PER_8H/100) * periodosFunding * 100;
    const equityChange = marginFraction * leveraged - comisionSalidaPct/100 - fundingPct/100;
    equity *= Math.max(0, 1 + equityChange);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    trades.push({ equityChangePct: equityChange*100, entryIdx });
    position = null; entryPrice = null; tpPrice = null; entryIdx = null;
  };

  for(let i=1;i<n;i++){
    const iD = idxD[i];
    if(position){
      const hitTP = position==='long' ? series4H.highs[i] >= tpPrice : series4H.lows[i] <= tpPrice;
      const forzadoKoncorde = !isNaN(series4H.konVal[i]) && !isNaN(series4H.maTrend[i]) && series4H.konVal[i] < series4H.maTrend[i];
      const retrocesoAoAdx = position==='long'
        ? (series4H.aoState[i]==='Retroceso alcista' && !series4H.adxSubiendo[i])
        : (series4H.aoState[i]==='Retroceso bajista' && !series4H.adxSubiendo[i]);
      if(hitTP){ closeTrade(tpPrice, BITGET_MAKER_FEE_PCT, i); }
      else if(position==='long' && forzadoKoncorde){ closeTrade(series4H.closes[i], BITGET_TAKER_FEE_PCT, i); }
      else if(retrocesoAoAdx){ closeTrade(series4H.closes[i], BITGET_TAKER_FEE_PCT, i); }
    }
    if(!position){
      const aoAlcista = series4H.aoState[i]==='Alcista', aoBajista = series4H.aoState[i]==='Bajista';
      const dailyBullish = iD>=0 && seriesD.aoState[iD]==='Alcista' && seriesD.koBull[iD];
      const dailyBearish = iD>=0 && seriesD.aoState[iD]==='Bajista' && seriesD.koBear[iD];
      let comprarOk = aoAlcista && series4H.adxSubiendo[i] && series4H.koBull[i] && dailyBullish;
      let venderOk  = aoBajista && series4H.adxSubiendo[i] && series4H.koBear[i] && dailyBearish;
      // El cierre forzado por Koncorde también puede abrir un corto nuevo, igual que en la versión validada.
      const forzadoAbreCorto = !isNaN(series4H.konVal[i]) && !isNaN(series4H.maTrend[i]) && series4H.konVal[i] < series4H.maTrend[i];
      if(comprarOk){ position='long'; entryPrice=series4H.closes[i]; tpPrice=entryPrice*(1+tpPct/100); entryIdx=i;
        const comisionEntradaPct = nocionalFraction * (BITGET_TAKER_FEE_PCT/100) * 100; equity *= Math.max(0, 1 - comisionEntradaPct/100); }
      else if(venderOk || forzadoAbreCorto){ position='short'; entryPrice=series4H.closes[i]; tpPrice=entryPrice*(1-tpPct/100); entryIdx=i;
        const comisionEntradaPct = nocionalFraction * (BITGET_TAKER_FEE_PCT/100) * 100; equity *= Math.max(0, 1 - comisionEntradaPct/100); }
    }
  }
  if(position) closeTrade(series4H.closes[n-1], BITGET_TAKER_FEE_PCT, n-1);

  const wins = trades.filter(t=>t.equityChangePct>0).length;
  const grossGain = trades.filter(t=>t.equityChangePct>0).reduce((a,t)=>a+t.equityChangePct,0);
  const grossLoss = Math.abs(trades.filter(t=>t.equityChangePct<=0).reduce((a,t)=>a+t.equityChangePct,0));
  return {
    trades: trades.length,
    winRatePct: trades.length ? (wins/trades.length*100) : 0,
    totalReturnPct: (equity-1)*100,
    maxDrawdownPct: maxDrawdown*100,
    profitFactor: grossLoss>0 ? (grossGain/grossLoss) : (grossGain>0 ? Infinity : 0),
    tradeLog: trades
  };
}

// Recalcula las métricas para un SUBCONJUNTO de operaciones, componiendo el
// capital desde cero (equity=1.0) solo con esas operaciones — así el tramo
// reservado se evalúa como si fuera un periodo independiente, con su propio
// drawdown, y no arrastra el resultado acumulado del resto del histórico.
// Analiza cada operación en detalle: el camino vela a vela de la ganancia
// flotante (no solo el resultado final), y para las cerradas por TP, una
// continuación "fantasma" sin TP para ver hasta dónde habrían llegado de
// verdad si no las hubiéramos cerrado ahí.
function analizarOperacionesDetallado(series4H, seriesD, verdicts, tpPct, leverage, marginFraction, horasPorVela){
  const idxD = alignDailyIndex(seriesD, series4H.times);
  const n = series4H.n;
  const nocionalFraction = marginFraction * leverage;
  const operaciones = [];

  // Ganancia flotante (en % de la cuenta, ya con el apalancamiento aplicado,
  // SIN comisiones — las comisiones solo se cobran al cerrar de verdad) en
  // un instante dado, dado el precio de entrada y el precio actual.
  function flotantePct(direction, entryPrice, currentPrice){
    const raw = direction==='long' ? (currentPrice/entryPrice - 1) : (1 - currentPrice/entryPrice);
    return marginFraction * raw * leverage * 100;
  }

  let position=null, entryPrice=null, tpPrice=null, entryIdx=null, path=null;

  const cerrar = (exitPrice, exitIdx, motivo) => {
    const finalPct = flotantePct(position, entryPrice, exitPrice);
    const mejor = Math.max(...path, finalPct);
    const peor = Math.min(...path, finalPct);
    const positivos = path.filter(p=>p>0).length;
    operaciones.push({
      direction: position, entryIdx, exitIdx, motivo,
      finalPct, mejorPct: mejor, peorPct: peor,
      fraccionPositiva: path.length ? positivos/path.length : 0,
      duracionVelas: exitIdx - entryIdx
    });
    position=null; entryPrice=null; tpPrice=null; entryIdx=null; path=null;
  };

  for(let i=1;i<n;i++){
    const iD = idxD[i];
    if(position){
      path.push(flotantePct(position, entryPrice, series4H.closes[i]));
      const hitTP = position==='long' ? series4H.highs[i] >= tpPrice : series4H.lows[i] <= tpPrice;
      const forzado = position==='long' && !isNaN(series4H.konVal[i]) && !isNaN(series4H.maTrend[i]) && series4H.konVal[i] < series4H.maTrend[i];
      const v = verdicts[i];
      const stillValid = (position==='long' && v==='COMPRAR') || (position==='short' && v==='VENDER');
      if(hitTP) cerrar(tpPrice, i, 'TP');
      else if(forzado) cerrar(series4H.closes[i], i, 'forzado');
      else if(!stillValid) cerrar(series4H.closes[i], i, 'veredicto');
    }
    if(!position){
      if(verdicts[i]==='COMPRAR' || verdicts[i]==='VENDER'){
        position = verdicts[i]==='COMPRAR' ? 'long' : 'short';
        entryPrice = series4H.closes[i];
        tpPrice = position==='long' ? entryPrice*(1+tpPct/100) : entryPrice*(1-tpPct/100);
        entryIdx = i; path = [];
      }
    }
  }
  if(position) cerrar(series4H.closes[n-1], n-1, 'fin_datos');

  // Para cada operación cerrada por TP, simula qué habría pasado SIN TP:
  // continúa desde ahí mismo, misma dirección, hasta que el veredicto
  // cambie o se fuerce el cierre (usando el histórico real que ya pasó).
  operaciones.filter(op=>op.motivo==='TP').forEach(op=>{
    let precioEntradaSombra = series4H.closes[op.entryIdx]; // mismo precio de entrada original
    let mejorSombra = op.finalPct, i = op.exitIdx;
    for(i=op.exitIdx; i<n; i++){
      const pct = flotantePct(op.direction, precioEntradaSombra, series4H.closes[i]);
      if(pct > mejorSombra) mejorSombra = pct;
      const forzado = op.direction==='long' && !isNaN(series4H.konVal[i]) && !isNaN(series4H.maTrend[i]) && series4H.konVal[i] < series4H.maTrend[i];
      const v = verdicts[i];
      const stillValid = (op.direction==='long' && v==='COMPRAR') || (op.direction==='short' && v==='VENDER');
      if(forzado || !stillValid) break;
    }
    const pctFinalSombra = flotantePct(op.direction, precioEntradaSombra, series4H.closes[Math.min(i,n-1)]);
    op.sombraSinTP_mejor = mejorSombra;
    op.sombraSinTP_final = pctFinalSombra;
    op.habriaMejorado = mejorSombra > op.finalPct;
  });

  return operaciones;
}

// Recalcula las métricas para un SUBCONJUNTO de operaciones, componiendo el
// capital desde cero (equity=1.0) solo con esas operaciones — así el tramo
// reservado se evalúa como si fuera un periodo independiente, con su propio
// drawdown, y no arrastra el resultado acumulado del resto del histórico.
function metricsForTradeSubset(tradeLog){
  let equity = 1.0, peak = 1.0, maxDrawdown = 0;
  tradeLog.forEach(t=>{
    equity *= Math.max(0, 1 + t.equityChangePct/100);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak-equity)/peak);
  });
  const wins = tradeLog.filter(t=>t.equityChangePct>0).length;
  const grossGain = tradeLog.filter(t=>t.equityChangePct>0).reduce((a,t)=>a+t.equityChangePct,0);
  const grossLoss = Math.abs(tradeLog.filter(t=>t.equityChangePct<=0).reduce((a,t)=>a+t.equityChangePct,0));
  return {
    trades: tradeLog.length,
    winRatePct: tradeLog.length ? (wins/tradeLog.length*100) : 0,
    totalReturnPct: (equity-1)*100,
    maxDrawdownPct: maxDrawdown*100,
    profitFactor: grossLoss>0 ? (grossGain/grossLoss) : (grossGain>0 ? Infinity : 0)
  };
}

// Cuenta cuántas veces cambió el estado del AO (Alcista/Bajista/Retroceso...)
// en las últimas 'ventana' velas antes (e incluyendo) el índice i — una
// medida directa de "cuántos bandazos está dando el indicador" justo antes
// de esa entrada. Muchos cambios = indicador indeciso/errático.
// Para cada vela donde 'triggerArray' es true, comprueba cuál de los dos umbrales
// (a favor, 'targetPct', o en contra, 'stopPct') se toca antes, mirando hasta
// 'maxBars' velas hacia adelante. Si ambos se tocan en la misma vela, cuenta como
// pérdida (criterio conservador). Genérica: sirve para cualquier indicador y
// cualquier temporalidad, solo necesita el array de disparo ya calculado.
function carreraHaciaObjetivo(series, triggerArray, direction, targetPct, stopPct, maxBars){
  const resultados = [];
  const n = series.n;
  for(let i=0; i<n; i++){
    if(!triggerArray[i]) continue;
    if(i+1>=n) continue;
    const entryPrice = series.closes[i];
    const targetPrice = direction==='long' ? entryPrice*(1+targetPct/100) : entryPrice*(1-targetPct/100);
    const stopPrice = direction==='long' ? entryPrice*(1-stopPct/100) : entryPrice*(1+stopPct/100);
    let resultado = null, barsHasta = null;
    const limite = Math.min(i+maxBars, n-1);
    for(let k=i+1; k<=limite; k++){
      const tocaTarget = direction==='long' ? series.highs[k]>=targetPrice : series.lows[k]<=targetPrice;
      const tocaStop = direction==='long' ? series.lows[k]<=stopPrice : series.highs[k]>=stopPrice;
      if(tocaStop){ resultado = false; barsHasta = k-i; break; } // el stop tiene prioridad si coincide (conservador)
      if(tocaTarget){ resultado = true; barsHasta = k-i; break; }
    }
    resultados.push({ entryIdx: i, resultado, barsHasta });
  }
  return resultados;
}

// Construye, para una serie dada, los arrays de disparo (largo/corto) de cada
// indicador por separado — genérico, para no repetir la misma lógica siete veces.
function construirDisparadores(series, mlSignalSerie){
  const n = series.n;
  function flipToState(arr, estado){
    const out = new Array(n).fill(false);
    for(let i=1;i<n;i++) if(arr[i]===estado && arr[i-1]!==estado) out[i]=true;
    return out;
  }
  function flipToTrue(arr){
    const out = new Array(n).fill(false);
    for(let i=1;i<n;i++) if(arr[i] && !arr[i-1]) out[i]=true;
    return out;
  }
  function crossAbove(a,b){
    const out = new Array(n).fill(false);
    for(let i=1;i<n;i++){
      if(isNaN(a[i])||isNaN(b[i])||isNaN(a[i-1])||isNaN(b[i-1])) continue;
      if(a[i]>b[i] && a[i-1]<=b[i-1]) out[i]=true;
    }
    return out;
  }
  function crossSign(vals, positivo){
    const out = new Array(n).fill(false);
    for(let i=1;i<n;i++){
      if(isNaN(vals[i])||isNaN(vals[i-1])) continue;
      if(positivo ? (vals[i]>0 && vals[i-1]<=0) : (vals[i]<0 && vals[i-1]>=0)) out[i]=true;
    }
    return out;
  }

  const momentumReciente = new Array(n).fill('long');
  for(let i=3;i<n;i++) momentumReciente[i] = series.closes[i]>series.closes[i-3] ? 'long' : 'short';

  const bbwpLong = new Array(n).fill(false), bbwpShort = new Array(n).fill(false);
  for(let i=0;i<n;i++){
    if(bbwpAscendiendoYAlto(series, i, 50, 3)){
      if(momentumReciente[i]==='long') bbwpLong[i]=true; else bbwpShort[i]=true;
    }
  }

  const disparadores = {
    'AO': { long: flipToState(series.aoState,'Alcista'), short: flipToState(series.aoState,'Bajista') },
    'Koncorde': { long: flipToTrue(series.koBull), short: flipToTrue(series.koBear) },
    'ADX (cruce DI)': { long: crossAbove(series.plusDI, series.minusDI), short: crossAbove(series.minusDI, series.plusDI) },
    'BBWP (despierta)': { long: bbwpLong, short: bbwpShort },
    'LaRSI': { long: series.larsiState.map(s=>s==='compra'), short: series.larsiState.map(s=>s==='venta') },
    'Trend Speed': { long: crossSign(series.trendspeed, true), short: crossSign(series.trendspeed, false) }
  };
  if(mlSignalSerie){
    disparadores['ML RSI'] = { long: flipToState(mlSignalSerie,'Alcista'), short: flipToState(mlSignalSerie,'Bajista') };
  }
  return disparadores;
}

function contarCambiosAO(series, i, ventana){
  let cambios = 0;
  const desde = Math.max(1, i - ventana + 1);
  for(let k=desde; k<=i; k++){
    if(series.aoState[k] !== series.aoState[k-1]) cambios++;
  }
  return cambios;
}

// BBWP "alto o acercándose, y en subida": por encima del umbral (por defecto 45,
// para cubrir tanto "ya pasó de 50" como "a punto de llegar"), Y estrictamente
// mayor que 'lookback' velas atrás (confirma que está subiendo, no bajando ni
// plano).
// ¿Está la media (maTrend) DENTRO de la zona amarilla (entre 0 y oscp)?
// Para largos: oscp>0 y 0<maTrend<oscp. Para cortos: oscp<0 y oscp<maTrend<0 (espejo).
function dentroZonaAmarilla(series, i, direction){
  const oscp = series.oscp[i], mt = series.maTrend[i];
  if(isNaN(oscp) || isNaN(mt)) return false;
  return direction==='long' ? (oscp>0 && mt>0 && mt<oscp) : (oscp<0 && mt<0 && mt>oscp);
}

// ¿Acaba de ENTRAR la media en la zona amarilla en esta vela concreta (antes no estaba, ahora sí)?
function entrandoZonaAmarilla(series, i, direction){
  if(i<1) return false;
  return dentroZonaAmarilla(series, i, direction) && !dentroZonaAmarilla(series, i-1, direction);
}

// ¿Está el AO "cerca de cero" en relación a su propio historial reciente? (no tiene escala
// fija, así que se compara contra la magnitud media de |AO| en la ventana previa)
function aoCercaDeCero(series, i, ventana, factor){
  if(i<ventana) return false;
  let suma = 0, cuenta = 0;
  for(let k=i-ventana; k<i; k++){ if(!isNaN(series.ao[k])){ suma += Math.abs(series.ao[k]); cuenta++; } }
  if(cuenta===0 || isNaN(series.ao[i])) return false;
  const mediaReciente = suma/cuenta;
  return Math.abs(series.ao[i]) < factor*mediaReciente;
}

// ¿Está el BBWP "acercándose" a un nivel (dentro de un rango por debajo) Y subiendo?
function bbwpAcercandoseA(series, i, nivel, margen, lookback){
  if(i<lookback) return false;
  if(isNaN(series.bbwp[i]) || isNaN(series.bbwp[i-lookback])) return false;
  const enRango = series.bbwp[i] <= nivel && series.bbwp[i] >= nivel-margen;
  return enRango && series.bbwp[i] > series.bbwp[i-lookback];
}

// Zona amarilla ÚNICA (no espejada): representa presión institucional alcista
// acumulándose. Solo existe cuando oscp>0 — no hay una "zona amarilla bajista"
// separada, es la MISMA zona la que se usa en los dos sentidos.
function dentroZonaAmarillaUnica(series, i){
  const oscp = series.oscp[i], mt = series.maTrend[i];
  if(isNaN(oscp) || isNaN(mt)) return false;
  return oscp>0 && mt>0 && mt<oscp;
}

// La media ACABA DE ENTRAR en la zona (impulso alcista construyéndose) → señal de largo
function entrandoZonaAmarillaUnica(series, i){
  if(i<1) return false;
  return dentroZonaAmarillaUnica(series, i) && !dentroZonaAmarillaUnica(series, i-1);
}

// La media ACABA DE SALIR de la zona POR ABAJO (cruzando de vuelta hacia/por debajo
// de cero, no superando oscp por arriba) → el impulso alcista se agota, señal de corto
function saliendoZonaAmarillaHaciaAbajo(series, i){
  if(i<1) return false;
  if(!dentroZonaAmarillaUnica(series, i-1)) return false; // tenía que estar dentro antes
  const mt = series.maTrend[i];
  if(isNaN(mt)) return false;
  return mt<=0; // ahora ha cruzado por debajo del límite inferior de la zona (cero)
}

function bbwpAscendiendoYAlto(series, i, umbral, lookback){
  if(umbral==null) umbral = 45;
  if(lookback==null) lookback = 3;
  if(i<lookback) return false;
  if(isNaN(series.bbwp[i]) || isNaN(series.bbwp[i-lookback])) return false;
  return series.bbwp[i] >= umbral && series.bbwp[i] > series.bbwp[i-lookback];
}

// Cuenta cuántas velas SEGUIDAS (incluyendo i, mirando hacia atrás sin cortes)
// una condición ha sido verdadera. Un valor alto significa que esa condición
// "avisó primero" — llevaba cumplida desde antes; un valor de 1 significa que
// se acaba de cumplir justo en esta vela (es la que "dispara" la entrada).
function velasLlevaCumplida(getCondicion, i){
  let count = 0, k = i;
  while(k >= 0 && getCondicion(k)){ count++; k--; }
  return count;
}

// Confluencia en 4H con TAKE PROFIT PARCIAL: al tocar el TP (3% de precio),
// cierra solo una FRACCIÓN de la posición (fraccionCierre) y deja correr el
// resto con las reglas de salida normales (cambio de veredicto / cierre
// forzado por Koncorde). Si protegerBreakeven=true, el resto además se
// cierra si el precio vuelve al precio de entrada (breakeven), para que la
// operación completa nunca pueda terminar en negativo tras haber cobrado
// la parte parcial.
function simulateConfluenciaTPParcial(series4H, seriesD, tpPct, leverage, marginFraction, horasPorVela, fraccionCierre, protegerBreakeven, filtroEntradaExtra, slPct, trailPct, marginFractionFn){
  const idxD = alignDailyIndex(seriesD, series4H.times);
  const n = series4H.n;
  let equity = 1.0, peak = 1.0, maxDrawdown = 0;
  let position=null, entryPrice=null, tpPrice=null, slPrice=null, mejorPrecioFavorable=null, entryIdx=null, tpParcialHecho=false, fraccionRestante=null, ultimoCierreIdx=null, equityAntesEntrada=null;
  const trades = [];
  let marginFractionActiva = marginFraction;
  let nocionalFraction = marginFraction * leverage;

  function cerrarFraccion(fraccion, exitPrice, feePct, iExit, iDesde){
    const rawReturn = position==='long' ? (exitPrice/entryPrice - 1) : (1 - exitPrice/entryPrice);
    const leveraged = rawReturn * leverage;
    const comisionPct = (nocionalFraction*fraccion) * (feePct/100) * 100;
    const horasAbierta = (iExit - iDesde) * horasPorVela;
    const periodosFunding = Math.floor(horasAbierta / 8);
    const fundingPct = (nocionalFraction*fraccion) * (BITGET_FUNDING_PCT_PER_8H/100) * periodosFunding * 100;
    const equityChange = (marginFractionActiva*fraccion) * leveraged - comisionPct/100 - fundingPct/100;
    equity *= Math.max(0, 1 + equityChange);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }

  function cerrarOperacionCompleta(iExit){
    trades.push({ equityChangePct: (equity/equityAntesEntrada - 1)*100, entryIdx, exitIdx: iExit, tocoTP: tpParcialHecho });
    position=null; entryPrice=null; tpPrice=null; entryIdx=null; tpParcialHecho=false; equityAntesEntrada=null;
  }

  for(let i=1;i<n;i++){
    const iD = idxD[i];
    if(position){
      let trailStopPrice = null, hitTrail = false;
      if(trailPct!=null){
        mejorPrecioFavorable = position==='long' ? Math.max(mejorPrecioFavorable, series4H.highs[i]) : Math.min(mejorPrecioFavorable, series4H.lows[i]);
        trailStopPrice = position==='long' ? mejorPrecioFavorable*(1-trailPct/100) : mejorPrecioFavorable*(1+trailPct/100);
        hitTrail = position==='long' ? series4H.lows[i] <= trailStopPrice : series4H.highs[i] >= trailStopPrice;
      }
      if(!tpParcialHecho){
        const hitSL = slPct!=null && (position==='long' ? series4H.lows[i] <= slPrice : series4H.highs[i] >= slPrice);
        const hitTP = position==='long' ? series4H.highs[i] >= tpPrice : series4H.lows[i] <= tpPrice;
        const forzado = position==='long' && !isNaN(series4H.konVal[i]) && !isNaN(series4H.maTrend[i]) && series4H.konVal[i] < series4H.maTrend[i];
        const v = verdicts4H_local(series4H, seriesD, i, iD);
        const stillValid = (position==='long' && v==='COMPRAR') || (position==='short' && v==='VENDER');
        if(hitSL || hitTrail){
          // El SL/trailing tiene prioridad si coincidiera con el TP en la misma vela — criterio conservador.
          cerrarFraccion(1.0, hitTrail ? trailStopPrice : slPrice, BITGET_TAKER_FEE_PCT, i, entryIdx);
          cerrarOperacionCompleta(i);
        } else if(hitTP){
          // Cierra la fracción indicada al precio del TP, deja correr el resto.
          cerrarFraccion(fraccionCierre, tpPrice, BITGET_MAKER_FEE_PCT, i, entryIdx);
          tpParcialHecho = true; fraccionRestante = 1-fraccionCierre; ultimoCierreIdx = i;
        } else if(forzado || !stillValid){
          cerrarFraccion(1.0, series4H.closes[i], BITGET_TAKER_FEE_PCT, i, entryIdx);
          cerrarOperacionCompleta(i);
        }
      } else {
        // Ya se cobró la parte parcial — el resto corre con las reglas normales
        // (y opcionalmente breakeven, y opcionalmente SL/trailing) hasta su propio cierre.
        const hitSLResto = slPct!=null && (position==='long' ? series4H.lows[i] <= slPrice : series4H.highs[i] >= slPrice);
        const forzado = position==='long' && !isNaN(series4H.konVal[i]) && !isNaN(series4H.maTrend[i]) && series4H.konVal[i] < series4H.maTrend[i];
        const v = verdicts4H_local(series4H, seriesD, i, iD);
        const stillValid = (position==='long' && v==='COMPRAR') || (position==='short' && v==='VENDER');
        const hitBreakeven = protegerBreakeven && (position==='long' ? series4H.lows[i] <= entryPrice : series4H.highs[i] >= entryPrice);
        if(hitSLResto || hitTrail){
          cerrarFraccion(fraccionRestante, hitTrail ? trailStopPrice : slPrice, BITGET_TAKER_FEE_PCT, i, ultimoCierreIdx);
          cerrarOperacionCompleta(i);
        } else if(hitBreakeven){
          cerrarFraccion(fraccionRestante, entryPrice, BITGET_TAKER_FEE_PCT, i, ultimoCierreIdx);
          cerrarOperacionCompleta(i);
        } else if(forzado || !stillValid){
          cerrarFraccion(fraccionRestante, series4H.closes[i], BITGET_TAKER_FEE_PCT, i, ultimoCierreIdx);
          cerrarOperacionCompleta(i);
        }
      }
    }
    if(!position){
      const v = verdicts4H_local(series4H, seriesD, i, iD);
      if(v==='COMPRAR' || v==='VENDER'){
        const direction = v==='COMPRAR' ? 'long' : 'short';
        const pasaFiltroExtra = !filtroEntradaExtra || filtroEntradaExtra(i, direction);
        if(pasaFiltroExtra){
          position = direction;
          marginFractionActiva = marginFractionFn!=null ? marginFractionFn(i, direction) : marginFraction;
          nocionalFraction = marginFractionActiva * leverage;
          entryPrice = series4H.closes[i];
          tpPrice = position==='long' ? entryPrice*(1+tpPct/100) : entryPrice*(1-tpPct/100);
          slPrice = slPct!=null ? (position==='long' ? entryPrice*(1-slPct/100) : entryPrice*(1+slPct/100)) : null;
          mejorPrecioFavorable = trailPct!=null ? entryPrice : null;
          entryIdx = i; tpParcialHecho=false; equityAntesEntrada=equity;
          const comisionEntradaPct = nocionalFraction * (BITGET_TAKER_FEE_PCT/100) * 100;
          equity *= Math.max(0, 1 - comisionEntradaPct/100);
        }
      }
    }
  }
  if(position){
    const fraccionFinal = tpParcialHecho ? fraccionRestante : 1.0;
    const desde = tpParcialHecho ? ultimoCierreIdx : entryIdx;
    cerrarFraccion(fraccionFinal, series4H.closes[n-1], BITGET_TAKER_FEE_PCT, n-1, desde);
    cerrarOperacionCompleta(n-1);
  }

  const wins = trades.filter(t=>t.equityChangePct>0).length;
  const grossGain = trades.filter(t=>t.equityChangePct>0).reduce((a,t)=>a+t.equityChangePct,0);
  const grossLoss = Math.abs(trades.filter(t=>t.equityChangePct<=0).reduce((a,t)=>a+t.equityChangePct,0));
  return {
    trades: trades.length,
    winRatePct: trades.length ? (wins/trades.length*100) : 0,
    totalReturnPct: (equity-1)*100,
    maxDrawdownPct: maxDrawdown*100,
    profitFactor: grossLoss>0 ? (grossGain/grossLoss) : (grossGain>0 ? Infinity : 0),
    tradeLog: trades
  };
}
// Réplica exacta de la lógica de veredicto de buildVerdicts4H, pero evaluada
// para una sola vela (necesaria dentro del simulador de TP parcial).
function verdicts4H_local(series4H, seriesD, i, iD){
  const aoAlcista = series4H.aoState[i]==='Alcista', aoBajista = series4H.aoState[i]==='Bajista';
  const dailyBullish = iD>=0 && seriesD.aoState[iD]==='Alcista' && seriesD.koBull[iD];
  const dailyBearish = iD>=0 && seriesD.aoState[iD]==='Bajista' && seriesD.koBear[iD];
  let comprarOk = aoAlcista && series4H.adxSubiendo[i] && series4H.koBull[i] && dailyBullish;
  let venderOk  = aoBajista && series4H.adxSubiendo[i] && series4H.koBear[i] && dailyBearish;
  return comprarOk ? 'COMPRAR' : (venderOk ? 'VENDER' : 'ESPERAR');
}

function pad(str, len){ str=String(str); return str.length>=len ? str : str + ' '.repeat(len-str.length); }

function padL(str, len){ str=String(str); return str.length>=len ? str : ' '.repeat(len-str.length) + str; }
function fmtPct(n){ return (n>=0?'+':'') + n.toFixed(2) + '%'; }

async function main(){
  console.log('=== Bitman Backtest ===');
  console.log('Símbolo: ' + SYMBOL + ' · Temporalidad: 1H · Periodo: últimos ' + MESES_HISTORICO + ' meses · Apalancamiento: ' + LEVERAGE + 'x');
  console.log('Descargando velas 1H...');
  const ohlcv = await fetchCandlesForMonths('1h', MESES_HISTORICO);
  console.log('Velas 1H descargadas: ' + ohlcv.closes.length + ' (desde ' + new Date(ohlcv.times[0]).toISOString() + ' hasta ' + new Date(ohlcv.times[ohlcv.times.length-1]).toISOString() + ')');

  console.log('Descargando velas 4H y Diario (para la puerta de confluencia)...');
  const ohlcv4H = await fetchCandlesForMonths('4h', MESES_HISTORICO, 300);
  const ohlcvD  = await fetchCandlesForMonths('1d', MESES_HISTORICO, 300);
  console.log('Velas 4H: ' + ohlcv4H.closes.length + ' · Velas Diario: ' + ohlcvD.closes.length);

  const s = computeFullSeries(ohlcv);
  const s4H = computeFullSeries(ohlcv4H);
  const sD = computeFullSeries(ohlcvD);
  const gates = buildConfluenceGates(s, s4H, sD);

  // Recortamos el análisis a los últimos MESES_HISTORICO meses reales
  // (las velas de más son solo warmup para que los indicadores y el
  // ML RSI tengan ya su ventana completa desde el primer día contado).
  const cutoffTime = ohlcv.times[ohlcv.times.length-1] - MESES_HISTORICO*30*86400000;
  let startIdx = 0;
  while(startIdx < s.n && ohlcv.times[startIdx] < cutoffTime) startIdx++;
  console.log('Vela de inicio del análisis: ' + new Date(ohlcv.times[startIdx]).toISOString() + ' (índice ' + startIdx + ' de ' + s.n + ')');

  console.log('\nCalculando ML RSI para todo el histórico (puede tardar 1-2 minutos)...');
  const t0 = Date.now();
  const mlSignal = computeMLRSISeries(ohlcv.closes);
  console.log('ML RSI calculado en ' + ((Date.now()-t0)/1000).toFixed(1) + 's');

  // Recortamos los veredictos al rango [startIdx, n) para cada variante,
  // pero el simulador de operaciones necesita la serie completa desde 0
  // para no arrancar "a medias" de un cálculo con menos historial —
  // así que simulamos sobre toda la serie y luego solo el rango de
  // fechas de las operaciones importa para las métricas (aceptamos que
  // 1-2 operaciones puedan haber empezado justo antes del corte).

  // ---------- ANÁLISIS A: variantes de ADX ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS A — Formas de exigir el ADX (SL fijo ' + SL_DEFAULT_PCT + '% / TP fijo ' + TP_DEFAULT_PCT + '%, ' + LEVERAGE + 'x)');
  console.log('========================================');

  const variantes = [
    {key:'adx_estricto',           label:'ADX estricto (actual)'},
    {key:'sin_adx',                label:'Sin ADX (solo AO+Koncorde)'},
    {key:'adx_no_bajando',         label:'ADX no cayendo'},
    {key:'ml_rsi',                 label:'ML RSI en vez de ADX'},
    {key:'confluencia_htf',        label:'Confluencia 1H+(4H o Diario)'},
    {key:'cascada_diario_4h_1h',   label:'Cascada Diario→4H→1H'},
    {key:'pullback_4h_1h',         label:'Retroceso 4H + giro 1H'}
  ];

  const resultadosA = variantes.map(v=>{
    const verdicts = new Array(s.n).fill('ESPERAR');
    for(let i=1;i<s.n;i++) verdicts[i] = verdictAtVariant(s, i, v.key, mlSignal, gates);
    const r = simulateTrades(s, verdicts, SL_DEFAULT_PCT, TP_DEFAULT_PCT, LEVERAGE);
    return {label:v.label, ...r};
  });

  console.log('\n' + pad('Variante',28) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',11) + padL('Drawdown',11) + padL('Ret/Op',10) + padL('P.Factor',10));
  resultadosA.forEach(r=>{
    console.log(pad(r.label,28) + padL(r.trades,9) + padL(r.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(r.totalReturnPct),11) + padL('-'+r.maxDrawdownPct.toFixed(1)+'%',11) + padL(fmtPct(r.avgReturnPerTradePct),10) + padL(r.profitFactor.toFixed(2),10));
  });

  // ---------- ANÁLISIS B: barrido de SL/TP ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS B — Barrido de Stop Loss / Take Profit (lógica: Confluencia 1H+(4H o Diario), ' + LEVERAGE + 'x)');
  console.log('========================================');

  const verdictsActual = new Array(s.n).fill('ESPERAR');
  for(let i=1;i<s.n;i++) verdictsActual[i] = verdictAtVariant(s, i, 'confluencia_htf', mlSignal, gates);

  const slOptions = [3, 5, 7, 10];
  const tpOptions = [10, 15, 20, 25, 30];
  const resultadosB = [];
  slOptions.forEach(sl=>{
    tpOptions.forEach(tp=>{
      const r = simulateTrades(s, verdictsActual, sl, tp, LEVERAGE);
      resultadosB.push({sl, tp, ...r});
    });
  });

  console.log('\n' + pad('SL',6) + pad('TP',6) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',11) + padL('Drawdown',11) + padL('Ret/Op',10) + padL('P.Factor',10) + padL('Ret/DD',9));
  resultadosB.forEach(r=>{
    const retDD = r.maxDrawdownPct>0 ? (r.totalReturnPct/r.maxDrawdownPct) : (r.totalReturnPct>0?Infinity:0);
    console.log(pad('-'+r.sl+'%',6) + pad('+'+r.tp+'%',6) + padL(r.trades,9) + padL(r.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(r.totalReturnPct),11) + padL('-'+r.maxDrawdownPct.toFixed(1)+'%',11) + padL(fmtPct(r.avgReturnPerTradePct),10) + padL(r.profitFactor.toFixed(2),10) + padL(retDD.toFixed(2),9));
  });

  // Mejor por retorno total y mejor por relación retorno/drawdown
  const bestByReturn = resultadosB.slice().sort((a,b)=>b.totalReturnPct-a.totalReturnPct)[0];
  const bestByRiskAdj = resultadosB.slice().sort((a,b)=>{
    const ra = a.maxDrawdownPct>0 ? a.totalReturnPct/a.maxDrawdownPct : (a.totalReturnPct>0?Infinity:-Infinity);
    const rb = b.maxDrawdownPct>0 ? b.totalReturnPct/b.maxDrawdownPct : (b.totalReturnPct>0?Infinity:-Infinity);
    return rb-ra;
  })[0];

  console.log('\nMejor por retorno total: SL -' + bestByReturn.sl + '% / TP +' + bestByReturn.tp + '%  →  ' + fmtPct(bestByReturn.totalReturnPct) + ' (drawdown -' + bestByReturn.maxDrawdownPct.toFixed(1) + '%)');
  console.log('Mejor relación retorno/drawdown (más "seguro"): SL -' + bestByRiskAdj.sl + '% / TP +' + bestByRiskAdj.tp + '%  →  ' + fmtPct(bestByRiskAdj.totalReturnPct) + ' (drawdown -' + bestByRiskAdj.maxDrawdownPct.toFixed(1) + '%)');

  // ---------- ANÁLISIS C: tres formas de intentar reducir el drawdown ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS C — Reducir el drawdown (partiendo de Confluencia + SL -5% / TP +15%)');
  console.log('========================================');

  // C1: barrido de apalancamiento (con la mejor combinación ya encontrada)
  console.log('\n--- C1: Apalancamiento (Confluencia OR, SL -5% / TP +15%) ---');
  console.log(pad('Apalanc.',10) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',11) + padL('Drawdown',11) + padL('Ret/DD',9));
  [1,2,3,4,5].forEach(lev=>{
    const r = simulateTrades(s, verdictsActual, SL_DEFAULT_PCT, TP_DEFAULT_PCT, lev);
    const retDD = r.maxDrawdownPct>0 ? (r.totalReturnPct/r.maxDrawdownPct) : (r.totalReturnPct>0?Infinity:0);
    console.log(pad(lev+'x',10) + padL(r.trades,9) + padL(r.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(r.totalReturnPct),11) + padL('-'+r.maxDrawdownPct.toFixed(1)+'%',11) + padL(retDD.toFixed(2),9));
  });

  // C2: confluencia con OR (uno de los dos) vs AND (los dos a la vez)
  console.log('\n--- C2: Confluencia OR (uno de los dos) vs AND (los dos a la vez) — SL -5% / TP +15%, ' + LEVERAGE + 'x ---');
  const verdictsAnd = new Array(s.n).fill('ESPERAR');
  for(let i=1;i<s.n;i++) verdictsAnd[i] = verdictAtVariant(s, i, 'confluencia_htf_and', mlSignal, gates);
  const rOr = simulateTrades(s, verdictsActual, SL_DEFAULT_PCT, TP_DEFAULT_PCT, LEVERAGE);
  const rAnd = simulateTrades(s, verdictsAnd, SL_DEFAULT_PCT, TP_DEFAULT_PCT, LEVERAGE);
  console.log(pad('Modo',10) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',11) + padL('Drawdown',11) + padL('Ret/DD',9));
  [{label:'OR (actual)', r:rOr}, {label:'AND (estricto)', r:rAnd}].forEach(x=>{
    const retDD = x.r.maxDrawdownPct>0 ? (x.r.totalReturnPct/x.r.maxDrawdownPct) : (x.r.totalReturnPct>0?Infinity:0);
    console.log(pad(x.label,10) + padL(x.r.trades,9) + padL(x.r.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(x.r.totalReturnPct),11) + padL('-'+x.r.maxDrawdownPct.toFixed(1)+'%',11) + padL(retDD.toFixed(2),9));
  });

  // C3: SL más ajustado que el probado en el Análisis B (que solo bajaba hasta -3%)
  console.log('\n--- C3: Stop Loss afinado entre -2% y -2.5% (Confluencia OR, TP +15%, ' + LEVERAGE + 'x) ---');
  console.log(pad('SL',8) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',11) + padL('Drawdown',11) + padL('Ret/DD',9));
  [2.0,2.1,2.2,2.3,2.4,2.5].forEach(sl=>{
    const r = simulateTrades(s, verdictsActual, sl, TP_DEFAULT_PCT, LEVERAGE);
    const retDD = r.maxDrawdownPct>0 ? (r.totalReturnPct/r.maxDrawdownPct) : (r.totalReturnPct>0?Infinity:0);
    console.log(pad('-'+sl+'%',8) + padL(r.trades,9) + padL(r.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(r.totalReturnPct),11) + padL('-'+r.maxDrawdownPct.toFixed(1)+'%',11) + padL(retDD.toFixed(2),9));
  });

  // ---------- ANÁLISIS E: position sizing por riesgo fijo (sin tocar el apalancamiento) ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS E — Arriesgar solo un % fijo de la cuenta por operación (leverage se mantiene en ' + LEVERAGE + 'x, SL -5% / TP +15%)');
  console.log('========================================');
  console.log('En vez de usar el 100% del capital en cada operación, solo se arriesga el % indicado');
  console.log('de la cuenta total por operación (el resto queda protegido, sin exponerse). El');
  console.log('apalancamiento sigue siendo ' + LEVERAGE + 'x dentro de esa porción arriesgada — no se toca.');

  console.log('\n' + pad('% arriesgado',14) + padL('% del capital usado',20) + padL('Operac.',9) + padL('Retorno',11) + padL('Drawdown',11) + padL('Ret/DD',9));
  [0.5,1,2,3,5,10,25,50,100].forEach(riskPct=>{
    const r = simulateTradesRiskSized(s, verdictsActual, SL_DEFAULT_PCT, TP_DEFAULT_PCT, LEVERAGE, riskPct);
    const retDD = r.maxDrawdownPct>0 ? (r.totalReturnPct/r.maxDrawdownPct) : (r.totalReturnPct>0?Infinity:0);
    console.log(pad(riskPct+'%',14) + padL(r.marginFractionPct.toFixed(1)+'%',20) + padL(r.trades,9) + padL(fmtPct(r.totalReturnPct),11) + padL('-'+r.maxDrawdownPct.toFixed(1)+'%',11) + padL(retDD.toFixed(2),9));
  });

  // ---------- ANÁLISIS F: el indicador ORIGINAL (sin Confluencia), con position sizing ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS F — El indicador ORIGINAL (solo AO+ADX+Koncorde, sin Confluencia) con riesgo fijo por operación');
  console.log('========================================');
  console.log('Exactamente el mismo indicador base del dashboard HTML original — sin ningún filtro');
  console.log('de 4H/Diario añadido. Mismo position sizing que el Análisis E, para comparar directo.');

  const verdictsOriginal = new Array(s.n).fill('ESPERAR');
  for(let i=1;i<s.n;i++) verdictsOriginal[i] = verdictAtVariant(s, i, 'adx_estricto', mlSignal, gates);

  console.log('\n' + pad('% arriesgado',14) + padL('% del capital usado',20) + padL('Operac.',9) + padL('Retorno',11) + padL('Drawdown',11) + padL('Ret/DD',9));
  [0.5,1,2,3,5,10,25,50,100].forEach(riskPct=>{
    const r = simulateTradesRiskSized(s, verdictsOriginal, SL_DEFAULT_PCT, TP_DEFAULT_PCT, LEVERAGE, riskPct);
    const retDD = r.maxDrawdownPct>0 ? (r.totalReturnPct/r.maxDrawdownPct) : (r.totalReturnPct>0?Infinity:0);
    console.log(pad(riskPct+'%',14) + padL(r.marginFractionPct.toFixed(1)+'%',20) + padL(r.trades,9) + padL(fmtPct(r.totalReturnPct),11) + padL('-'+r.maxDrawdownPct.toFixed(1)+'%',11) + padL(retDD.toFixed(2),9));
  });

  // ---------- ANÁLISIS G: Confluencia SIN stop loss (solo TP o cambio de veredicto) ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS G — Confluencia SIN Stop Loss (TP +15% o cambio de veredicto, ' + LEVERAGE + 'x)');
  console.log('========================================');
  console.log('Sin SL no hay una distancia fija con la que calcular "% de riesgo", así que aquí se');
  console.log('prueban directamente los mismos % de capital usado por operación que en el Análisis E,');
  console.log('para comparar en igualdad de condiciones si quitar el SL ayuda o perjudica.');

  console.log('\n' + pad('% capital usado',18) + padL('Operac.',9) + padL('Retorno',11) + padL('Drawdown',11) + padL('Ret/DD',9) + padL('Peor op.',10));
  [2,4,8,12,20,40,100].forEach(marginPct=>{
    const r = simulateTradesNoSL(s, verdictsActual, TP_DEFAULT_PCT, LEVERAGE, marginPct/100);
    const retDD = r.maxDrawdownPct>0 ? (r.totalReturnPct/r.maxDrawdownPct) : (r.totalReturnPct>0?Infinity:0);
    console.log(pad(marginPct+'%',18) + padL(r.trades,9) + padL(fmtPct(r.totalReturnPct),11) + padL('-'+r.maxDrawdownPct.toFixed(1)+'%',11) + padL(retDD.toFixed(2),9) + padL(r.peorOperacionPct.toFixed(1)+'%',10));
  });

  // ---------- ANÁLISIS H: validación fuera de muestra (tramo reservado) ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS H — Validación fuera de muestra: últimos ' + MESES_RESERVADOS + ' meses reservados, nunca usados para elegir nada');
  console.log('========================================');
  console.log('Configuración elegida con el resto del histórico: Confluencia + SIN Stop Loss + TP +15%,');
  console.log('5x, 8% del capital por operación (el pico encontrado en el Análisis G).');
  console.log('Aquí se separan las operaciones en dos grupos según su fecha de ENTRADA:');
  console.log('  - "Resto del histórico": todo lo anterior al tramo reservado (esto es lo que ya vimos).');
  console.log('  - "Tramo reservado": solo los últimos ' + MESES_RESERVADOS + ' meses, evaluados de forma aislada,');
  console.log('    como si fueran un periodo nuevo e independiente (empezando con capital fresco).');

  const cutoffReservadoTime = ohlcv.times[ohlcv.times.length-1] - MESES_RESERVADOS*30*86400000;
  const rConSplit = simulateTradesNoSL(s, verdictsActual, TP_DEFAULT_PCT, LEVERAGE, 0.08);
  const tradesAntes = rConSplit.tradeLog.filter(t => s.times[t.entryIdx] < cutoffReservadoTime);
  const tradesReservado = rConSplit.tradeLog.filter(t => s.times[t.entryIdx] >= cutoffReservadoTime);

  const mAntes = metricsForTradeSubset(tradesAntes);
  const mReservado = metricsForTradeSubset(tradesReservado);

  console.log('\n' + pad('Tramo',20) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  console.log(pad('Resto del histórico',20) + padL(mAntes.trades,9) + padL(mAntes.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(mAntes.totalReturnPct),12) + padL('-'+mAntes.maxDrawdownPct.toFixed(1)+'%',11) + padL(mAntes.profitFactor.toFixed(2),10));
  console.log(pad('TRAMO RESERVADO',20) + padL(mReservado.trades,9) + padL(mReservado.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(mReservado.totalReturnPct),12) + padL('-'+mReservado.maxDrawdownPct.toFixed(1)+'%',11) + padL(mReservado.profitFactor.toFixed(2),10));

  console.log('\nOJO: esto NO es una validación perfecta — la elección de "Confluencia + sin SL + 8%"');
  console.log('se basó en el retorno agregado de TODO el periodo (incluido este tramo reservado),');
  console.log('así que no es un fuera-de-muestra puro. Pero si el profit factor y el % de acierto');
  console.log('del tramo reservado son similares (o mejores) que el resto, es una señal razonable');
  console.log('de que la ventaja no depende solo de un tramo antiguo concreto del histórico.');

  // ---------- ANÁLISIS I: Confluencia SIN SL, con el nuevo TP del bot en vivo (3% de precio = 15% sobre la posición con 5x) ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS I — Confluencia SIN Stop Loss, TP al 3% de precio (=15% sobre la posición con 5x)');
  console.log('========================================');
  console.log('Mismo barrido de % de capital usado que el Análisis G, pero con el TP ajustado');
  console.log('para que sea un 15% de beneficio SOBRE LA POSICIÓN apalancada, no un 15% de precio.');
  console.log('Con 5x, eso significa que el precio solo tiene que moverse un 3% para tocar el TP.');

  const TP_LEVERAGED_PCT = 3; // 15 (objetivo sobre la posición) / 5 (leverage) = 3% de precio

  console.log('\n' + pad('% capital usado',18) + padL('Operac.',9) + padL('Retorno',11) + padL('Drawdown',11) + padL('Ret/DD',9) + padL('Peor op.',10));
  [2,4,8,12,20,40,100].forEach(marginPct=>{
    const r = simulateTradesNoSL(s, verdictsActual, TP_LEVERAGED_PCT, LEVERAGE, marginPct/100);
    const retDD = r.maxDrawdownPct>0 ? (r.totalReturnPct/r.maxDrawdownPct) : (r.totalReturnPct>0?Infinity:0);
    console.log(pad(marginPct+'%',18) + padL(r.trades,9) + padL(fmtPct(r.totalReturnPct),11) + padL('-'+r.maxDrawdownPct.toFixed(1)+'%',11) + padL(retDD.toFixed(2),9) + padL(r.peorOperacionPct.toFixed(1)+'%',10));
  });

  // ---------- ANÁLISIS J: impacto de comisiones y funding reales de Bitget ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS J — Impacto de comisiones y funding reales de Bitget (USDT-M, margen aislado)');
  console.log('========================================');
  console.log('Comisiones: entrada y cierre por veredicto = taker (0.06%) · cierre por TP = maker (0.02%).');
  console.log('Funding: 0.01% del nocional cada 8h que la posición sigue abierta (estimación conservadora;');
  console.log('el funding real fluctúa entre -0.05% y +0.05% y puede ir a tu favor o en tu contra).');
  console.log('TP al 3% de precio (=15% sobre la posición con 5x) — la configuración ganadora actual.');

  const TP_ACTUAL_PCT = 3;
  console.log('\n--- Con TP al 3% de precio (config. actual, ' + s.n + ' velas totales) ---');
  console.log(pad('% capital usado',18) + padL('Sin comisiones',16) + padL('Con comisiones',16) + padL('Diferencia',12) + padL('Comis.totales',14));
  [2,4,8,12,20,40,100].forEach(marginPct=>{
    const rSin = simulateTradesNoSL(s, verdictsActual, TP_ACTUAL_PCT, LEVERAGE, marginPct/100);
    const rCon = simulateTradesNoSLConFees(s, verdictsActual, TP_ACTUAL_PCT, LEVERAGE, marginPct/100);
    const diferencia = rCon.totalReturnPct - rSin.totalReturnPct;
    console.log(pad(marginPct+'%',18) + padL(fmtPct(rSin.totalReturnPct),16) + padL(fmtPct(rCon.totalReturnPct),16) + padL(fmtPct(diferencia),12) + padL(rCon.totalComisionesPct.toFixed(1)+'%',14));
  });

  // ---------- Comparación: ¿el TP ancho (15%, menos operaciones) aguanta mejor las comisiones? ----------
  console.log('\n--- Con TP al 15% de precio (el original, menos operaciones — para comparar el efecto de la frecuencia) ---');
  console.log(pad('% capital usado',18) + padL('Sin comisiones',16) + padL('Con comisiones',16) + padL('Diferencia',12) + padL('Comis.totales',14) + padL('Operac.',9));
  [2,4,8,12,20,40,100].forEach(marginPct=>{
    const rSin = simulateTradesNoSL(s, verdictsActual, 15, LEVERAGE, marginPct/100);
    const rCon = simulateTradesNoSLConFees(s, verdictsActual, 15, LEVERAGE, marginPct/100);
    const diferencia = rCon.totalReturnPct - rSin.totalReturnPct;
    console.log(pad(marginPct+'%',18) + padL(fmtPct(rSin.totalReturnPct),16) + padL(fmtPct(rCon.totalReturnPct),16) + padL(fmtPct(diferencia),12) + padL(rCon.totalComisionesPct.toFixed(1)+'%',14) + padL(rCon.trades,9));
  });

  // ---------- ANÁLISIS K: señal en 4H (confirmada por Diario), con comisiones desde el principio ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS K — Señal generada en 4H (confirmada por Diario), no en 1H — para reducir la frecuencia');
  console.log('========================================');
  console.log('Misma lógica de Confluencia, pero un escalón más arriba: el 4H tiene que dar su propia');
  console.log('señal completa (AO+ADX+Koncorde), confirmada por el Diario (AO+Koncorde). Sin Stop Loss.');
  console.log('Comisiones y funding de Bitget incluidos desde el principio (velas de 4H → funding cada');
  console.log('8h = cada 2 velas).');

  // Construye el veredicto en la propia serie de 4H, usando el Diario como
  // confirmación (mismo patrón que buildConfluenceGates, pero un nivel más
  // arriba: aquí NO hace falta la puerta OR con 4H, porque el 4H ES la señal).
  function buildVerdicts4H(series4H, seriesD){
    const idxD = alignDailyIndex(seriesD, series4H.times);
    const n = series4H.n;
    const verdicts = new Array(n).fill('ESPERAR');
    for(let i=1;i<n;i++){
      const iD = idxD[i];
      const aoAlcista = series4H.aoState[i]==='Alcista', aoBajista = series4H.aoState[i]==='Bajista';
      const dailyBullish = iD>=0 && seriesD.aoState[iD]==='Alcista' && seriesD.koBull[iD];
      const dailyBearish = iD>=0 && seriesD.aoState[iD]==='Bajista' && seriesD.koBear[iD];
      let comprarOk = aoAlcista && series4H.adxSubiendo[i] && series4H.koBull[i] && dailyBullish;
      let venderOk  = aoBajista && series4H.adxSubiendo[i] && series4H.koBear[i] && dailyBearish;
      let verdict = comprarOk ? 'COMPRAR' : (venderOk ? 'VENDER' : 'ESPERAR');
      if(!isNaN(series4H.konVal[i]) && !isNaN(series4H.maTrend[i]) && series4H.konVal[i] < series4H.maTrend[i]){
        verdict = 'VENDER';
      }
      verdicts[i] = verdict;
    }
    return verdicts;
  }

  // Réplica fiel del ENHANCED_FILTER del bot original: exige que AO+ADX
  // confirmen con CONFIRM_LOOKBACK velas de continuidad (no solo 1), que el
  // ADX esté por encima de ADX_MIN_LEVEL (tendencia real según Wilder), y
  // que el BBWP esté por encima de BBWP_MIN_LEVEL (sin compresión extrema).
  // Igual que en el diseño original, esto SOLO endurece el lado comprador —
  // las ventas (y el cierre forzado por Koncorde) usan siempre la lectura
  // estándar de 1 vela, para no retrasar nunca una salida.
  const CONFIRM_LOOKBACK = 3, ADX_MIN_LEVEL = 20, BBWP_MIN_LEVEL = 25;
  function momentumState(series, i, lookback){
    if(i < lookback || isNaN(series.ao[i]) || isNaN(series.ao[i-lookback])){
      return { aoState:'Sin datos', adxSubiendo:false };
    }
    const subiendo = series.ao[i] > series.ao[i-lookback];
    let aoState;
    if(series.ao[i]>=0 && subiendo) aoState='Alcista';
    else if(series.ao[i]>=0 && !subiendo) aoState='Retroceso alcista';
    else if(series.ao[i]<0 && !subiendo) aoState='Bajista';
    else aoState='Retroceso bajista';
    const adxSubiendo = !isNaN(series.adx[i]) && !isNaN(series.adx[i-lookback]) && series.adx[i] > series.adx[i-lookback];
    return { aoState, adxSubiendo };
  }
  function buildVerdicts4HEnhanced(series4H, seriesD){
    const idxD = alignDailyIndex(seriesD, series4H.times);
    const n = series4H.n;
    const verdicts = new Array(n).fill('ESPERAR');
    for(let i=1;i<n;i++){
      const iD = idxD[i];
      const entryMs = momentumState(series4H, i, CONFIRM_LOOKBACK); // solo para el lado comprador
      const aoBajista = series4H.aoState[i]==='Bajista'; // el lado vendedor sigue con lectura estándar (1 vela)
      const dailyBullish = iD>=0 && seriesD.aoState[iD]==='Alcista' && seriesD.koBull[iD];
      const dailyBearish = iD>=0 && seriesD.aoState[iD]==='Bajista' && seriesD.koBear[iD];
      const adxFloorOk = !isNaN(series4H.adx[i]) && series4H.adx[i] >= ADX_MIN_LEVEL;
      const bbwpOk = !isNaN(series4H.bbwp[i]) && series4H.bbwp[i] > BBWP_MIN_LEVEL;
      let comprarOk = entryMs.aoState==='Alcista' && entryMs.adxSubiendo && series4H.koBull[i] && dailyBullish && adxFloorOk && bbwpOk;
      let venderOk  = aoBajista && series4H.adxSubiendo[i] && series4H.koBear[i] && dailyBearish;
      let verdict = comprarOk ? 'COMPRAR' : (venderOk ? 'VENDER' : 'ESPERAR');
      if(!isNaN(series4H.konVal[i]) && !isNaN(series4H.maTrend[i]) && series4H.konVal[i] < series4H.maTrend[i]){
        verdict = 'VENDER';
      }
      verdicts[i] = verdict;
    }
    return verdicts;
  }

  // Igual que la reforzada, pero aplicando el MISMO filtro (3 velas + ADX>=20
  // + BBWP>25) también al lado vendedor — no es el diseño original del bot,
  // es una variante simétrica para comprobar si el problema de 2021 estaba
  // concentrado en los cortos (que la versión asimétrica dejaba sin tocar).
  // El cierre forzado por Koncorde sigue sin verse afectado en ningún caso.
  function buildVerdicts4HEnhancedBoth(series4H, seriesD){
    const idxD = alignDailyIndex(seriesD, series4H.times);
    const n = series4H.n;
    const verdicts = new Array(n).fill('ESPERAR');
    for(let i=1;i<n;i++){
      const iD = idxD[i];
      const entryMs = momentumState(series4H, i, CONFIRM_LOOKBACK); // ahora para los dos lados
      const dailyBullish = iD>=0 && seriesD.aoState[iD]==='Alcista' && seriesD.koBull[iD];
      const dailyBearish = iD>=0 && seriesD.aoState[iD]==='Bajista' && seriesD.koBear[iD];
      const adxFloorOk = !isNaN(series4H.adx[i]) && series4H.adx[i] >= ADX_MIN_LEVEL;
      const bbwpOk = !isNaN(series4H.bbwp[i]) && series4H.bbwp[i] > BBWP_MIN_LEVEL;
      let comprarOk = entryMs.aoState==='Alcista' && entryMs.adxSubiendo && series4H.koBull[i] && dailyBullish && adxFloorOk && bbwpOk;
      let venderOk  = entryMs.aoState==='Bajista' && entryMs.adxSubiendo && series4H.koBear[i] && dailyBearish && adxFloorOk && bbwpOk;
      let verdict = comprarOk ? 'COMPRAR' : (venderOk ? 'VENDER' : 'ESPERAR');
      if(!isNaN(series4H.konVal[i]) && !isNaN(series4H.maTrend[i]) && series4H.konVal[i] < series4H.maTrend[i]){
        verdict = 'VENDER';
      }
      verdicts[i] = verdict;
    }
    return verdicts;
  }

  const verdicts4H = buildVerdicts4H(s4H, sD);
  const numSenales4H = verdicts4H.filter(v=>v!=='ESPERAR').length;
  console.log('\nVelas de 4H con señal activa: ' + numSenales4H + ' de ' + s4H.n + ' (frente a las ' + s.n + ' velas de 1H)');

  [
    {label:'TP 3% de precio (=15% posición con 5x)', tp:3},
    {label:'TP 15% de precio (=75% posición con 5x)', tp:15}
  ].forEach(cfg=>{
    console.log('\n--- ' + cfg.label + ' ---');
    console.log(pad('% capital usado',18) + padL('Operac.',9) + padL('Sin comisiones',16) + padL('Con comisiones',16) + padL('Comis.totales',14));
    [2,4,8,12,20,40,100].forEach(marginPct=>{
      const rSin = simulateTradesNoSL(s4H, verdicts4H, cfg.tp, LEVERAGE, marginPct/100);
      const rCon = simulateTradesNoSLConFees(s4H, verdicts4H, cfg.tp, LEVERAGE, marginPct/100, 4); // velas de 4H
      console.log(pad(marginPct+'%',18) + padL(rCon.trades,9) + padL(fmtPct(rSin.totalReturnPct),16) + padL(fmtPct(rCon.totalReturnPct),16) + padL(rCon.totalComisionesPct.toFixed(1)+'%',14));
    });
  });

  // ---------- ANÁLISIS L: validación fuera de muestra de la señal en 4H, CON comisiones ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS L — Validación fuera de muestra de la señal en 4H, con comisiones (últimos ' + MESES_RESERVADOS + ' meses reservados)');
  console.log('========================================');
  console.log('Misma idea que el Análisis H, pero con la señal de 4H (Análisis K) y las comisiones');
  console.log('reales de Bitget ya incluidas en el propio cálculo, no añadidas después.');

  const cutoffReservado4H = ohlcv4H.times[ohlcv4H.times.length-1] - MESES_RESERVADOS*30*86400000;

  [
    {label:'TP 3% de precio, 12% capital', tp:3, margin:0.12},
    {label:'TP 3% de precio, 20% capital', tp:3, margin:0.20},
    {label:'TP 15% de precio, 12% capital', tp:15, margin:0.12},
    {label:'TP 15% de precio, 20% capital', tp:15, margin:0.20}
  ].forEach(cfg=>{
    console.log('\n--- ' + cfg.label + ' ---');
    const rFull = simulateTradesNoSLConFees(s4H, verdicts4H, cfg.tp, LEVERAGE, cfg.margin, 4);
    const tradesAntes4H = rFull.tradeLog.filter(t => s4H.times[t.entryIdx] < cutoffReservado4H);
    const tradesReservado4H = rFull.tradeLog.filter(t => s4H.times[t.entryIdx] >= cutoffReservado4H);
    const mAntes4H = metricsForTradeSubset(tradesAntes4H);
    const mReservado4H = metricsForTradeSubset(tradesReservado4H);
    console.log(pad('Tramo',20) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
    console.log(pad('Resto del histórico',20) + padL(mAntes4H.trades,9) + padL(mAntes4H.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(mAntes4H.totalReturnPct),12) + padL('-'+mAntes4H.maxDrawdownPct.toFixed(1)+'%',11) + padL(mAntes4H.profitFactor.toFixed(2),10));
    console.log(pad('TRAMO RESERVADO',20) + padL(mReservado4H.trades,9) + padL(mReservado4H.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(mReservado4H.totalReturnPct),12) + padL('-'+mReservado4H.maxDrawdownPct.toFixed(1)+'%',11) + padL(mReservado4H.profitFactor.toFixed(2),10));
  });

  console.log('\nOJO: misma salvedad que el Análisis H — la elección de esta configuración se basó en el');
  console.log('retorno agregado de TODO el periodo (incluido el tramo reservado), así que no es un');
  console.log('fuera-de-muestra puro. Pero si el tramo reservado aguanta igual o mejor que el resto,');
  console.log('es una señal razonable de que la ventaja no depende solo de una parte antigua del histórico.');

  // ---------- ANÁLISIS M: walk-forward — desglose año por año (todos fuera de muestra entre sí) ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS M — Walk-forward: desglose por año calendario, señal en 4H con comisiones');
  console.log('========================================');
  console.log('En vez de un único tramo "reservado", aquí se parte TODO el histórico en años');
  console.log('calendario y se calcula cada año POR SEPARADO (capital fresco, sin arrastrar nada');
  console.log('de los años anteriores) — así vemos si la ventaja se sostiene año tras año, o si');
  console.log('depende de uno o dos años concretos que están arrastrando la media hacia arriba.');

  function bucketizeTradesByCalendarYear(tradeLog, times){
    const buckets = {};
    tradeLog.forEach(t=>{
      const year = new Date(times[t.entryIdx]).getUTCFullYear();
      if(!buckets[year]) buckets[year] = [];
      buckets[year].push(t);
    });
    return buckets;
  }

  [
    {label:'TP 3% de precio, 12% capital', tp:3, margin:0.12},
    {label:'TP 15% de precio, 12% capital', tp:15, margin:0.12}
  ].forEach(cfg=>{
    console.log('\n--- ' + cfg.label + ' ---');
    const rFull = simulateTradesNoSLConFees(s4H, verdicts4H, cfg.tp, LEVERAGE, cfg.margin, 4);
    const buckets = bucketizeTradesByCalendarYear(rFull.tradeLog, s4H.times);
    const years = Object.keys(buckets).map(Number).sort((a,b)=>a-b);
    console.log(pad('Año',8) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
    years.forEach(year=>{
      const m = metricsForTradeSubset(buckets[year]);
      console.log(pad(String(year),8) + padL(m.trades,9) + padL(m.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(m.totalReturnPct),12) + padL('-'+m.maxDrawdownPct.toFixed(1)+'%',11) + padL(m.profitFactor.toFixed(2),10));
    });
    const aniosPositivos = years.filter(y=>metricsForTradeSubset(buckets[y]).totalReturnPct>0).length;
    console.log('Años con retorno positivo: ' + aniosPositivos + ' de ' + years.length);
  });

  // ---------- ANÁLISIS N: SL ancho como cortafuegos ante movimientos extremos (tipo 2021) ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS N — Stop Loss ANCHO como cortafuegos (no como gestión normal), señal en 4H con comisiones');
  console.log('========================================');
  console.log('El walk-forward mostró que 2021 perdió dinero con un % de acierto NORMAL, pero con');
  console.log('pérdidas individuales enormes (sin SL, el precio se movió mucho en contra antes de que');
  console.log('el veredicto cambiara). Aquí se prueba un SL muy ancho — pensado solo para cortar esos');
  console.log('movimientos extremos, no para intervenir en el día a día — y se mide su efecto tanto en');
  console.log('el conjunto como específicamente en 2021.');

  const anchosSL = [15, 20, 25, 30, 40, 50]; // % de movimiento de PRECIO — muy ancho a propósito
  console.log('\n--- TP 3% de precio, 12% capital (la configuración ganadora) ---');
  console.log(pad('SL ancho',10) + padL('Operac.',9) + padL('Cierres/SL',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  // Referencia sin SL (ya la conocemos, pero se repite aquí para comparar en la misma tabla)
  const rSinSL = simulateTradesNoSLConFees(s4H, verdicts4H, 3, LEVERAGE, 0.12, 4);
  console.log(pad('(sin SL)',10) + padL(rSinSL.trades,9) + padL('—',11) + padL(fmtPct(rSinSL.totalReturnPct),12) + padL('-'+rSinSL.maxDrawdownPct.toFixed(1)+'%',11) + padL(rSinSL.profitFactor.toFixed(2),10));
  anchosSL.forEach(sl=>{
    const r = simulateTradesNoSLConFees(s4H, verdicts4H, 3, LEVERAGE, 0.12, 4, sl);
    console.log(pad('-'+sl+'%',10) + padL(r.trades,9) + padL(r.cierresPorSL,11) + padL(fmtPct(r.totalReturnPct),12) + padL('-'+r.maxDrawdownPct.toFixed(1)+'%',11) + padL(r.profitFactor.toFixed(2),10));
  });

  console.log('\n--- Efecto específico en el año 2021 (el más afectado) ---');
  console.log(pad('SL ancho',10) + padL('Operac.',9) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  [null, 15, 20, 25, 30].forEach(sl=>{
    const r = simulateTradesNoSLConFees(s4H, verdicts4H, 3, LEVERAGE, 0.12, 4, sl);
    const buckets2021 = r.tradeLog.filter(t => new Date(s4H.times[t.entryIdx]).getUTCFullYear() === 2021);
    const m2021 = metricsForTradeSubset(buckets2021);
    console.log(pad(sl==null?'(sin SL)':'-'+sl+'%',10) + padL(m2021.trades,9) + padL(fmtPct(m2021.totalReturnPct),12) + padL('-'+m2021.maxDrawdownPct.toFixed(1)+'%',11) + padL(m2021.profitFactor.toFixed(2),10));
  });

  // ---------- ANÁLISIS O: filtro reforzado (3 velas + ADX>=20 + BBWP>25) vs normal ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS O — Filtro reforzado (ENHANCED_FILTER del bot original) vs señal normal, en 4H con comisiones');
  console.log('========================================');
  console.log('El filtro reforzado exige, SOLO para comprar: AO+ADX confirmando con 3 velas de');
  console.log('continuidad (no 1), ADX >= 20, y BBWP > 25. Las ventas y el cierre forzado por Koncorde');
  console.log('siguen igual que siempre. Objetivo: menos señales, de más calidad, en años revueltos.');

  const verdicts4HEnhanced = buildVerdicts4HEnhanced(s4H, sD);
  const verdicts4HEnhancedBoth = buildVerdicts4HEnhancedBoth(s4H, sD);
  const numSenalesEnhanced = verdicts4HEnhanced.filter(v=>v!=='ESPERAR').length;
  const numSenalesBoth = verdicts4HEnhancedBoth.filter(v=>v!=='ESPERAR').length;
  console.log('\nVelas con señal activa — normal: ' + numSenales4H + ' · reforzada (solo largos): ' + numSenalesEnhanced + ' · reforzada (los dos lados): ' + numSenalesBoth);

  console.log('\n--- Conjunto completo (TP 3% de precio, 12% capital) ---');
  console.log(pad('Variante',20) + padL('Operac.',9) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  const rNormal = simulateTradesNoSLConFees(s4H, verdicts4H, 3, LEVERAGE, 0.12, 4);
  const rEnhanced = simulateTradesNoSLConFees(s4H, verdicts4HEnhanced, 3, LEVERAGE, 0.12, 4);
  const rBoth = simulateTradesNoSLConFees(s4H, verdicts4HEnhancedBoth, 3, LEVERAGE, 0.12, 4);
  console.log(pad('Normal',20) + padL(rNormal.trades,9) + padL(fmtPct(rNormal.totalReturnPct),12) + padL('-'+rNormal.maxDrawdownPct.toFixed(1)+'%',11) + padL(rNormal.profitFactor.toFixed(2),10));
  console.log(pad('Reforzada (largos)',20) + padL(rEnhanced.trades,9) + padL(fmtPct(rEnhanced.totalReturnPct),12) + padL('-'+rEnhanced.maxDrawdownPct.toFixed(1)+'%',11) + padL(rEnhanced.profitFactor.toFixed(2),10));
  console.log(pad('Reforzada (ambos)',20) + padL(rBoth.trades,9) + padL(fmtPct(rBoth.totalReturnPct),12) + padL('-'+rBoth.maxDrawdownPct.toFixed(1)+'%',11) + padL(rBoth.profitFactor.toFixed(2),10));

  console.log('\n--- Año por año, las tres variantes (TP 3%, 12% capital) ---');
  console.log(pad('Año',8) + padL('PF Normal',11) + padL('PF Reforz.Larg',15) + padL('PF Reforz.Ambos',16) + padL('Ret Normal',13) + padL('Ret Ambos',12));
  for(let year=2017; year<=2026; year++){
    const bucketsN = rNormal.tradeLog.filter(t => new Date(s4H.times[t.entryIdx]).getUTCFullYear() === year);
    const bucketsE = rEnhanced.tradeLog.filter(t => new Date(s4H.times[t.entryIdx]).getUTCFullYear() === year);
    const bucketsB = rBoth.tradeLog.filter(t => new Date(s4H.times[t.entryIdx]).getUTCFullYear() === year);
    if(bucketsN.length===0 && bucketsE.length===0 && bucketsB.length===0) continue;
    const mN = metricsForTradeSubset(bucketsN);
    const mE = metricsForTradeSubset(bucketsE);
    const mB = metricsForTradeSubset(bucketsB);
    console.log(pad(String(year),8) + padL(mN.profitFactor.toFixed(2),11) + padL(mE.profitFactor.toFixed(2),15) + padL(mB.profitFactor.toFixed(2),16) + padL(fmtPct(mN.totalReturnPct),13) + padL(fmtPct(mB.totalReturnPct),12));
  }

  // ---------- ANÁLISIS P: nueva salida (AO retroceso + cambio de dirección del ADX) ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS P — Salida alternativa: AO en Retroceso + ADX cambia de dirección (a la vez)');
  console.log('========================================');
  console.log('En vez de cerrar en cuanto CUALQUIERA de las condiciones de entrada falla, esta versión');
  console.log('aguanta mientras solo falle una — y solo cierra cuando el AO muestra Retroceso del');
  console.log('movimiento principal Y el ADX deja de subir A LA VEZ. El TP y el cierre forzado por');
  console.log('Koncorde se mantienen exactamente igual que en la versión validada.');

  console.log('\n--- Comparación directa (TP 3% de precio, 12% capital) ---');
  console.log(pad('Variante',22) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  const rSalidaActual = simulateTradesNoSLConFees(s4H, verdicts4H, 3, LEVERAGE, 0.12, 4);
  const rSalidaNueva = simulateConfluenciaSalidaAoAdx(s4H, sD, 3, LEVERAGE, 0.12, 4);
  console.log(pad('Salida actual',22) + padL(rSalidaActual.trades,9) + padL(rSalidaActual.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(rSalidaActual.totalReturnPct),12) + padL('-'+rSalidaActual.maxDrawdownPct.toFixed(1)+'%',11) + padL(rSalidaActual.profitFactor.toFixed(2),10));
  console.log(pad('Salida AO+ADX',22) + padL(rSalidaNueva.trades,9) + padL(rSalidaNueva.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(rSalidaNueva.totalReturnPct),12) + padL('-'+rSalidaNueva.maxDrawdownPct.toFixed(1)+'%',11) + padL(rSalidaNueva.profitFactor.toFixed(2),10));

  console.log('\n--- Año por año, las dos salidas (TP 3%, 12% capital) ---');
  console.log(pad('Año',8) + padL('PF Actual',11) + padL('PF AO+ADX',11) + padL('Ret Actual',13) + padL('Ret AO+ADX',13));
  for(let year=2017; year<=2026; year++){
    const bucketsA = rSalidaActual.tradeLog.filter(t => new Date(s4H.times[t.entryIdx]).getUTCFullYear() === year);
    const bucketsN = rSalidaNueva.tradeLog.filter(t => new Date(s4H.times[t.entryIdx]).getUTCFullYear() === year);
    if(bucketsA.length===0 && bucketsN.length===0) continue;
    const mA = metricsForTradeSubset(bucketsA);
    const mN = metricsForTradeSubset(bucketsN);
    console.log(pad(String(year),8) + padL(mA.profitFactor.toFixed(2),11) + padL(mN.profitFactor.toFixed(2),11) + padL(fmtPct(mA.totalReturnPct),13) + padL(fmtPct(mN.totalReturnPct),13));
  }

  // ---------- ANÁLISIS Q: qué pasó de verdad dentro de cada operación ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS Q — Análisis detallado del camino de cada operación (TP 3%, 12% capital)');
  console.log('========================================');
  console.log('Para cada operación, se sigue el camino vela a vela de la ganancia flotante (no solo');
  console.log('el resultado final), y para las cerradas por TP, se simula qué habría pasado sin TP.');

  const ops = analizarOperacionesDetallado(s4H, sD, verdicts4H, 3, LEVERAGE, 0.12, 4);
  console.log('\nTotal de operaciones analizadas: ' + ops.length);

  const cerradasPorTP = ops.filter(o=>o.motivo==='TP');
  const noTP = ops.filter(o=>o.motivo!=='TP');

  // 1) ¿Cuántas se podrían haber mejorado sin el TP?
  const mejorables = cerradasPorTP.filter(o=>o.habriaMejorado);
  console.log('\n--- 1) Operaciones cerradas por TP que habrían llegado más lejos sin él ---');
  console.log('De ' + cerradasPorTP.length + ' operaciones cerradas por TP: ' + mejorables.length + ' (' + (mejorables.length/cerradasPorTP.length*100).toFixed(1) + '%) habrían alcanzado un punto mejor si hubiéramos dejado correr la operación.');
  if(mejorables.length){
    const mejoraMediaPct = mejorables.reduce((a,o)=>a+(o.sombraSinTP_mejor-o.finalPct),0)/mejorables.length;
    console.log('Mejora media perdida en esos casos: +' + mejoraMediaPct.toFixed(2) + ' puntos porcentuales de cuenta (respecto al TP ya cobrado).');
  }

  // 2) ¿Cuántas dieron marcha atrás antes de cerrarse (no cortadas a tiempo)?
  const UMBRAL_MARCHA_ATRAS = 1.0; // punto porcentual de cuenta
  const noCortadasATiempo = noTP.filter(o => (o.mejorPct - o.finalPct) >= UMBRAL_MARCHA_ATRAS);
  console.log('\n--- 2) Operaciones (cerradas por veredicto/forzado) que dieron marcha atrás antes de cerrarse ---');
  console.log('De ' + noTP.length + ' operaciones no cerradas por TP: ' + noCortadasATiempo.length + ' (' + (noCortadasATiempo.length/noTP.length*100).toFixed(1) + '%) tuvieron un momento mejor y luego se deterioraron al menos ' + UMBRAL_MARCHA_ATRAS + ' punto antes del cierre final.');
  if(noCortadasATiempo.length){
    const perdidaMedia = noCortadasATiempo.reduce((a,o)=>a+(o.mejorPct-o.finalPct),0)/noCortadasATiempo.length;
    console.log('Marcha atrás media en esos casos: -' + perdidaMedia.toFixed(2) + ' puntos porcentuales de cuenta (desde el mejor momento hasta el cierre).');
  }

  // 3) ¿Cuántas apenas estuvieron en positivo?
  const UMBRAL_APENAS = 0.5; // punto porcentual de cuenta
  const apenasPositivas = ops.filter(o => o.mejorPct > 0 && o.mejorPct <= UMBRAL_APENAS);
  console.log('\n--- 3) Operaciones que apenas llegaron a estar en positivo (mejor momento entre 0% y +' + UMBRAL_APENAS + '%) ---');
  console.log(apenasPositivas.length + ' de ' + ops.length + ' operaciones (' + (apenasPositivas.length/ops.length*100).toFixed(1) + '%) nunca llegaron a desarrollarse de verdad.');

  // 4) ¿Cuántas pasaron la mayor parte de su vida en positivo?
  const mayorParteEnPositivo = ops.filter(o => o.fraccionPositiva > 0.5);
  console.log('\n--- 4) Operaciones que pasaron más de la mitad de su vida (vela a vela) con ganancia flotante ---');
  console.log(mayorParteEnPositivo.length + ' de ' + ops.length + ' operaciones (' + (mayorParteEnPositivo.length/ops.length*100).toFixed(1) + '%).');

  // Resumen cruzado: motivo de cierre x si pasó la mayor parte en positivo
  console.log('\n--- Resumen cruzado: motivo de cierre ---');
  console.log(pad('Motivo',12) + padL('Total',8) + padL('Result.+',10) + padL('Mayor parte +',15));
  ['TP','veredicto','forzado','fin_datos'].forEach(motivo=>{
    const subset = ops.filter(o=>o.motivo===motivo);
    if(!subset.length) return;
    const positivas = subset.filter(o=>o.finalPct>0).length;
    const mayorParte = subset.filter(o=>o.fraccionPositiva>0.5).length;
    console.log(pad(motivo,12) + padL(subset.length,8) + padL(positivas+' ('+(positivas/subset.length*100).toFixed(0)+'%)',10) + padL(mayorParte+' ('+(mayorParte/subset.length*100).toFixed(0)+'%)',15));
  });

  // ---------- ANÁLISIS R: TP parcial (50%) con y sin protección a breakeven ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS R — TP parcial (50%) al 3%, con y sin protección a breakeven, señal en 4H con comisiones');
  console.log('========================================');
  console.log('Al tocar el TP, cierra solo el 50% de la posición y deja correr el resto con las reglas');
  console.log('normales de salida. La versión "con breakeven" además protege el resto cerrándolo si el');
  console.log('precio vuelve al precio de entrada, para que la operación completa nunca acabe en negativo.');

  console.log('\n--- Comparación directa (12% de capital) ---');
  console.log(pad('Variante',24) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  const rBase = simulateTradesNoSLConFees(s4H, verdicts4H, 3, LEVERAGE, 0.12, 4);
  const rParcialSinBE = simulateConfluenciaTPParcial(s4H, sD, 3, LEVERAGE, 0.12, 4, 0.5, false);
  const rParcialConBE = simulateConfluenciaTPParcial(s4H, sD, 3, LEVERAGE, 0.12, 4, 0.5, true);
  console.log(pad('TP completo (actual)',24) + padL(rBase.trades,9) + padL(rBase.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(rBase.totalReturnPct),12) + padL('-'+rBase.maxDrawdownPct.toFixed(1)+'%',11) + padL(rBase.profitFactor.toFixed(2),10));
  console.log(pad('TP parcial 50%, sin BE',24) + padL(rParcialSinBE.trades,9) + padL(rParcialSinBE.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(rParcialSinBE.totalReturnPct),12) + padL('-'+rParcialSinBE.maxDrawdownPct.toFixed(1)+'%',11) + padL(rParcialSinBE.profitFactor.toFixed(2),10));
  console.log(pad('TP parcial 50%, con BE',24) + padL(rParcialConBE.trades,9) + padL(rParcialConBE.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(rParcialConBE.totalReturnPct),12) + padL('-'+rParcialConBE.maxDrawdownPct.toFixed(1)+'%',11) + padL(rParcialConBE.profitFactor.toFixed(2),10));

  console.log('\n--- Barrido de capital, TP parcial CON breakeven ---');
  console.log(pad('% capital usado',18) + padL('Operac.',9) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  [2,4,8,12,20].forEach(marginPct=>{
    const r = simulateConfluenciaTPParcial(s4H, sD, 3, LEVERAGE, marginPct/100, 4, 0.5, true);
    console.log(pad(marginPct+'%',18) + padL(r.trades,9) + padL(fmtPct(r.totalReturnPct),12) + padL('-'+r.maxDrawdownPct.toFixed(1)+'%',11) + padL(r.profitFactor.toFixed(2),10));
  });

  console.log('\n--- Año por año: las tres variantes (12% capital) ---');
  console.log(pad('Año',8) + padL('PF Actual',11) + padL('PF Sin BE',11) + padL('PF Con BE',11) + padL('Ret Actual',13) + padL('Ret Con BE',13));
  for(let year=2017; year<=2026; year++){
    const bA = rBase.tradeLog.filter(t => new Date(s4H.times[t.entryIdx]).getUTCFullYear() === year);
    const bS = rParcialSinBE.tradeLog.filter(t => new Date(s4H.times[t.entryIdx]).getUTCFullYear() === year);
    const bC = rParcialConBE.tradeLog.filter(t => new Date(s4H.times[t.entryIdx]).getUTCFullYear() === year);
    if(bA.length===0 && bS.length===0 && bC.length===0) continue;
    const mA = metricsForTradeSubset(bA), mS = metricsForTradeSubset(bS), mC = metricsForTradeSubset(bC);
    console.log(pad(String(year),8) + padL(mA.profitFactor.toFixed(2),11) + padL(mS.profitFactor.toFixed(2),11) + padL(mC.profitFactor.toFixed(2),11) + padL(fmtPct(mA.totalReturnPct),13) + padL(fmtPct(mC.totalReturnPct),13));
  }

  // ---------- ANÁLISIS S: TP parcial — validación fuera de muestra + walk-forward ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS S — TP parcial (50%, con breakeven): validación fuera de muestra + walk-forward');
  console.log('========================================');
  console.log('Misma configuración ganadora del Análisis R (TP parcial 50%, con breakeven, 12% capital),');
  console.log('sometida a las mismas dos pruebas que ya aplicamos a la versión de TP completo.');

  console.log('\n--- Validación fuera de muestra: últimos ' + MESES_RESERVADOS + ' meses reservados ---');
  const cutoffReservadoParcial = ohlcv4H.times[ohlcv4H.times.length-1] - MESES_RESERVADOS*30*86400000;
  const tradesAntesParcial = rParcialConBE.tradeLog.filter(t => s4H.times[t.entryIdx] < cutoffReservadoParcial);
  const tradesReservadoParcial = rParcialConBE.tradeLog.filter(t => s4H.times[t.entryIdx] >= cutoffReservadoParcial);
  const mAntesParcial = metricsForTradeSubset(tradesAntesParcial);
  const mReservadoParcial = metricsForTradeSubset(tradesReservadoParcial);
  console.log(pad('Tramo',20) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  console.log(pad('Resto del histórico',20) + padL(mAntesParcial.trades,9) + padL(mAntesParcial.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(mAntesParcial.totalReturnPct),12) + padL('-'+mAntesParcial.maxDrawdownPct.toFixed(1)+'%',11) + padL(mAntesParcial.profitFactor.toFixed(2),10));
  console.log(pad('TRAMO RESERVADO',20) + padL(mReservadoParcial.trades,9) + padL(mReservadoParcial.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(mReservadoParcial.totalReturnPct),12) + padL('-'+mReservadoParcial.maxDrawdownPct.toFixed(1)+'%',11) + padL(mReservadoParcial.profitFactor.toFixed(2),10));

  console.log('\n--- Walk-forward año por año ---');
  console.log(pad('Año',8) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  const bucketsParcial = {};
  rParcialConBE.tradeLog.forEach(t=>{
    const year = new Date(s4H.times[t.entryIdx]).getUTCFullYear();
    if(!bucketsParcial[year]) bucketsParcial[year] = [];
    bucketsParcial[year].push(t);
  });
  let aniosPositivosParcial = 0, aniosTotalParcial = 0;
  Object.keys(bucketsParcial).map(Number).sort((a,b)=>a-b).forEach(year=>{
    const m = metricsForTradeSubset(bucketsParcial[year]);
    console.log(pad(String(year),8) + padL(m.trades,9) + padL(m.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(m.totalReturnPct),12) + padL('-'+m.maxDrawdownPct.toFixed(1)+'%',11) + padL(m.profitFactor.toFixed(2),10));
    aniosTotalParcial++;
    if(m.totalReturnPct>0) aniosPositivosParcial++;
  });
  console.log('Años con retorno positivo: ' + aniosPositivosParcial + ' de ' + aniosTotalParcial);

  // ---------- ANÁLISIS T: TP parcial SIN breakeven — validación fuera de muestra + walk-forward ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS T — TP parcial (50%, SIN breakeven): validación fuera de muestra + walk-forward');
  console.log('========================================');
  console.log('Misma prueba que el Análisis S, pero para la variante SIN protección a breakeven —');
  console.log('para comparar directamente si la protección compensa o solo recorta ganancias.');

  console.log('\n--- Validación fuera de muestra: últimos ' + MESES_RESERVADOS + ' meses reservados ---');
  const cutoffReservadoSinBE = ohlcv4H.times[ohlcv4H.times.length-1] - MESES_RESERVADOS*30*86400000;
  const tradesAntesSinBE = rParcialSinBE.tradeLog.filter(t => s4H.times[t.entryIdx] < cutoffReservadoSinBE);
  const tradesReservadoSinBE = rParcialSinBE.tradeLog.filter(t => s4H.times[t.entryIdx] >= cutoffReservadoSinBE);
  const mAntesSinBE = metricsForTradeSubset(tradesAntesSinBE);
  const mReservadoSinBE = metricsForTradeSubset(tradesReservadoSinBE);
  console.log(pad('Tramo',20) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  console.log(pad('Resto del histórico',20) + padL(mAntesSinBE.trades,9) + padL(mAntesSinBE.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(mAntesSinBE.totalReturnPct),12) + padL('-'+mAntesSinBE.maxDrawdownPct.toFixed(1)+'%',11) + padL(mAntesSinBE.profitFactor.toFixed(2),10));
  console.log(pad('TRAMO RESERVADO',20) + padL(mReservadoSinBE.trades,9) + padL(mReservadoSinBE.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(mReservadoSinBE.totalReturnPct),12) + padL('-'+mReservadoSinBE.maxDrawdownPct.toFixed(1)+'%',11) + padL(mReservadoSinBE.profitFactor.toFixed(2),10));

  console.log('\n--- Walk-forward año por año (comparado con la versión CON breakeven) ---');
  console.log(pad('Año',8) + padL('Ret SinBE',12) + padL('PF SinBE',10) + padL('DD SinBE',10) + padL('Ret ConBE',12) + padL('PF ConBE',10));
  const bucketsSinBE = {};
  rParcialSinBE.tradeLog.forEach(t=>{
    const year = new Date(s4H.times[t.entryIdx]).getUTCFullYear();
    if(!bucketsSinBE[year]) bucketsSinBE[year] = [];
    bucketsSinBE[year].push(t);
  });
  let aniosPositivosSinBE = 0, aniosTotalSinBE = 0;
  Object.keys(bucketsSinBE).map(Number).sort((a,b)=>a-b).forEach(year=>{
    const mSin = metricsForTradeSubset(bucketsSinBE[year]);
    const mCon = metricsForTradeSubset(bucketsParcial[year] || []);
    console.log(pad(String(year),8) + padL(fmtPct(mSin.totalReturnPct),12) + padL(mSin.profitFactor.toFixed(2),10) + padL('-'+mSin.maxDrawdownPct.toFixed(1)+'%',10) + padL(fmtPct(mCon.totalReturnPct),12) + padL(mCon.profitFactor.toFixed(2),10));
    aniosTotalSinBE++;
    if(mSin.totalReturnPct>0) aniosPositivosSinBE++;
  });
  console.log('Años con retorno positivo (sin BE): ' + aniosPositivosSinBE + ' de ' + aniosTotalSinBE);

  // ---------- ANÁLISIS U: ganadoras/perdedoras por motivo de cierre (configuración final) ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS U — Ganadoras/perdedoras por motivo de cierre (TP parcial 50%, SIN breakeven, 12% capital)');
  console.log('========================================');
  console.log('"Con TP" = la operación llegó a tocar el Take Profit parcial en algún momento (aunque el');
  console.log('resto cerrara después por veredicto). "Sin TP" = se cerró entera por veredicto/forzado, sin');
  console.log('llegar nunca al TP.');

  function resumenGrupo(trades){
    const ganadoras = trades.filter(t=>t.equityChangePct>0);
    const perdedoras = trades.filter(t=>t.equityChangePct<=0);
    const mediaGan = ganadoras.length ? ganadoras.reduce((a,t)=>a+t.equityChangePct,0)/ganadoras.length : 0;
    const mediaPer = perdedoras.length ? perdedoras.reduce((a,t)=>a+t.equityChangePct,0)/perdedoras.length : 0;
    return { total: trades.length, ganadoras: ganadoras.length, perdedoras: perdedoras.length, mediaGan, mediaPer };
  }

  [
    {label: SYMBOL, r: rParcialSinBE},
  ].forEach(({label, r})=>{
    const conTP = r.tradeLog.filter(t=>t.tocoTP);
    const sinTP = r.tradeLog.filter(t=>!t.tocoTP);
    const rConTP = resumenGrupo(conTP);
    const rSinTP = resumenGrupo(sinTP);
    console.log('\n--- ' + label + ' — Total operaciones: ' + r.tradeLog.length + ' ---');
    console.log(pad('Grupo',20) + padL('Total',8) + padL('Ganadoras',11) + padL('% media +',12) + padL('Perdedoras',12) + padL('% media -',12));
    console.log(pad('Con TP',20) + padL(rConTP.total,8) + padL(rConTP.ganadoras,11) + padL(fmtPct(rConTP.mediaGan),12) + padL(rConTP.perdedoras,12) + padL(fmtPct(rConTP.mediaPer),12));
    console.log(pad('Sin TP (veredicto)',20) + padL(rSinTP.total,8) + padL(rSinTP.ganadoras,11) + padL(fmtPct(rSinTP.mediaGan),12) + padL(rSinTP.perdedoras,12) + padL(fmtPct(rSinTP.mediaPer),12));
  });

  // ---------- ANÁLISIS V: sin apalancamiento (1x) vs 5x, mismo 12% de capital ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS V — TP parcial SIN apalancamiento (1x) vs con 5x, mismo 12% de capital');
  console.log('========================================');
  console.log('Predicción antes de ver el resultado: el Profit Factor debería mantenerse muy similar');
  console.log('(el apalancamiento se cancela matemáticamente en la proporción comisión/beneficio), pero');
  console.log('el retorno total y el drawdown deberían reducirse aproximadamente 5 veces.');

  const rSinApalancamiento = simulateConfluenciaTPParcial(s4H, sD, 3, 1, 0.12, 4, 0.5, false);

  console.log('\n--- Comparación directa (12% de capital en los dos casos) ---');
  console.log(pad('Variante',18) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  console.log(pad('Con 5x (actual)',18) + padL(rParcialSinBE.trades,9) + padL(rParcialSinBE.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(rParcialSinBE.totalReturnPct),12) + padL('-'+rParcialSinBE.maxDrawdownPct.toFixed(1)+'%',11) + padL(rParcialSinBE.profitFactor.toFixed(2),10));
  console.log(pad('Sin apalanc. (1x)',18) + padL(rSinApalancamiento.trades,9) + padL(rSinApalancamiento.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(rSinApalancamiento.totalReturnPct),12) + padL('-'+rSinApalancamiento.maxDrawdownPct.toFixed(1)+'%',11) + padL(rSinApalancamiento.profitFactor.toFixed(2),10));

  console.log('\n--- Walk-forward año por año, sin apalancamiento (1x, 12% capital) ---');
  console.log(pad('Año',8) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  const bucketsSinApalancamiento = {};
  rSinApalancamiento.tradeLog.forEach(t=>{
    const year = new Date(s4H.times[t.entryIdx]).getUTCFullYear();
    if(!bucketsSinApalancamiento[year]) bucketsSinApalancamiento[year] = [];
    bucketsSinApalancamiento[year].push(t);
  });
  let aniosPositivosSinApalancamiento = 0, aniosTotalSinApalancamiento = 0;
  Object.keys(bucketsSinApalancamiento).map(Number).sort((a,b)=>a-b).forEach(year=>{
    const m = metricsForTradeSubset(bucketsSinApalancamiento[year]);
    console.log(pad(String(year),8) + padL(m.trades,9) + padL(m.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(m.totalReturnPct),12) + padL('-'+m.maxDrawdownPct.toFixed(1)+'%',11) + padL(m.profitFactor.toFixed(2),10));
    aniosTotalSinApalancamiento++;
    if(m.totalReturnPct>0) aniosPositivosSinApalancamiento++;
  });
  console.log('Años con retorno positivo: ' + aniosPositivosSinApalancamiento + ' de ' + aniosTotalSinApalancamiento);

  // ---------- ANÁLISIS W: barrido del reparto del TP parcial, sin apalancamiento ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS W — Barrido del reparto del TP parcial: 1x vs 5x, mismo 12% de capital');
  console.log('========================================');
  console.log('¿Es el mismo reparto óptimo con o sin apalancamiento? El apalancamiento amplifica');
  console.log('igual de fuerte el tramo sin proteger hacia arriba que hacia abajo, así que no puede');
  console.log('darse por hecho que el mejor punto se mantenga igual.');

  console.log('\n--- Con 1x (sin apalancamiento) ---');
  console.log(pad('% cerrado en TP',18) + padL('Operac.',9) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10) + padL('Ret/DD',9));
  [0.05, 0.10, 0.15, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80].forEach(fraccion=>{
    const r = simulateConfluenciaTPParcial(s4H, sD, 3, 1, 0.12, 4, fraccion, false);
    const retDD = r.maxDrawdownPct>0 ? (r.totalReturnPct/r.maxDrawdownPct) : (r.totalReturnPct>0?Infinity:0);
    console.log(pad((fraccion*100)+'%',18) + padL(r.trades,9) + padL(fmtPct(r.totalReturnPct),12) + padL('-'+r.maxDrawdownPct.toFixed(1)+'%',11) + padL(r.profitFactor.toFixed(2),10) + padL(retDD.toFixed(2),9));
  });

  console.log('\n--- Con 5x (el apalancamiento real del bot) ---');
  console.log(pad('% cerrado en TP',18) + padL('Operac.',9) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10) + padL('Ret/DD',9));
  [0.05, 0.10, 0.15, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80].forEach(fraccion=>{
    const r = simulateConfluenciaTPParcial(s4H, sD, 3, 5, 0.12, 4, fraccion, false);
    const retDD = r.maxDrawdownPct>0 ? (r.totalReturnPct/r.maxDrawdownPct) : (r.totalReturnPct>0?Infinity:0);
    console.log(pad((fraccion*100)+'%',18) + padL(r.trades,9) + padL(fmtPct(r.totalReturnPct),12) + padL('-'+r.maxDrawdownPct.toFixed(1)+'%',11) + padL(r.profitFactor.toFixed(2),10) + padL(retDD.toFixed(2),9));
  });


  // ---------- ANÁLISIS X: TP parcial 20% (con 5x): validación fuera de muestra + walk-forward ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS X — TP parcial 20% (con 5x, sin breakeven): validación fuera de muestra + walk-forward');
  console.log('========================================');
  console.log('Misma prueba que el Análisis S/T, pero para el nuevo reparto 20/80 encontrado en el');
  console.log('Análisis W como el mejor punto de drawdown con el apalancamiento real (5x).');

  const rParcial20 = simulateConfluenciaTPParcial(s4H, sD, 3, LEVERAGE, 0.12, 4, 0.20, false);

  console.log('\n--- Comparación directa con el 50/50 actual (12% capital, 5x) ---');
  console.log(pad('Variante',18) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  console.log(pad('20/80 (nuevo)',18) + padL(rParcial20.trades,9) + padL(rParcial20.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(rParcial20.totalReturnPct),12) + padL('-'+rParcial20.maxDrawdownPct.toFixed(1)+'%',11) + padL(rParcial20.profitFactor.toFixed(2),10));
  console.log(pad('50/50 (actual)',18) + padL(rParcialSinBE.trades,9) + padL(rParcialSinBE.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(rParcialSinBE.totalReturnPct),12) + padL('-'+rParcialSinBE.maxDrawdownPct.toFixed(1)+'%',11) + padL(rParcialSinBE.profitFactor.toFixed(2),10));

  console.log('\n--- Validación fuera de muestra: últimos ' + MESES_RESERVADOS + ' meses reservados ---');
  const cutoffReservado20 = ohlcv4H.times[ohlcv4H.times.length-1] - MESES_RESERVADOS*30*86400000;
  const tradesAntes20 = rParcial20.tradeLog.filter(t => s4H.times[t.entryIdx] < cutoffReservado20);
  const tradesReservado20 = rParcial20.tradeLog.filter(t => s4H.times[t.entryIdx] >= cutoffReservado20);
  const mAntes20 = metricsForTradeSubset(tradesAntes20);
  const mReservado20 = metricsForTradeSubset(tradesReservado20);
  console.log(pad('Tramo',20) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  console.log(pad('Resto del histórico',20) + padL(mAntes20.trades,9) + padL(mAntes20.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(mAntes20.totalReturnPct),12) + padL('-'+mAntes20.maxDrawdownPct.toFixed(1)+'%',11) + padL(mAntes20.profitFactor.toFixed(2),10));
  console.log(pad('TRAMO RESERVADO',20) + padL(mReservado20.trades,9) + padL(mReservado20.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(mReservado20.totalReturnPct),12) + padL('-'+mReservado20.maxDrawdownPct.toFixed(1)+'%',11) + padL(mReservado20.profitFactor.toFixed(2),10));

  console.log('\n--- Walk-forward año por año ---');
  console.log(pad('Año',8) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  const buckets20 = {};
  rParcial20.tradeLog.forEach(t=>{
    const year = new Date(s4H.times[t.entryIdx]).getUTCFullYear();
    if(!buckets20[year]) buckets20[year] = [];
    buckets20[year].push(t);
  });
  let aniosPositivos20 = 0, aniosTotal20 = 0;
  Object.keys(buckets20).map(Number).sort((a,b)=>a-b).forEach(year=>{
    const m = metricsForTradeSubset(buckets20[year]);
    console.log(pad(String(year),8) + padL(m.trades,9) + padL(m.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(m.totalReturnPct),12) + padL('-'+m.maxDrawdownPct.toFixed(1)+'%',11) + padL(m.profitFactor.toFixed(2),10));
    aniosTotal20++;
    if(m.totalReturnPct>0) aniosPositivos20++;
  });
  console.log('Años con retorno positivo: ' + aniosPositivos20 + ' de ' + aniosTotal20);

  // ---------- ANÁLISIS Y: ¿hay zonas donde habría sido mejor no operar? ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS Y — Diagnóstico: ¿la falta de volatilidad o los cambios bruscos del AO predicen malas operaciones?');
  console.log('========================================');
  console.log('Para cada operación de la configuración 20/80 (5x, 12% capital), se mira el BBWP');
  console.log('(volatilidad comprimida = valor bajo) y el número de cambios de estado del AO en las');
  console.log('últimas 12 velas (48h) justo antes de entrar — y se agrupan las operaciones por esos');
  console.log('valores para ver si hay un patrón con el resultado.');

  const rDiagnostico = simulateConfluenciaTPParcial(s4H, sD, 3, LEVERAGE, 0.12, 4, 0.20, false);
  const operacionesConContexto = rDiagnostico.tradeLog.map(t=>({
    ...t,
    bbwpEntrada: s4H.bbwp[t.entryIdx],
    cambiosAO: contarCambiosAO(s4H, t.entryIdx, 12)
  })).filter(t=>!isNaN(t.bbwpEntrada));

  console.log('\n--- Por BBWP en el momento de entrar (cuartiles: volatilidad comprimida → expandida) ---');
  const bbwpOrdenado = [...operacionesConContexto].sort((a,b)=>a.bbwpEntrada-b.bbwpEntrada);
  const tamCuartil = Math.floor(bbwpOrdenado.length/4);
  console.log(pad('Cuartil BBWP',16) + padL('Rango',16) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno medio',15) + padL('P.Factor',10));
  for(let q=0;q<4;q++){
    const desde = q*tamCuartil, hasta = (q===3) ? bbwpOrdenado.length : (q+1)*tamCuartil;
    const grupo = bbwpOrdenado.slice(desde,hasta);
    if(!grupo.length) continue;
    const m = metricsForTradeSubset(grupo);
    const mediaEquity = grupo.reduce((a,t)=>a+t.equityChangePct,0)/grupo.length;
    const rango = grupo[0].bbwpEntrada.toFixed(0) + '-' + grupo[grupo.length-1].bbwpEntrada.toFixed(0);
    console.log(pad('Q'+(q+1),16) + padL(rango,16) + padL(grupo.length,9) + padL(m.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(mediaEquity),15) + padL(m.profitFactor.toFixed(2),10));
  }

  console.log('\n--- Por número de cambios de estado del AO en las 12 velas previas (0 = muy estable, más = más errático) ---');
  const gruposCambios = {'0-1':[], '2-3':[], '4-5':[], '6+':[]};
  operacionesConContexto.forEach(t=>{
    if(t.cambiosAO<=1) gruposCambios['0-1'].push(t);
    else if(t.cambiosAO<=3) gruposCambios['2-3'].push(t);
    else if(t.cambiosAO<=5) gruposCambios['4-5'].push(t);
    else gruposCambios['6+'].push(t);
  });
  console.log(pad('Cambios AO',16) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno medio',15) + padL('P.Factor',10));
  Object.keys(gruposCambios).forEach(key=>{
    const grupo = gruposCambios[key];
    if(!grupo.length) return;
    const m = metricsForTradeSubset(grupo);
    const mediaEquity = grupo.reduce((a,t)=>a+t.equityChangePct,0)/grupo.length;
    console.log(pad(key,16) + padL(grupo.length,9) + padL(m.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(mediaEquity),15) + padL(m.profitFactor.toFixed(2),10));
  });

  // ---------- ANÁLISIS Z: BBWP y cambios de AO por año — ¿2021/2023 se ven distintos? ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS Z — BBWP y cambios de AO medios por año calendario (¿2021/2023 destacan?)');
  console.log('========================================');
  console.log('Mismas dos métricas del Análisis Y, pero agrupadas por año en vez de mezcladas —');
  console.log('para ver si los años malos (2021, 2023) tienen un perfil de BBWP/cambios de AO');
  console.log('distinto al de los años buenos.');

  const gruposPorAnio = {};
  operacionesConContexto.forEach(t=>{
    const year = new Date(s4H.times[t.entryIdx]).getUTCFullYear();
    if(!gruposPorAnio[year]) gruposPorAnio[year] = [];
    gruposPorAnio[year].push(t);
  });

  console.log('\n' + pad('Año',8) + padL('Operac.',9) + padL('BBWP medio',12) + padL('Cambios AO medio',18) + padL('Retorno año',13) + padL('P.Factor año',13));
  Object.keys(gruposPorAnio).map(Number).sort((a,b)=>a-b).forEach(year=>{
    const grupo = gruposPorAnio[year];
    const bbwpMedio = grupo.reduce((a,t)=>a+t.bbwpEntrada,0)/grupo.length;
    const cambiosMedio = grupo.reduce((a,t)=>a+t.cambiosAO,0)/grupo.length;
    const m = metricsForTradeSubset(grupo);
    console.log(pad(String(year),8) + padL(grupo.length,9) + padL(bbwpMedio.toFixed(1),12) + padL(cambiosMedio.toFixed(2),18) + padL(fmtPct(m.totalReturnPct),13) + padL(m.profitFactor.toFixed(2),13));
  });

  // ---------- ANÁLISIS AA: Fase 1 — cribado de temporalidades más pequeñas ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS AA — Fase 1: cribado rápido de temporalidades más pequeñas (TP parcial 20%, 5x, 12% capital)');
  console.log('========================================');
  console.log('Solo se mira si sobreviven a las comisiones reales y cuántas operaciones generan —');
  console.log('antes de invertir tiempo en optimizar o validar a fondo ninguna. Para 30M y 15M se usa');
  console.log('una ventana más corta (12 meses) solo para este cribado inicial, no los ' + MESES_HISTORICO + ' meses completos.');

  console.log('\n--- 1H confirmado por 4H (reutilizando los datos ya descargados) ---');
  const r1H4H = simulateConfluenciaTPParcial(s, s4H, 3, LEVERAGE, 0.12, 1, 0.20, false);
  console.log('Operaciones: ' + r1H4H.trades + ' · Retorno: ' + fmtPct(r1H4H.totalReturnPct) + ' · Drawdown: -' + r1H4H.maxDrawdownPct.toFixed(1) + '% · P.Factor: ' + r1H4H.profitFactor.toFixed(2));

  const MESES_CRIBADO = 12;
  console.log('\nDescargando velas de 30M y 15M (solo últimos ' + MESES_CRIBADO + ' meses, para el cribado)...');
  const ohlcv30M = await fetchCandlesForMonths('30m', MESES_CRIBADO, 300);
  const ohlcv15M = await fetchCandlesForMonths('15m', MESES_CRIBADO, 300);
  const s30M = computeFullSeries(ohlcv30M);
  const s15M = computeFullSeries(ohlcv15M);
  console.log('Velas 30M: ' + s30M.n + ' · Velas 15M: ' + s15M.n);

  console.log('\n--- 30M confirmado por 4H (últimos ' + MESES_CRIBADO + ' meses) ---');
  const r30M4H = simulateConfluenciaTPParcial(s30M, s4H, 3, LEVERAGE, 0.12, 0.5, 0.20, false);
  console.log('Operaciones: ' + r30M4H.trades + ' · Retorno: ' + fmtPct(r30M4H.totalReturnPct) + ' · Drawdown: -' + r30M4H.maxDrawdownPct.toFixed(1) + '% · P.Factor: ' + r30M4H.profitFactor.toFixed(2));

  console.log('\n--- 15M confirmado por 1H (últimos ' + MESES_CRIBADO + ' meses) ---');
  const r15M1H = simulateConfluenciaTPParcial(s15M, s, 3, LEVERAGE, 0.12, 0.25, 0.20, false);
  console.log('Operaciones: ' + r15M1H.trades + ' · Retorno: ' + fmtPct(r15M1H.totalReturnPct) + ' · Drawdown: -' + r15M1H.maxDrawdownPct.toFixed(1) + '% · P.Factor: ' + r15M1H.profitFactor.toFixed(2));

  console.log('\n--- Resumen comparativo ---');
  console.log(pad('Combinación',22) + padL('Operac.',9) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  console.log(pad('1H / confirma 4H',22) + padL(r1H4H.trades,9) + padL(fmtPct(r1H4H.totalReturnPct),12) + padL('-'+r1H4H.maxDrawdownPct.toFixed(1)+'%',11) + padL(r1H4H.profitFactor.toFixed(2),10));
  console.log(pad('30M / confirma 4H',22) + padL(r30M4H.trades,9) + padL(fmtPct(r30M4H.totalReturnPct),12) + padL('-'+r30M4H.maxDrawdownPct.toFixed(1)+'%',11) + padL(r30M4H.profitFactor.toFixed(2),10));
  console.log(pad('15M / confirma 1H',22) + padL(r15M1H.trades,9) + padL(fmtPct(r15M1H.totalReturnPct),12) + padL('-'+r15M1H.maxDrawdownPct.toFixed(1)+'%',11) + padL(r15M1H.profitFactor.toFixed(2),10));

  // ---------- ANÁLISIS AB: ¿qué indicador avisa primero, y cuál es más fiable? ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS AB — ¿Qué indicador (AO/ADX/Koncorde) avisa primero, y cuál es más fiable como disparador?');
  console.log('========================================');
  console.log('Para cada entrada de la configuración 20/80 validada, se mide cuántas velas seguidas');
  console.log('llevaba ya cumplida cada condición por separado. La que lleva MÁS velas avisó primero');
  console.log('(esperaba a las demás); la que lleva MENOS (normalmente 1) es la que "dispara" la entrada');
  console.log('en ese momento exacto — la última pieza en encajar.');

  const rParaOrden = simulateConfluenciaTPParcial(s4H, sD, 3, LEVERAGE, 0.12, 4, 0.20, false);
  const idxDParaOrden = alignDailyIndex(sD, s4H.times);

  const analisisOrden = rParaOrden.tradeLog.map(t=>{
    const i = t.entryIdx;
    // Reconstruir la dirección a partir del propio veredicto en ese momento
    const direccion = (s4H.aoState[i]==='Alcista' && s4H.koBull[i]) ? 'long' : 'short';
    const condAO  = (k) => direccion==='long' ? s4H.aoState[k]==='Alcista' : s4H.aoState[k]==='Bajista';
    const condADX = (k) => s4H.adxSubiendo[k];
    const condKON = (k) => direccion==='long' ? (s4H.konVal[k]>s4H.maTrend[k]) : (s4H.konVal[k]<s4H.maTrend[k]);
    return {
      equityChangePct: t.equityChangePct,
      velasAO: velasLlevaCumplida(condAO, i),
      velasADX: velasLlevaCumplida(condADX, i),
      velasKON: velasLlevaCumplida(condKON, i)
    };
  });

  console.log('\n--- ¿Cuál avisa primero en promedio? (más velas ya cumplida = avisa antes) ---');
  const mediaAO = analisisOrden.reduce((a,t)=>a+t.velasAO,0)/analisisOrden.length;
  const mediaADX = analisisOrden.reduce((a,t)=>a+t.velasADX,0)/analisisOrden.length;
  const mediaKON = analisisOrden.reduce((a,t)=>a+t.velasKON,0)/analisisOrden.length;
  console.log('AO:       ' + mediaAO.toFixed(2) + ' velas de media ya cumplida antes de la entrada');
  console.log('ADX:      ' + mediaADX.toFixed(2) + ' velas de media ya cumplida antes de la entrada');
  console.log('Koncorde: ' + mediaKON.toFixed(2) + ' velas de media ya cumplida antes de la entrada');

  console.log('\n--- ¿Cuál "dispara" la entrada más veces (la última en llegar, valor=1)? ---');
  let disparaAO=0, disparaADX=0, disparaKON=0, empate=0;
  const gruposDisparador = {AO:[], ADX:[], Koncorde:[]};
  analisisOrden.forEach(t=>{
    const minimo = Math.min(t.velasAO, t.velasADX, t.velasKON);
    const disparadores = [];
    if(t.velasAO===minimo) disparadores.push('AO');
    if(t.velasADX===minimo) disparadores.push('ADX');
    if(t.velasKON===minimo) disparadores.push('Koncorde');
    if(disparadores.length===1){
      if(disparadores[0]==='AO') disparaAO++;
      if(disparadores[0]==='ADX') disparaADX++;
      if(disparadores[0]==='Koncorde') disparaKON++;
      gruposDisparador[disparadores[0]].push(t);
    } else empate++;
  });
  console.log('AO dispara la entrada en ' + disparaAO + ' operaciones (' + (disparaAO/analisisOrden.length*100).toFixed(1) + '%)');
  console.log('ADX dispara la entrada en ' + disparaADX + ' operaciones (' + (disparaADX/analisisOrden.length*100).toFixed(1) + '%)');
  console.log('Koncorde dispara la entrada en ' + disparaKON + ' operaciones (' + (disparaKON/analisisOrden.length*100).toFixed(1) + '%)');
  console.log('Empates (varios a la vez): ' + empate + ' operaciones');

  console.log('\n--- ¿Es más fiable la operación según cuál fue el disparador? ---');
  console.log(pad('Disparador',12) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno medio',15));
  Object.keys(gruposDisparador).forEach(nombre=>{
    const grupo = gruposDisparador[nombre];
    if(!grupo.length) return;
    const ganadoras = grupo.filter(t=>t.equityChangePct>0).length;
    const media = grupo.reduce((a,t)=>a+t.equityChangePct,0)/grupo.length;
    console.log(pad(nombre,12) + padL(grupo.length,9) + padL((ganadoras/grupo.length*100).toFixed(1)+'%',11) + padL(fmtPct(media),15));
  });

  // ---------- ANÁLISIS AC: ¿qué indicadores coinciden con entradas/salidas cuando BBWP sube por encima del 50%? ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS AC — Coincidencia de ML RSI (4H) y LaRSI con entradas/salidas, solo cuando BBWP≥45 y en subida');
  console.log('========================================');
  console.log('Condición de filtro: BBWP en el momento de la entrada/salida por encima de 45 (cubre "ya pasó de 50"');
  console.log('y "a punto de llegar") Y estrictamente más alto que 3 velas atrás (confirma que está en subida, no bajando).');
  console.log('Nota: Trend Speed Analyzer no se incluye — requiere migrar su motor desde el archivo aparte donde vive,');
  console.log('y ya se descartó como indicador no viable en su momento; se puede añadir en una pasada aparte si interesa.');

  console.log('\nCalculando ML RSI también en 4H (puede tardar un poco menos que en 1H, hay menos velas)...');
  const t0AC = Date.now();
  const mlSignal4H = computeMLRSISeries(s4H.closes);
  console.log('ML RSI en 4H calculado en ' + ((Date.now()-t0AC)/1000).toFixed(1) + 's');

  const operacionesDetalle = analizarOperacionesDetallado(s4H, sD, verdicts4H, 3, LEVERAGE, 0.12, 4);
  console.log('\nTotal de operaciones (entrada+salida) analizadas: ' + operacionesDetalle.length);

  console.log('\n--- EN LAS ENTRADAS ---');
  const entradasConBBWP = operacionesDetalle.filter(op => bbwpAscendiendoYAlto(s4H, op.entryIdx, 45, 3));
  console.log('De ' + operacionesDetalle.length + ' entradas, ' + entradasConBBWP.length + ' cumplen la condición de BBWP (' + (entradasConBBWP.length/operacionesDetalle.length*100).toFixed(1) + '%)');
  if(entradasConBBWP.length){
    let mlOk=0, larsiLadoOk=0, larsiCruceOk=0;
    entradasConBBWP.forEach(op=>{
      const i = op.entryIdx;
      if(op.direction==='long' ? mlSignal4H[i]==='Alcista' : mlSignal4H[i]==='Bajista') mlOk++;
      if(!isNaN(s4H.larsi[i]) && (op.direction==='long' ? s4H.larsi[i]>0.5 : s4H.larsi[i]<0.5)) larsiLadoOk++;
      if(op.direction==='long' ? s4H.larsiState[i]==='compra' : s4H.larsiState[i]==='venta') larsiCruceOk++;
    });
    console.log('  ML RSI (4H) coincide en dirección: ' + mlOk + '/' + entradasConBBWP.length + ' (' + (mlOk/entradasConBBWP.length*100).toFixed(1) + '%)');
    console.log('  LaRSI del lado correcto (>50 largo / <50 corto): ' + larsiLadoOk + '/' + entradasConBBWP.length + ' (' + (larsiLadoOk/entradasConBBWP.length*100).toFixed(1) + '%)');
    console.log('  LaRSI con cruce exacto esa misma vela: ' + larsiCruceOk + '/' + entradasConBBWP.length + ' (' + (larsiCruceOk/entradasConBBWP.length*100).toFixed(1) + '%)');
  }

  console.log('\n--- EN LAS SALIDAS (solo por cambio de veredicto o cierre forzado, no por TP) ---');
  const salidasReales = operacionesDetalle.filter(op => op.motivo==='veredicto' || op.motivo==='forzado');
  const salidasConBBWP = salidasReales.filter(op => bbwpAscendiendoYAlto(s4H, op.exitIdx, 45, 3));
  console.log('De ' + salidasReales.length + ' salidas reales, ' + salidasConBBWP.length + ' cumplen la condición de BBWP (' + (salidasConBBWP.length/salidasReales.length*100).toFixed(1) + '%)');
  if(salidasConBBWP.length){
    let mlOk=0, larsiLadoOk=0, larsiCruceOk=0;
    salidasConBBWP.forEach(op=>{
      const i = op.exitIdx;
      // En una salida, el indicador "coincide" si apunta en la dirección CONTRARIA
      // a la posición que se está cerrando (el giro que motivó la salida).
      if(op.direction==='long' ? mlSignal4H[i]==='Bajista' : mlSignal4H[i]==='Alcista') mlOk++;
      if(!isNaN(s4H.larsi[i]) && (op.direction==='long' ? s4H.larsi[i]<0.5 : s4H.larsi[i]>0.5)) larsiLadoOk++;
      if(op.direction==='long' ? s4H.larsiState[i]==='venta' : s4H.larsiState[i]==='compra') larsiCruceOk++;
    });
    console.log('  ML RSI (4H) coincide con el giro: ' + mlOk + '/' + salidasConBBWP.length + ' (' + (mlOk/salidasConBBWP.length*100).toFixed(1) + '%)');
    console.log('  LaRSI del lado del giro (>50/<50): ' + larsiLadoOk + '/' + salidasConBBWP.length + ' (' + (larsiLadoOk/salidasConBBWP.length*100).toFixed(1) + '%)');
    console.log('  LaRSI con cruce exacto esa misma vela: ' + larsiCruceOk + '/' + salidasConBBWP.length + ' (' + (larsiCruceOk/salidasConBBWP.length*100).toFixed(1) + '%)');
  }

  // ---------- ANÁLISIS AD: tasas base — ¿los porcentajes del AC son mejores que el puro azar? ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS AD — Tasas base de cada indicador (para interpretar el Análisis AC con criterio)');
  console.log('========================================');
  console.log('Mismos indicadores, pero medidos sobre TODAS las velas de 4H que cumplen la condición de');
  console.log('BBWP (no solo las de entrada/salida) — así sabemos qué tasa de "acierto por pura casualidad"');
  console.log('cabría esperar, y podemos comparar los porcentajes del Análisis AC contra ese punto de partida.');

  let totalVelasBBWP = 0;
  let mlAlcista=0, mlBajista=0, mlOtro=0;
  let larsiArriba=0, larsiAbajo=0;
  let larsiCompra=0, larsiVenta=0;
  for(let i=0; i<s4H.n; i++){
    if(!bbwpAscendiendoYAlto(s4H, i, 45, 3)) continue;
    totalVelasBBWP++;
    if(mlSignal4H[i]==='Alcista') mlAlcista++;
    else if(mlSignal4H[i]==='Bajista') mlBajista++;
    else mlOtro++;
    if(!isNaN(s4H.larsi[i])){
      if(s4H.larsi[i]>0.5) larsiArriba++;
      else larsiAbajo++;
    }
    if(s4H.larsiState[i]==='compra') larsiCompra++;
    else if(s4H.larsiState[i]==='venta') larsiVenta++;
  }
  console.log('\nTotal de velas de 4H que cumplen la condición de BBWP (de un total de ' + s4H.n + '): ' + totalVelasBBWP);
  console.log('\n--- Tasas base (sobre TODAS esas velas, no solo entradas/salidas) ---');
  console.log('ML RSI (4H): Alcista ' + (mlAlcista/totalVelasBBWP*100).toFixed(1) + '% · Bajista ' + (mlBajista/totalVelasBBWP*100).toFixed(1) + '% · Otro/neutral ' + (mlOtro/totalVelasBBWP*100).toFixed(1) + '%');
  console.log('LaRSI del lado: >50 (arriba) ' + (larsiArriba/totalVelasBBWP*100).toFixed(1) + '% · <50 (abajo) ' + (larsiAbajo/totalVelasBBWP*100).toFixed(1) + '%');
  console.log('LaRSI cruces: compra ' + (larsiCompra/totalVelasBBWP*100).toFixed(2) + '% de las velas · venta ' + (larsiVenta/totalVelasBBWP*100).toFixed(2) + '% de las velas');

  const entradasLargas = entradasConBBWP.filter(op=>op.direction==='long').length;
  const entradasCortas = entradasConBBWP.filter(op=>op.direction==='short').length;
  console.log('\n--- Reparto largo/corto de las entradas ya vistas en el Análisis AC (para ponderar la comparación) ---');
  console.log('Entradas largas: ' + entradasLargas + ' (' + (entradasLargas/entradasConBBWP.length*100).toFixed(1) + '%) · Entradas cortas: ' + entradasCortas + ' (' + (entradasCortas/entradasConBBWP.length*100).toFixed(1) + '%)');

  // Recalcular aquí mismo la coincidencia real (no reutilizar texto fijo del log
  // anterior), para que quede siempre consistente con los datos de esta misma
  // ejecución.
  let mlOkReal=0, larsiLadoOkReal=0;
  entradasConBBWP.forEach(op=>{
    const i = op.entryIdx;
    if(op.direction==='long' ? mlSignal4H[i]==='Alcista' : mlSignal4H[i]==='Bajista') mlOkReal++;
    if(!isNaN(s4H.larsi[i]) && (op.direction==='long' ? s4H.larsi[i]>0.5 : s4H.larsi[i]<0.5)) larsiLadoOkReal++;
  });
  const mlRealPct = mlOkReal/entradasConBBWP.length*100;
  const larsiRealPct = larsiLadoOkReal/entradasConBBWP.length*100;

  const baseEsperadaML = (entradasLargas/entradasConBBWP.length)*(mlAlcista/totalVelasBBWP) + (entradasCortas/entradasConBBWP.length)*(mlBajista/totalVelasBBWP);
  const baseEsperadaLarsi = (entradasLargas/entradasConBBWP.length)*(larsiArriba/totalVelasBBWP) + (entradasCortas/entradasConBBWP.length)*(larsiAbajo/totalVelasBBWP);
  console.log('\n--- Comparación directa: coincidencia real en las entradas vs la esperada solo por azar ---');
  console.log('ML RSI en las entradas:       real ' + mlRealPct.toFixed(1) + '%  vs  esperado por azar ' + (baseEsperadaML*100).toFixed(1) + '%');
  console.log('LaRSI (lado) en las entradas: real ' + larsiRealPct.toFixed(1) + '%  vs  esperado por azar ' + (baseEsperadaLarsi*100).toFixed(1) + '%');

  // ---------- ANÁLISIS AE: con el Trend Speed Analyzer ya incorporado — coincidencia individual y combinada ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS AE — Trend Speed Analyzer: coincidencia individual y combinación conjunta con BBWP+LaRSI/ML RSI');
  console.log('========================================');
  console.log('Misma condición de BBWP que en el Análisis AC/AD. "Trend Speed cambia de signo" = trendspeed cruza');
  console.log('de negativo a positivo (o al revés) justo en esa vela — el cambio de barras rojas a verdes que se veía');
  console.log('en los dos casos de HBAR y BTC.');

  function trendSpeedFlip(series, i){
    if(i<1 || isNaN(series.trendspeed[i]) || isNaN(series.trendspeed[i-1])) return null;
    if(series.trendspeed[i]>0 && series.trendspeed[i-1]<=0) return 'alcista';
    if(series.trendspeed[i]<0 && series.trendspeed[i-1]>=0) return 'bajista';
    return null;
  }

  console.log('\n--- 1) Coincidencia individual del Trend Speed con las entradas (misma condición de BBWP del AC) ---');
  let tsOkEntrada=0;
  entradasConBBWP.forEach(op=>{
    const flip = trendSpeedFlip(s4H, op.entryIdx);
    if((op.direction==='long' && flip==='alcista') || (op.direction==='short' && flip==='bajista')) tsOkEntrada++;
  });
  console.log('Trend Speed cruza de signo EN LA MISMA VELA que la entrada: ' + tsOkEntrada + '/' + entradasConBBWP.length + ' (' + (tsOkEntrada/entradasConBBWP.length*100).toFixed(1) + '%)');

  // Tasa base del Trend Speed (sobre todas las velas con BBWP alto/subiendo, igual que en el AD)
  let tsFlipAlcista=0, tsFlipBajista=0;
  for(let i=0;i<s4H.n;i++){
    if(!bbwpAscendiendoYAlto(s4H, i, 45, 3)) continue;
    const flip = trendSpeedFlip(s4H, i);
    if(flip==='alcista') tsFlipAlcista++;
    else if(flip==='bajista') tsFlipBajista++;
  }
  const baseEsperadaTS = (entradasLargas/entradasConBBWP.length)*(tsFlipAlcista/totalVelasBBWP) + (entradasCortas/entradasConBBWP.length)*(tsFlipBajista/totalVelasBBWP);
  console.log('Tasa base (cruce de Trend Speed en cualquier vela con BBWP alto/subiendo): ' + (baseEsperadaTS*100).toFixed(2) + '% — comparar contra el ' + (tsOkEntrada/entradasConBBWP.length*100).toFixed(1) + '% real de arriba');

  console.log('\n--- 2) La combinación conjunta de los dos casos visuales: BBWP + Trend Speed + (LaRSI o ML RSI) a la vez ---');
  console.log('Se busca, en una ventana de ±2 velas alrededor de cada entrada real: BBWP cumplido, Trend Speed');
  console.log('cruzando de signo en la dirección correcta, Y (LaRSI del lado correcto O ML RSI coincide).');

  function combinacionCercaDeEntrada(op){
    const centro = op.entryIdx;
    for(let i=Math.max(0,centro-2); i<=centro+2 && i<s4H.n; i++){
      if(!bbwpAscendiendoYAlto(s4H, i, 45, 3)) continue;
      const flip = trendSpeedFlip(s4H, i);
      const tsOk = (op.direction==='long' && flip==='alcista') || (op.direction==='short' && flip==='bajista');
      if(!tsOk) continue;
      const larsiOk = !isNaN(s4H.larsi[i]) && (op.direction==='long' ? s4H.larsi[i]>0.5 : s4H.larsi[i]<0.5);
      const mlOk = op.direction==='long' ? mlSignal4H[i]==='Alcista' : mlSignal4H[i]==='Bajista';
      if(larsiOk || mlOk) return true;
    }
    return false;
  }

  const todasLasEntradas = operacionesDetalle; // sin filtrar por BBWP esta vez — la condición ya va dentro de la función
  let combinacionCoincide = 0;
  todasLasEntradas.forEach(op=>{ if(combinacionCercaDeEntrada(op)) combinacionCoincide++; });
  console.log('La combinación conjunta aparece cerca de ' + combinacionCoincide + '/' + todasLasEntradas.length + ' entradas reales (' + (combinacionCoincide/todasLasEntradas.length*100).toFixed(1) + '%)');

  // Resultado de las operaciones donde SÍ apareció la combinación, comparado con las que no
  const conCombinacion = todasLasEntradas.filter(op=>combinacionCercaDeEntrada(op)).map(op=>({equityChangePct:op.finalPct}));
  const sinCombinacion = todasLasEntradas.filter(op=>!combinacionCercaDeEntrada(op)).map(op=>({equityChangePct:op.finalPct}));
  const mConCombinacion = metricsForTradeSubset(conCombinacion);
  const mSinCombinacion = metricsForTradeSubset(sinCombinacion);
  console.log('\n--- ¿Las operaciones con la combinación presente salen mejor que las que no la tienen? ---');
  console.log(pad('Grupo',24) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno medio',15) + padL('P.Factor',10));
  const ganadorasConCombo = conCombinacion.filter(t=>t.equityChangePct>0).length;
  const ganadorasSinCombo = sinCombinacion.filter(t=>t.equityChangePct>0).length;
  const mediaConCombo = conCombinacion.reduce((a,t)=>a+t.equityChangePct,0)/conCombinacion.length;
  const mediaSinCombo = sinCombinacion.reduce((a,t)=>a+t.equityChangePct,0)/sinCombinacion.length;
  console.log(pad('Con la combinación',24) + padL(conCombinacion.length,9) + padL((ganadorasConCombo/conCombinacion.length*100).toFixed(1)+'%',11) + padL(fmtPct(mediaConCombo),15) + padL(mConCombinacion.profitFactor.toFixed(2),10));
  console.log(pad('Sin la combinación',24) + padL(sinCombinacion.length,9) + padL((ganadorasSinCombo/sinCombinacion.length*100).toFixed(1)+'%',11) + padL(fmtPct(mediaSinCombo),15) + padL(mSinCombinacion.profitFactor.toFixed(2),10));

  // ---------- ANÁLISIS AF: ¿el filtro de ML RSI mejora de verdad el resultado, no solo la coincidencia? ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS AF — Filtro real de ML RSI (4H): ¿mejora el retorno/drawdown/profit factor de la 20/80?');
  console.log('========================================');
  console.log('Se exige que el ML RSI (4H) coincida con la dirección de la entrada, ADEMÁS de las condiciones');
  console.log('normales de la Confluencia — usando el MISMO simulador validado, para que la comparación sea justa.');

  const filtroMLRSI = (i, direction) => {
    return direction==='long' ? mlSignal4H[i]==='Alcista' : mlSignal4H[i]==='Bajista';
  };

  const rSinFiltroML = simulateConfluenciaTPParcial(s4H, sD, 3, LEVERAGE, 0.12, 4, 0.20, false);
  const rConFiltroML = simulateConfluenciaTPParcial(s4H, sD, 3, LEVERAGE, 0.12, 4, 0.20, false, filtroMLRSI);

  console.log('\n--- Comparación directa (20/80, 12% capital, 5x) ---');
  console.log(pad('Variante',22) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  console.log(pad('Sin filtro ML RSI',22) + padL(rSinFiltroML.trades,9) + padL(rSinFiltroML.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(rSinFiltroML.totalReturnPct),12) + padL('-'+rSinFiltroML.maxDrawdownPct.toFixed(1)+'%',11) + padL(rSinFiltroML.profitFactor.toFixed(2),10));
  console.log(pad('Con filtro ML RSI',22) + padL(rConFiltroML.trades,9) + padL(rConFiltroML.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(rConFiltroML.totalReturnPct),12) + padL('-'+rConFiltroML.maxDrawdownPct.toFixed(1)+'%',11) + padL(rConFiltroML.profitFactor.toFixed(2),10));

  console.log('\n--- Walk-forward año por año, CON el filtro de ML RSI ---');
  console.log(pad('Año',8) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  const bucketsFiltroML = {};
  rConFiltroML.tradeLog.forEach(t=>{
    const year = new Date(s4H.times[t.entryIdx]).getUTCFullYear();
    if(!bucketsFiltroML[year]) bucketsFiltroML[year] = [];
    bucketsFiltroML[year].push(t);
  });
  let aniosPositivosFiltroML=0, aniosTotalFiltroML=0;
  Object.keys(bucketsFiltroML).map(Number).sort((a,b)=>a-b).forEach(year=>{
    const m = metricsForTradeSubset(bucketsFiltroML[year]);
    console.log(pad(String(year),8) + padL(m.trades,9) + padL(m.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(m.totalReturnPct),12) + padL('-'+m.maxDrawdownPct.toFixed(1)+'%',11) + padL(m.profitFactor.toFixed(2),10));
    aniosTotalFiltroML++;
    if(m.totalReturnPct>0) aniosPositivosFiltroML++;
  });
  console.log('Años con retorno positivo: ' + aniosPositivosFiltroML + ' de ' + aniosTotalFiltroML);

  // ---------- ANÁLISIS AG: ML RSI en 1H, ¿anticiparse mejora el resultado (a diferencia de exigirlo en la misma vela)? ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS AG — ML RSI en 1H (temporalidad menor): ¿anticiparse mejora el resultado, a diferencia del filtro en la misma vela?');
  console.log('========================================');
  console.log('En vez de exigir que el ML RSI coincida EN LA MISMA vela de 4H (Análisis AF, no ayudó), aquí se');
  console.log('comprueba si el ML RSI de 1H YA VENÍA confirmando la dirección correcta en las horas previas a');
  console.log('la entrada — sin descartar ninguna operación, solo comparando resultado según si se adelantó o no.');

  const idx1HPara4H = alignDailyIndex(s, s4H.times); // para cada vela de 4H, el índice de 1H más reciente
  const VENTANA_ANTICIPACION_HORAS = 12; // 12 velas de 1H = 12 horas hacia atrás

  function mlRSI1HYaConfirmabaAntes(entryIdx4H, direction){
    const idx1H = idx1HPara4H[entryIdx4H];
    if(idx1H<0) return false;
    const desde = Math.max(0, idx1H - VENTANA_ANTICIPACION_HORAS);
    for(let k=desde; k<=idx1H; k++){
      const match = direction==='long' ? mlSignal[k]==='Alcista' : mlSignal[k]==='Bajista';
      if(match) return true;
    }
    return false;
  }

  const todasLas2080 = rParcial20.tradeLog.map(t=>{
    const direction = (s4H.aoState[t.entryIdx]==='Alcista' && s4H.koBull[t.entryIdx]) ? 'long' : 'short';
    return { ...t, direction, seAnticipo: mlRSI1HYaConfirmabaAntes(t.entryIdx, direction) };
  });

  const conAnticipacion = todasLas2080.filter(t=>t.seAnticipo);
  const sinAnticipacion = todasLas2080.filter(t=>!t.seAnticipo);
  console.log('\nDe ' + todasLas2080.length + ' operaciones (config. 20/80), el ML RSI de 1H ya confirmaba en las ' + VENTANA_ANTICIPACION_HORAS + 'h previas en ' + conAnticipacion.length + ' (' + (conAnticipacion.length/todasLas2080.length*100).toFixed(1) + '%)');

  const mConAnticipacion = metricsForTradeSubset(conAnticipacion);
  const mSinAnticipacion = metricsForTradeSubset(sinAnticipacion);
  console.log('\n--- ¿El resultado real es mejor cuando el ML RSI de 1H se adelantó? ---');
  console.log(pad('Grupo',26) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  console.log(pad('Con anticipación (1H)',26) + padL(conAnticipacion.length,9) + padL(mConAnticipacion.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(mConAnticipacion.totalReturnPct),12) + padL('-'+mConAnticipacion.maxDrawdownPct.toFixed(1)+'%',11) + padL(mConAnticipacion.profitFactor.toFixed(2),10));
  console.log(pad('Sin anticipación',26) + padL(sinAnticipacion.length,9) + padL(mSinAnticipacion.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(mSinAnticipacion.totalReturnPct),12) + padL('-'+mSinAnticipacion.maxDrawdownPct.toFixed(1)+'%',11) + padL(mSinAnticipacion.profitFactor.toFixed(2),10));

  console.log('\n--- Como filtro real: solo tomar las operaciones donde el ML RSI de 1H ya se había adelantado ---');
  console.log('(mismo formato que el Análisis AF, para comparar directamente)');
  console.log('Retorno total si solo hubiéramos tomado esas ' + conAnticipacion.length + ' operaciones: ' + fmtPct(mConAnticipacion.totalReturnPct) + ' (frente al ' + fmtPct(rParcial20.totalReturnPct) + ' de la 20/80 completa sin ningún filtro)');

  // ---------- ANÁLISIS AH: ¿la FUERZA del Trend Speed en la entrada predice un movimiento más fuerte después? ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS AH — ¿Entrar cuando el Trend Speed ya viene con fuerza predice un movimiento posterior más fuerte?');
  console.log('========================================');
  console.log('No es solo si el Trend Speed está a favor o en contra, sino CUÁNTO — su magnitud. Se agrupan las');
  console.log('operaciones por la fuerza del Trend Speed (alineada con la dirección) justo en el momento de entrar,');
  console.log('y se compara el mejor punto que llegó a alcanzar cada grupo después.');

  const operacionesConFuerza = operacionesDetalle.map(op=>{
    const ts = s4H.trendspeed[op.entryIdx];
    const fuerzaAlineada = isNaN(ts) ? NaN : (op.direction==='long' ? ts : -ts);
    return { ...op, fuerzaAlineada };
  }).filter(op=>!isNaN(op.fuerzaAlineada));

  const ordenadoPorFuerza = [...operacionesConFuerza].sort((a,b)=>a.fuerzaAlineada-b.fuerzaAlineada);
  const tamCuartilFuerza = Math.floor(ordenadoPorFuerza.length/4);
  console.log('\nOperaciones con Trend Speed disponible: ' + operacionesConFuerza.length + ' de ' + operacionesDetalle.length);
  console.log('\n' + pad('Cuartil fuerza',18) + padL('Rango',22) + padL('Operac.',9) + padL('% Acierto',11) + padL('Mejor punto medio',18) + padL('Resultado medio',16));
  for(let q=0;q<4;q++){
    const desde = q*tamCuartilFuerza, hasta = (q===3) ? ordenadoPorFuerza.length : (q+1)*tamCuartilFuerza;
    const grupo = ordenadoPorFuerza.slice(desde,hasta);
    if(!grupo.length) continue;
    const ganadoras = grupo.filter(op=>op.finalPct>0).length;
    const mejorMedio = grupo.reduce((a,op)=>a+op.mejorPct,0)/grupo.length;
    const finalMedio = grupo.reduce((a,op)=>a+op.finalPct,0)/grupo.length;
    const rango = grupo[0].fuerzaAlineada.toFixed(1) + ' a ' + grupo[grupo.length-1].fuerzaAlineada.toFixed(1);
    const etiqueta = q===0 ? 'Q1 (más débil/contra)' : q===3 ? 'Q4 (más fuerte/a favor)' : 'Q'+(q+1);
    console.log(pad(etiqueta,18) + padL(rango,22) + padL(grupo.length,9) + padL((ganadoras/grupo.length*100).toFixed(1)+'%',11) + padL(fmtPct(mejorMedio),18) + padL(fmtPct(finalMedio),16));
  }

  // ---------- ANÁLISIS AI: barrido del UMBRAL del TP (no la fracción) con la 20/80 actual ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS AI — Barrido del umbral del TP (no la fracción) con la configuración 20/80 actual');
  console.log('========================================');
  console.log('Desde que existe el TP parcial, el umbral se ha quedado fijo en 3% de precio — nunca se ha');
  console.log('vuelto a barrer con el reparto 20/80 ya validado. Aquí se prueba variando SOLO el umbral,');
  console.log('con la fracción (20%) y el resto de la configuración exactamente igual que la validada.');

  console.log('\n' + pad('TP (precio)',14) + padL('TP (posición)',15) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  [1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 8].forEach(tpPct=>{
    const r = simulateConfluenciaTPParcial(s4H, sD, tpPct, LEVERAGE, 0.12, 4, 0.20, false);
    console.log(pad(tpPct+'%',14) + padL((tpPct*LEVERAGE)+'%',15) + padL(r.trades,9) + padL(r.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(r.totalReturnPct),12) + padL('-'+r.maxDrawdownPct.toFixed(1)+'%',11) + padL(r.profitFactor.toFixed(2),10));
  });

  // ---------- ANÁLISIS AJ: localizar el salto de drawdown entre 3% y 3.5% ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS AJ — ¿Dónde exactamente salta el drawdown entre TP 3% y 3.5%, y qué año es responsable?');
  console.log('========================================');
  console.log('Confirmación: el Análisis AI (y este) NO usan ningún filtro de indicador — es la 20/80 base,');
  console.log('sin ML RSI ni ningún otro añadido, tal como está validada.');

  console.log('\n--- Barrido fino entre 3.0% y 3.5%, en pasos de 0.1% ---');
  console.log(pad('TP (precio)',14) + padL('Operac.',9) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  [3.0, 3.1, 3.2, 3.3, 3.4, 3.5].forEach(tpPct=>{
    const r = simulateConfluenciaTPParcial(s4H, sD, tpPct, LEVERAGE, 0.12, 4, 0.20, false);
    console.log(pad(tpPct.toFixed(1)+'%',14) + padL(r.trades,9) + padL(fmtPct(r.totalReturnPct),12) + padL('-'+r.maxDrawdownPct.toFixed(1)+'%',11) + padL(r.profitFactor.toFixed(2),10));
  });

  console.log('\n--- Comparación año por año: TP 3% (el actual) vs TP 3.5% (donde ya salta el drawdown) ---');
  const r3 = simulateConfluenciaTPParcial(s4H, sD, 3.0, LEVERAGE, 0.12, 4, 0.20, false);
  const r35 = simulateConfluenciaTPParcial(s4H, sD, 3.5, LEVERAGE, 0.12, 4, 0.20, false);
  const buckets3 = {}, buckets35 = {};
  r3.tradeLog.forEach(t=>{ const y=new Date(s4H.times[t.entryIdx]).getUTCFullYear(); (buckets3[y]=buckets3[y]||[]).push(t); });
  r35.tradeLog.forEach(t=>{ const y=new Date(s4H.times[t.entryIdx]).getUTCFullYear(); (buckets35[y]=buckets35[y]||[]).push(t); });
  console.log(pad('Año',8) + padL('DD con TP 3%',15) + padL('DD con TP 3.5%',16) + padL('Diferencia',13));
  const todosLosAnios = new Set([...Object.keys(buckets3), ...Object.keys(buckets35)]);
  [...todosLosAnios].map(Number).sort((a,b)=>a-b).forEach(year=>{
    const m3 = metricsForTradeSubset(buckets3[year]||[]);
    const m35 = metricsForTradeSubset(buckets35[year]||[]);
    const diferencia = m35.maxDrawdownPct - m3.maxDrawdownPct;
    const marca = diferencia>3 ? '  <-- aquí' : '';
    console.log(pad(String(year),8) + padL('-'+m3.maxDrawdownPct.toFixed(1)+'%',15) + padL('-'+m35.maxDrawdownPct.toFixed(1)+'%',16) + padL(diferencia.toFixed(1)+' pts',13) + marca);
  });

  // ---------- ANÁLISIS AK: filtro real de Trend Speed — ¿excluir Q1 (en contra) mejora de verdad? ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS AK — Filtro real de Trend Speed: ¿excluir las entradas donde va en contra mejora el resultado real?');
  console.log('========================================');
  console.log('Se exige que el Trend Speed, alineado con la dirección de la entrada, sea positivo (aunque sea');
  console.log('poco) — igual que se hizo con el ML RSI en el Análisis AF, usando el MISMO simulador validado.');

  const filtroTrendSpeed = (i, direction) => {
    const ts = s4H.trendspeed[i];
    if(isNaN(ts)) return true; // si no hay dato, no se descarta por este filtro
    return direction==='long' ? ts>0 : ts<0;
  };

  const rSinFiltroTS = simulateConfluenciaTPParcial(s4H, sD, 3, LEVERAGE, 0.12, 4, 0.20, false);
  const rConFiltroTS = simulateConfluenciaTPParcial(s4H, sD, 3, LEVERAGE, 0.12, 4, 0.20, false, filtroTrendSpeed);

  console.log('\n--- Comparación directa (20/80, 12% capital, 5x) ---');
  console.log(pad('Variante',26) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  console.log(pad('Sin filtro Trend Speed',26) + padL(rSinFiltroTS.trades,9) + padL(rSinFiltroTS.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(rSinFiltroTS.totalReturnPct),12) + padL('-'+rSinFiltroTS.maxDrawdownPct.toFixed(1)+'%',11) + padL(rSinFiltroTS.profitFactor.toFixed(2),10));
  console.log(pad('Con filtro Trend Speed',26) + padL(rConFiltroTS.trades,9) + padL(rConFiltroTS.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(rConFiltroTS.totalReturnPct),12) + padL('-'+rConFiltroTS.maxDrawdownPct.toFixed(1)+'%',11) + padL(rConFiltroTS.profitFactor.toFixed(2),10));

  console.log('\n--- Walk-forward año por año, CON el filtro de Trend Speed ---');
  console.log(pad('Año',8) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  const bucketsFiltroTS = {};
  rConFiltroTS.tradeLog.forEach(t=>{
    const year = new Date(s4H.times[t.entryIdx]).getUTCFullYear();
    if(!bucketsFiltroTS[year]) bucketsFiltroTS[year] = [];
    bucketsFiltroTS[year].push(t);
  });
  let aniosPositivosFiltroTS=0, aniosTotalFiltroTS=0;
  Object.keys(bucketsFiltroTS).map(Number).sort((a,b)=>a-b).forEach(year=>{
    const m = metricsForTradeSubset(bucketsFiltroTS[year]);
    console.log(pad(String(year),8) + padL(m.trades,9) + padL(m.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(m.totalReturnPct),12) + padL('-'+m.maxDrawdownPct.toFixed(1)+'%',11) + padL(m.profitFactor.toFixed(2),10));
    aniosTotalFiltroTS++;
    if(m.totalReturnPct>0) aniosPositivosFiltroTS++;
  });
  console.log('Años con retorno positivo: ' + aniosPositivosFiltroTS + ' de ' + aniosTotalFiltroTS);

  console.log('\n--- Validación fuera de muestra: últimos ' + MESES_RESERVADOS + ' meses reservados ---');
  const cutoffReservadoTS = ohlcv4H.times[ohlcv4H.times.length-1] - MESES_RESERVADOS*30*86400000;
  const tradesAntesTS = rConFiltroTS.tradeLog.filter(t => s4H.times[t.entryIdx] < cutoffReservadoTS);
  const tradesReservadoTS = rConFiltroTS.tradeLog.filter(t => s4H.times[t.entryIdx] >= cutoffReservadoTS);
  const mAntesTS = metricsForTradeSubset(tradesAntesTS);
  const mReservadoTS = metricsForTradeSubset(tradesReservadoTS);
  console.log(pad('Tramo',20) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  console.log(pad('Resto del histórico',20) + padL(mAntesTS.trades,9) + padL(mAntesTS.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(mAntesTS.totalReturnPct),12) + padL('-'+mAntesTS.maxDrawdownPct.toFixed(1)+'%',11) + padL(mAntesTS.profitFactor.toFixed(2),10));
  console.log(pad('TRAMO RESERVADO',20) + padL(mReservadoTS.trades,9) + padL(mReservadoTS.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(mReservadoTS.totalReturnPct),12) + padL('-'+mReservadoTS.maxDrawdownPct.toFixed(1)+'%',11) + padL(mReservadoTS.profitFactor.toFixed(2),10));

  // ---------- ANÁLISIS AL: ¿cuánto tiempo suelen durar las operaciones, tal cual está programado el bot? ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS AL — Duración media de las operaciones (configuración 20/80 real del bot)');
  console.log('========================================');
  console.log('Desde la entrada hasta el cierre completo (ambos tramos), medido en horas y días.');

  const rDuracion = simulateConfluenciaTPParcial(s4H, sD, 3, LEVERAGE, 0.12, 4, 0.20, false);
  const duraciones = rDuracion.tradeLog.map(t => (t.exitIdx - t.entryIdx) * 4); // en horas (velas de 4H)

  const mediaGeneral = duraciones.reduce((a,d)=>a+d,0) / duraciones.length;
  const ordenadas = [...duraciones].sort((a,b)=>a-b);
  const mediana = ordenadas[Math.floor(ordenadas.length/2)];
  console.log('\nTotal de operaciones: ' + duraciones.length);
  console.log('Duración media: ' + mediaGeneral.toFixed(1) + ' horas (' + (mediaGeneral/24).toFixed(1) + ' días)');
  console.log('Duración mediana: ' + mediana + ' horas (' + (mediana/24).toFixed(1) + ' días) — menos afectada por casos extremos que la media');
  console.log('Más corta: ' + Math.min(...duraciones) + 'h · Más larga: ' + Math.max(...duraciones) + 'h (' + (Math.max(...duraciones)/24).toFixed(1) + ' días)');

  console.log('\n--- Desglose: operaciones que tocaron el TP parcial vs las que no ---');
  const conTP = rDuracion.tradeLog.filter(t=>t.tocoTP).map(t=>(t.exitIdx-t.entryIdx)*4);
  const sinTP = rDuracion.tradeLog.filter(t=>!t.tocoTP).map(t=>(t.exitIdx-t.entryIdx)*4);
  const mediaConTP = conTP.reduce((a,d)=>a+d,0)/conTP.length;
  const mediaSinTP = sinTP.reduce((a,d)=>a+d,0)/sinTP.length;
  console.log('Tocaron el TP parcial (' + conTP.length + ' operaciones): media ' + mediaConTP.toFixed(1) + 'h (' + (mediaConTP/24).toFixed(1) + ' días)');
  console.log('NO tocaron el TP (' + sinTP.length + ' operaciones): media ' + mediaSinTP.toFixed(1) + 'h (' + (mediaSinTP/24).toFixed(1) + ' días)');

  // ---------- ANÁLISIS AM: perfil de indicadores en la entrada — tocaron el TP vs no lo tocaron ---------
  console.log('\n\n========================================');
  console.log('ANÁLISIS AM — Diferencia en los indicadores de ENTRADA: operaciones que tocaron el TP vs las que no');
  console.log('========================================');
  console.log('Para cada indicador, se pasa a una escala "a favor de la dirección de la entrada" (más alto =');
  console.log('más a favor, tanto para largos como para cortos), y se compara la media entre los dos grupos.');

  const operacionesConIndicadores = rDuracion.tradeLog.map(t=>{
    const i = t.entryIdx;
    const direction = (s4H.aoState[i]==='Alcista' && s4H.koBull[i]) ? 'long' : 'short';
    const mlCoincide = direction==='long' ? mlSignal4H[i]==='Alcista' : mlSignal4H[i]==='Bajista';
    const larsiValor = isNaN(s4H.larsi[i]) ? NaN : s4H.larsi[i]*100;
    const larsiAlineado = isNaN(larsiValor) ? NaN : (direction==='long' ? larsiValor : (100-larsiValor));
    const tsFuerza = isNaN(s4H.trendspeed[i]) ? NaN : (direction==='long' ? s4H.trendspeed[i] : -s4H.trendspeed[i]);
    const cambiosAO = contarCambiosAO(s4H, i, 12);
    return { tocoTP: t.tocoTP, bbwp: s4H.bbwp[i], cambiosAO, mlCoincide, larsiAlineado, tsFuerza };
  });

  const conTPIndicadores = operacionesConIndicadores.filter(o=>o.tocoTP);
  const sinTPIndicadores = operacionesConIndicadores.filter(o=>!o.tocoTP);

  function media(arr, campo){
    const vals = arr.map(o=>o[campo]).filter(v=>!isNaN(v));
    return vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : NaN;
  }
  function pctTrue(arr, campo){
    return arr.length ? arr.filter(o=>o[campo]).length/arr.length*100 : NaN;
  }

  console.log('\nTocaron el TP: ' + conTPIndicadores.length + ' operaciones · NO tocaron el TP: ' + sinTPIndicadores.length + ' operaciones');
  console.log('\n' + pad('Indicador (en la entrada)',28) + padL('Tocaron TP',14) + padL('NO tocaron TP',16));
  console.log(pad('BBWP',28) + padL(media(conTPIndicadores,'bbwp').toFixed(1),14) + padL(media(sinTPIndicadores,'bbwp').toFixed(1),16));
  console.log(pad('Cambios de AO (12 velas)',28) + padL(media(conTPIndicadores,'cambiosAO').toFixed(2),14) + padL(media(sinTPIndicadores,'cambiosAO').toFixed(2),16));
  console.log(pad('ML RSI coincide (%)',28) + padL(pctTrue(conTPIndicadores,'mlCoincide').toFixed(1)+'%',14) + padL(pctTrue(sinTPIndicadores,'mlCoincide').toFixed(1)+'%',16));
  console.log(pad('LaRSI alineado (0-100)',28) + padL(media(conTPIndicadores,'larsiAlineado').toFixed(1),14) + padL(media(sinTPIndicadores,'larsiAlineado').toFixed(1),16));
  console.log(pad('Trend Speed alineado',28) + padL(media(conTPIndicadores,'tsFuerza').toFixed(1),14) + padL(media(sinTPIndicadores,'tsFuerza').toFixed(1),16));

  // ---------- ANÁLISIS AN: filtro real de BBWP — ¿exigir volatilidad alta en la entrada mejora de verdad? ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS AN — Filtro real de BBWP: ¿exigir BBWP>50 en la entrada mejora el resultado real?');
  console.log('========================================');
  console.log('Mismo formato que los Análisis AF (ML RSI) y AK (Trend Speed), para comparar en igualdad');
  console.log('de condiciones — mismo simulador validado, mismo tipo de prueba.');

  const filtroBBWP = (i, direction) => {
    const b = s4H.bbwp[i];
    if(isNaN(b)) return true;
    return b > 50;
  };

  const rSinFiltroBBWP = simulateConfluenciaTPParcial(s4H, sD, 3, LEVERAGE, 0.12, 4, 0.20, false);
  const rConFiltroBBWP = simulateConfluenciaTPParcial(s4H, sD, 3, LEVERAGE, 0.12, 4, 0.20, false, filtroBBWP);

  console.log('\n--- Comparación directa (20/80, 12% capital, 5x) ---');
  console.log(pad('Variante',20) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  console.log(pad('Sin filtro BBWP',20) + padL(rSinFiltroBBWP.trades,9) + padL(rSinFiltroBBWP.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(rSinFiltroBBWP.totalReturnPct),12) + padL('-'+rSinFiltroBBWP.maxDrawdownPct.toFixed(1)+'%',11) + padL(rSinFiltroBBWP.profitFactor.toFixed(2),10));
  console.log(pad('Con filtro BBWP',20) + padL(rConFiltroBBWP.trades,9) + padL(rConFiltroBBWP.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(rConFiltroBBWP.totalReturnPct),12) + padL('-'+rConFiltroBBWP.maxDrawdownPct.toFixed(1)+'%',11) + padL(rConFiltroBBWP.profitFactor.toFixed(2),10));

  console.log('\n--- Walk-forward año por año, CON el filtro de BBWP ---');
  console.log(pad('Año',8) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  const bucketsFiltroBBWP = {};
  rConFiltroBBWP.tradeLog.forEach(t=>{
    const year = new Date(s4H.times[t.entryIdx]).getUTCFullYear();
    if(!bucketsFiltroBBWP[year]) bucketsFiltroBBWP[year] = [];
    bucketsFiltroBBWP[year].push(t);
  });
  let aniosPositivosBBWP=0, aniosTotalBBWP=0;
  Object.keys(bucketsFiltroBBWP).map(Number).sort((a,b)=>a-b).forEach(year=>{
    const m = metricsForTradeSubset(bucketsFiltroBBWP[year]);
    console.log(pad(String(year),8) + padL(m.trades,9) + padL(m.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(m.totalReturnPct),12) + padL('-'+m.maxDrawdownPct.toFixed(1)+'%',11) + padL(m.profitFactor.toFixed(2),10));
    aniosTotalBBWP++;
    if(m.totalReturnPct>0) aniosPositivosBBWP++;
  });
  console.log('Años con retorno positivo: ' + aniosPositivosBBWP + ' de ' + aniosTotalBBWP);

  console.log('\n--- Validación fuera de muestra: últimos ' + MESES_RESERVADOS + ' meses reservados ---');
  const cutoffReservadoBBWP = ohlcv4H.times[ohlcv4H.times.length-1] - MESES_RESERVADOS*30*86400000;
  const tradesAntesBBWP = rConFiltroBBWP.tradeLog.filter(t => s4H.times[t.entryIdx] < cutoffReservadoBBWP);
  const tradesReservadoBBWP = rConFiltroBBWP.tradeLog.filter(t => s4H.times[t.entryIdx] >= cutoffReservadoBBWP);
  const mAntesBBWP = metricsForTradeSubset(tradesAntesBBWP);
  const mReservadoBBWP = metricsForTradeSubset(tradesReservadoBBWP);
  console.log(pad('Tramo',20) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  console.log(pad('Resto del histórico',20) + padL(mAntesBBWP.trades,9) + padL(mAntesBBWP.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(mAntesBBWP.totalReturnPct),12) + padL('-'+mAntesBBWP.maxDrawdownPct.toFixed(1)+'%',11) + padL(mAntesBBWP.profitFactor.toFixed(2),10));
  console.log(pad('TRAMO RESERVADO',20) + padL(mReservadoBBWP.trades,9) + padL(mReservadoBBWP.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(mReservadoBBWP.totalReturnPct),12) + padL('-'+mReservadoBBWP.maxDrawdownPct.toFixed(1)+'%',11) + padL(mReservadoBBWP.profitFactor.toFixed(2),10));

  // ---------- ANÁLISIS AO: barrido de Stop Loss sobre la 20/80 REAL (nunca probado hasta ahora) ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS AO — Barrido de Stop Loss sobre la configuración 20/80 real (nunca probado hasta ahora)');
  console.log('========================================');
  console.log('El Análisis N probó un SL ancho hace tiempo, pero sobre la configuración ANTIGUA (TP completo,');
  console.log('2.550 operaciones) — nunca se ha probado sobre la 20/80 real que usa el bot ahora mismo.');
  console.log('Objetivo: cortar antes las operaciones que ya se torcieron, sin tocar las que van bien.');

  console.log('\n' + pad('SL',8) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  const rSinSLAO = simulateConfluenciaTPParcial(s4H, sD, 3, LEVERAGE, 0.12, 4, 0.20, false);
  console.log(pad('(sin SL, actual)',8) + padL(rSinSLAO.trades,9) + padL(rSinSLAO.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(rSinSLAO.totalReturnPct),12) + padL('-'+rSinSLAO.maxDrawdownPct.toFixed(1)+'%',11) + padL(rSinSLAO.profitFactor.toFixed(2),10));
  const resultadosSL = {};
  [1, 1.5, 2, 2.5, 3, 4, 5, 7, 10].forEach(slPct=>{
    const r = simulateConfluenciaTPParcial(s4H, sD, 3, LEVERAGE, 0.12, 4, 0.20, false, undefined, slPct);
    resultadosSL[slPct] = r;
    console.log(pad('-'+slPct+'%',8) + padL(r.trades,9) + padL(r.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(r.totalReturnPct),12) + padL('-'+r.maxDrawdownPct.toFixed(1)+'%',11) + padL(r.profitFactor.toFixed(2),10));
  });

  console.log('\n--- Efecto específico en 2021 (el año más golpeado por movimientos violentos) ---');
  console.log(pad('SL',8) + padL('Operac.',9) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  function metricasAnio(tradeLog, year){
    const subset = tradeLog.filter(t => new Date(s4H.times[t.entryIdx]).getUTCFullYear()===year);
    return metricsForTradeSubset(subset);
  }
  const m2021SinSL = metricasAnio(rSinSLAO.tradeLog, 2021);
  console.log(pad('(sin SL)',8) + padL(m2021SinSL.trades,9) + padL(fmtPct(m2021SinSL.totalReturnPct),12) + padL('-'+m2021SinSL.maxDrawdownPct.toFixed(1)+'%',11) + padL(m2021SinSL.profitFactor.toFixed(2),10));
  [1, 1.5, 2, 2.5, 3, 4, 5, 7, 10].forEach(slPct=>{
    const m = metricasAnio(resultadosSL[slPct].tradeLog, 2021);
    console.log(pad('-'+slPct+'%',8) + padL(m.trades,9) + padL(fmtPct(m.totalReturnPct),12) + padL('-'+m.maxDrawdownPct.toFixed(1)+'%',11) + padL(m.profitFactor.toFixed(2),10));
  });

  // ---------- ANÁLISIS AP: operaciones cerradas por veredicto en la 20/80 real — ¿había un punto mejor antes? ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS AP — Operaciones cerradas por cambio de veredicto (20/80 real): ¿hubo un punto mejor antes del cierre?');
  console.log('========================================');
  console.log('Se sigue el camino vela a vela de cada operación que NUNCA tocó el TP parcial (se cerró entera');
  console.log('por cambio de veredicto o forzado) y se compara el resultado final con el mejor punto alcanzado');
  console.log('durante su vida — usando la 20/80 real del bot, no la configuración antigua del Análisis Q.');

  function caminoFlotanteEquityPct(series, entryIdx, exitIdx, direction, leverage, marginFraction){
    const entryPrice = series.closes[entryIdx];
    const path = [];
    for(let k=entryIdx; k<=exitIdx; k++){
      const rawPct = direction==='long' ? (series.closes[k]/entryPrice - 1) : (1 - series.closes[k]/entryPrice);
      path.push(rawPct * leverage * marginFraction * 100);
    }
    return path;
  }

  const rParaCamino = simulateConfluenciaTPParcial(s4H, sD, 3, LEVERAGE, 0.12, 4, 0.20, false);
  const cerradasPorVeredicto = rParaCamino.tradeLog.filter(t=>!t.tocoTP);
  console.log('\nTotal de operaciones cerradas por veredicto/forzado (nunca tocaron el TP): ' + cerradasPorVeredicto.length + ' de ' + rParaCamino.trades);

  let conPuntoMejor = 0, sumaMejoraPerdida = 0;
  cerradasPorVeredicto.forEach(t=>{
    const direction = (s4H.aoState[t.entryIdx]==='Alcista' && s4H.koBull[t.entryIdx]) ? 'long' : 'short';
    const path = caminoFlotanteEquityPct(s4H, t.entryIdx, t.exitIdx, direction, LEVERAGE, 0.12);
    const mejorPuntoPath = Math.max(...path);
    const finalPath = path[path.length-1];
    if(mejorPuntoPath > finalPath + 0.01){ // margen mínimo para evitar ruido de redondeo
      conPuntoMejor++;
      sumaMejoraPerdida += (mejorPuntoPath - finalPath);
    }
  });
  console.log('\nDe esas ' + cerradasPorVeredicto.length + ' operaciones, ' + conPuntoMejor + ' (' + (conPuntoMejor/cerradasPorVeredicto.length*100).toFixed(1) + '%) tuvieron un punto anterior mejor que el cierre final.');
  console.log('Mejora media perdida en esos casos: +' + (sumaMejoraPerdida/conPuntoMejor).toFixed(2) + ' puntos porcentuales de cuenta (respecto al cierre real por veredicto).');

  // ---------- ANÁLISIS AQ: barrido de TRAILING STOP sobre la 20/80 real (a diferencia del SL fijo del AO) ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS AQ — Barrido de Trailing Stop sobre la 20/80 real (solo se mueve a favor, nunca cierra por un simple vaivén)');
  console.log('========================================');
  console.log('A diferencia del SL fijo (Análisis AO, que empeoró todo), el trailing solo se activa cuando el precio');
  console.log('retrocede DESDE SU MEJOR PUNTO — no desde la entrada. Debería sufrir menos el efecto sierra de reentradas.');

  console.log('\n' + pad('Trailing',10) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  const rSinTrailAQ = simulateConfluenciaTPParcial(s4H, sD, 3, LEVERAGE, 0.12, 4, 0.20, false);
  console.log(pad('(sin, actual)',10) + padL(rSinTrailAQ.trades,9) + padL(rSinTrailAQ.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(rSinTrailAQ.totalReturnPct),12) + padL('-'+rSinTrailAQ.maxDrawdownPct.toFixed(1)+'%',11) + padL(rSinTrailAQ.profitFactor.toFixed(2),10));
  const resultadosTrail = {};
  [1, 1.5, 2, 2.5, 3, 4, 5, 7, 10].forEach(trailPct=>{
    const r = simulateConfluenciaTPParcial(s4H, sD, 3, LEVERAGE, 0.12, 4, 0.20, false, undefined, undefined, trailPct);
    resultadosTrail[trailPct] = r;
    console.log(pad('-'+trailPct+'%',10) + padL(r.trades,9) + padL(r.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(r.totalReturnPct),12) + padL('-'+r.maxDrawdownPct.toFixed(1)+'%',11) + padL(r.profitFactor.toFixed(2),10));
  });

  console.log('\n--- Efecto específico en 2021 (el año más golpeado por movimientos violentos) ---');
  console.log(pad('Trailing',10) + padL('Operac.',9) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  function metricasAnioTrail(tradeLog, year){
    const subset = tradeLog.filter(t => new Date(s4H.times[t.entryIdx]).getUTCFullYear()===year);
    return metricsForTradeSubset(subset);
  }
  const m2021SinTrail = metricasAnioTrail(rSinTrailAQ.tradeLog, 2021);
  console.log(pad('(sin)',10) + padL(m2021SinTrail.trades,9) + padL(fmtPct(m2021SinTrail.totalReturnPct),12) + padL('-'+m2021SinTrail.maxDrawdownPct.toFixed(1)+'%',11) + padL(m2021SinTrail.profitFactor.toFixed(2),10));
  [1, 1.5, 2, 2.5, 3, 4, 5, 7, 10].forEach(trailPct=>{
    const m = metricasAnioTrail(resultadosTrail[trailPct].tradeLog, 2021);
    console.log(pad('-'+trailPct+'%',10) + padL(m.trades,9) + padL(fmtPct(m.totalReturnPct),12) + padL('-'+m.maxDrawdownPct.toFixed(1)+'%',11) + padL(m.profitFactor.toFixed(2),10));
  });

  // ---------- ANÁLISIS AR: validación rigurosa del trailing al 1% (el pico sospechoso del AQ) ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS AR — Validación rigurosa del trailing al 1%: ¿es un hallazgo real o sobreajuste?');
  console.log('========================================');
  console.log('El pico aislado del Análisis AQ en -1% (rodeado de valores mucho peores) es la señal clásica');
  console.log('de sobreajuste. Antes de aceptarlo, se somete al mismo walk-forward + fuera de muestra que el');
  console.log('resto de hallazgos de hoy (ML RSI, Trend Speed, BBWP).');

  const rTrail1AR = simulateConfluenciaTPParcial(s4H, sD, 3, LEVERAGE, 0.12, 4, 0.20, false, undefined, undefined, 1);

  console.log('\n--- Walk-forward año por año, trailing -1% ---');
  console.log(pad('Año',8) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  const bucketsTrail1 = {};
  rTrail1AR.tradeLog.forEach(t=>{
    const year = new Date(s4H.times[t.entryIdx]).getUTCFullYear();
    if(!bucketsTrail1[year]) bucketsTrail1[year] = [];
    bucketsTrail1[year].push(t);
  });
  let aniosPositivosTrail1=0, aniosTotalTrail1=0;
  Object.keys(bucketsTrail1).map(Number).sort((a,b)=>a-b).forEach(year=>{
    const m = metricsForTradeSubset(bucketsTrail1[year]);
    console.log(pad(String(year),8) + padL(m.trades,9) + padL(m.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(m.totalReturnPct),12) + padL('-'+m.maxDrawdownPct.toFixed(1)+'%',11) + padL(m.profitFactor.toFixed(2),10));
    aniosTotalTrail1++;
    if(m.totalReturnPct>0) aniosPositivosTrail1++;
  });
  console.log('Años con retorno positivo: ' + aniosPositivosTrail1 + ' de ' + aniosTotalTrail1);

  console.log('\n--- Validación fuera de muestra: últimos ' + MESES_RESERVADOS + ' meses reservados ---');
  const cutoffReservadoTrail1 = ohlcv4H.times[ohlcv4H.times.length-1] - MESES_RESERVADOS*30*86400000;
  const tradesAntesTrail1 = rTrail1AR.tradeLog.filter(t => s4H.times[t.entryIdx] < cutoffReservadoTrail1);
  const tradesReservadoTrail1 = rTrail1AR.tradeLog.filter(t => s4H.times[t.entryIdx] >= cutoffReservadoTrail1);
  const mAntesTrail1 = metricsForTradeSubset(tradesAntesTrail1);
  const mReservadoTrail1 = metricsForTradeSubset(tradesReservadoTrail1);
  console.log(pad('Tramo',20) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  console.log(pad('Resto del histórico',20) + padL(mAntesTrail1.trades,9) + padL(mAntesTrail1.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(mAntesTrail1.totalReturnPct),12) + padL('-'+mAntesTrail1.maxDrawdownPct.toFixed(1)+'%',11) + padL(mAntesTrail1.profitFactor.toFixed(2),10));
  console.log(pad('TRAMO RESERVADO',20) + padL(mReservadoTrail1.trades,9) + padL(mReservadoTrail1.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(mReservadoTrail1.totalReturnPct),12) + padL('-'+mReservadoTrail1.maxDrawdownPct.toFixed(1)+'%',11) + padL(mReservadoTrail1.profitFactor.toFixed(2),10));

  console.log('\n--- Barrido fino entre 0.5% y 1.5%, en pasos de 0.1%, para ver si hay una ZONA buena o solo un pico ---');
  console.log(pad('Trailing',10) + padL('Operac.',9) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5].forEach(tp=>{
    const r = simulateConfluenciaTPParcial(s4H, sD, 3, LEVERAGE, 0.12, 4, 0.20, false, undefined, undefined, tp);
    console.log(pad('-'+tp+'%',10) + padL(r.trades,9) + padL(fmtPct(r.totalReturnPct),12) + padL('-'+r.maxDrawdownPct.toFixed(1)+'%',11) + padL(r.profitFactor.toFixed(2),10));
  });

  // ---------- ANÁLISIS AS: examen detallado de los trailings -0.8% y -1.0% ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS AS — Examen detallado: trailing -0.8% y -1.0%');
  console.log('========================================');
  console.log('Duración de las operaciones, distribución real de resultados por operación (para ver si son');
  console.log('muchas ganancias pequeñas y consistentes o pocas extremas), y validación completa del -0.8%');
  console.log('(que todavía no tenía walk-forward ni fuera de muestra).');

  const rTrail08 = simulateConfluenciaTPParcial(s4H, sD, 3, LEVERAGE, 0.12, 4, 0.20, false, undefined, undefined, 0.8);
  const rTrail10 = simulateConfluenciaTPParcial(s4H, sD, 3, LEVERAGE, 0.12, 4, 0.20, false, undefined, undefined, 1.0);

  function estadisticasDuracion(tradeLog){
    const duraciones = tradeLog.map(t=>(t.exitIdx-t.entryIdx)*4);
    const ordenadas = [...duraciones].sort((a,b)=>a-b);
    return {
      media: duraciones.reduce((a,d)=>a+d,0)/duraciones.length,
      mediana: ordenadas[Math.floor(ordenadas.length/2)],
      min: Math.min(...duraciones), max: Math.max(...duraciones)
    };
  }
  function estadisticasPorOperacion(tradeLog){
    const valores = tradeLog.map(t=>t.equityChangePct);
    const ordenados = [...valores].sort((a,b)=>a-b);
    return {
      media: valores.reduce((a,v)=>a+v,0)/valores.length,
      mediana: ordenados[Math.floor(ordenados.length/2)],
      min: Math.min(...valores), max: Math.max(...valores),
      ganadoras: valores.filter(v=>v>0).length, total: valores.length
    };
  }

  [{nombre:'-0.8%', r:rTrail08}, {nombre:'-1.0%', r:rTrail10}].forEach(({nombre, r})=>{
    const dur = estadisticasDuracion(r.tradeLog);
    const porOp = estadisticasPorOperacion(r.tradeLog);
    console.log('\n--- Trailing ' + nombre + ' (' + r.trades + ' operaciones) ---');
    console.log('Duración: media ' + dur.media.toFixed(1) + 'h (' + (dur.media/24).toFixed(1) + ' días) · mediana ' + dur.mediana + 'h · rango ' + dur.min + 'h a ' + dur.max + 'h');
    console.log('Resultado por operación: media ' + porOp.media.toFixed(3) + '% de cuenta · mediana ' + porOp.mediana.toFixed(3) + '%');
    console.log('Mejor operación individual: +' + porOp.max.toFixed(2) + '% · Peor: ' + porOp.min.toFixed(2) + '%');
    console.log('Ganadoras: ' + porOp.ganadoras + '/' + porOp.total + ' (' + (porOp.ganadoras/porOp.total*100).toFixed(1) + '%)');
  });

  console.log('\n--- Walk-forward año por año, trailing -0.8% (que todavía no teníamos) ---');
  console.log(pad('Año',8) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  const bucketsTrail08 = {};
  rTrail08.tradeLog.forEach(t=>{
    const year = new Date(s4H.times[t.entryIdx]).getUTCFullYear();
    if(!bucketsTrail08[year]) bucketsTrail08[year] = [];
    bucketsTrail08[year].push(t);
  });
  let aniosPositivosTrail08=0, aniosTotalTrail08=0;
  Object.keys(bucketsTrail08).map(Number).sort((a,b)=>a-b).forEach(year=>{
    const m = metricsForTradeSubset(bucketsTrail08[year]);
    console.log(pad(String(year),8) + padL(m.trades,9) + padL(m.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(m.totalReturnPct),12) + padL('-'+m.maxDrawdownPct.toFixed(1)+'%',11) + padL(m.profitFactor.toFixed(2),10));
    aniosTotalTrail08++;
    if(m.totalReturnPct>0) aniosPositivosTrail08++;
  });
  console.log('Años con retorno positivo: ' + aniosPositivosTrail08 + ' de ' + aniosTotalTrail08);

  console.log('\n--- Validación fuera de muestra: últimos ' + MESES_RESERVADOS + ' meses reservados, trailing -0.8% ---');
  const cutoffReservadoTrail08 = ohlcv4H.times[ohlcv4H.times.length-1] - MESES_RESERVADOS*30*86400000;
  const tradesAntesTrail08 = rTrail08.tradeLog.filter(t => s4H.times[t.entryIdx] < cutoffReservadoTrail08);
  const tradesReservadoTrail08 = rTrail08.tradeLog.filter(t => s4H.times[t.entryIdx] >= cutoffReservadoTrail08);
  const mAntesTrail08 = metricsForTradeSubset(tradesAntesTrail08);
  const mReservadoTrail08 = metricsForTradeSubset(tradesReservadoTrail08);
  console.log(pad('Tramo',20) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  console.log(pad('Resto del histórico',20) + padL(mAntesTrail08.trades,9) + padL(mAntesTrail08.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(mAntesTrail08.totalReturnPct),12) + padL('-'+mAntesTrail08.maxDrawdownPct.toFixed(1)+'%',11) + padL(mAntesTrail08.profitFactor.toFixed(2),10));
  console.log(pad('TRAMO RESERVADO',20) + padL(mReservadoTrail08.trades,9) + padL(mReservadoTrail08.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(mReservadoTrail08.totalReturnPct),12) + padL('-'+mReservadoTrail08.maxDrawdownPct.toFixed(1)+'%',11) + padL(mReservadoTrail08.profitFactor.toFixed(2),10));

  // ---------- ANÁLISIS AT: las operaciones excepcionales — cuántas por año, en qué años, y en qué dirección ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS AT — Las operaciones excepcionales del trailing: ¿cuántas por año, en qué años, y en qué dirección?');
  console.log('========================================');
  console.log('Se aíslan las operaciones con resultado muy por encima de lo típico (umbral: +3% de cuenta,');
  console.log('varias veces la media general de ~0.2-0.3%) y se desglosan por año y por dirección (largo/corto).');

  function operacionesExcepcionales(r, umbral){
    return r.tradeLog.filter(t=>t.equityChangePct >= umbral).map(t=>{
      const direction = (s4H.aoState[t.entryIdx]==='Alcista' && s4H.koBull[t.entryIdx]) ? 'long' : 'short';
      const year = new Date(s4H.times[t.entryIdx]).getUTCFullYear();
      return { ...t, direction, year };
    });
  }

  [{nombre:'-0.8%', r:rTrail08}, {nombre:'-1.0%', r:rTrail10}].forEach(({nombre, r})=>{
    const excepcionales = operacionesExcepcionales(r, 3);
    console.log('\n--- Trailing ' + nombre + ': ' + excepcionales.length + ' operaciones excepcionales (≥+3% de cuenta) de ' + r.trades + ' totales (' + (excepcionales.length/r.trades*100).toFixed(2) + '%) ---');

    const porAnio = {};
    excepcionales.forEach(t=>{ porAnio[t.year] = (porAnio[t.year]||0) + 1; });
    console.log(pad('Año',8) + padL('Excepcionales',15));
    Object.keys(porAnio).map(Number).sort((a,b)=>a-b).forEach(year=>{
      console.log(pad(String(year),8) + padL(porAnio[year],15));
    });
    const aniosConAlguna = Object.keys(porAnio).length;
    console.log('Media por año (repartido entre los ' + aniosConAlguna + ' años que tuvieron alguna): ' + (excepcionales.length/aniosConAlguna).toFixed(1));

    const largas = excepcionales.filter(t=>t.direction==='long').length;
    const cortas = excepcionales.filter(t=>t.direction==='short').length;
    console.log('Dirección: largas (compra) ' + largas + ' (' + (largas/excepcionales.length*100).toFixed(1) + '%) · cortas (venta) ' + cortas + ' (' + (cortas/excepcionales.length*100).toFixed(1) + '%)');

    console.log('Detalle de cada una (año, dirección, resultado):');
    excepcionales.sort((a,b)=>a.entryIdx-b.entryIdx).forEach(t=>{
      console.log('  ' + t.year + ' · ' + (t.direction==='long'?'COMPRA':'VENTA') + ' · +' + t.equityChangePct.toFixed(2) + '%');
    });
  });

  // ---------- ANÁLISIS AU: perfil de indicadores de las operaciones excepcionales, y quién más comparte ese perfil ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS AU — Perfil de indicadores de las 26 operaciones excepcionales (trailing -1.0%), y quién más lo comparte');
  console.log('========================================');
  console.log('Para cada una de las 26 operaciones excepcionales, se listan sus indicadores en el momento de');
  console.log('entrar. Después se compara el perfil medio de las excepcionales contra el resto, y se comprueba');
  console.log('cuántas operaciones NO excepcionales comparten un perfil similar (para ver si es detectable).');

  const perfilOperaciones = rTrail10.tradeLog.map(t=>{
    const i = t.entryIdx;
    const direction = (s4H.aoState[i]==='Alcista' && s4H.koBull[i]) ? 'long' : 'short';
    const mlCoincide = direction==='long' ? mlSignal4H[i]==='Alcista' : mlSignal4H[i]==='Bajista';
    const larsiValor = isNaN(s4H.larsi[i]) ? NaN : s4H.larsi[i]*100;
    const larsiAlineado = isNaN(larsiValor) ? NaN : (direction==='long' ? larsiValor : (100-larsiValor));
    const tsFuerza = isNaN(s4H.trendspeed[i]) ? NaN : (direction==='long' ? s4H.trendspeed[i] : -s4H.trendspeed[i]);
    const cambiosAO = contarCambiosAO(s4H, i, 12);
    const year = new Date(s4H.times[i]).getUTCFullYear();
    return { equityChangePct:t.equityChangePct, direction, year, bbwp:s4H.bbwp[i], cambiosAO, mlCoincide, larsiAlineado, tsFuerza };
  });

  const excepcionalesConPerfil = perfilOperaciones.filter(o=>o.equityChangePct>=3);
  const restoConPerfil = perfilOperaciones.filter(o=>o.equityChangePct<3);

  console.log('\n--- Detalle de las 26 operaciones excepcionales: indicadores en el momento de entrar ---');
  console.log(pad('Año',6)+pad('Dir.',6)+padL('Result.',9)+padL('BBWP',7)+padL('CambiosAO',11)+padL('MLcoinc.',10)+padL('LaRSI',8)+padL('TrendSp.',11));
  excepcionalesConPerfil.forEach(o=>{
    console.log(pad(String(o.year),6)+pad(o.direction==='long'?'COMPRA':'VENTA',6)+padL('+'+o.equityChangePct.toFixed(1)+'%',9)+padL(o.bbwp.toFixed(0),7)+padL(o.cambiosAO,11)+padL(o.mlCoincide?'sí':'no',10)+padL(o.larsiAlineado.toFixed(0),8)+padL(o.tsFuerza.toFixed(0),11));
  });

  // (media y pctTrue ya están definidas más arriba, en el Análisis AM — se reutilizan aquí)

  console.log('\n--- Perfil medio: excepcionales vs resto ---');
  console.log(pad('Indicador',22)+padL('Excepcionales',15)+padL('Resto',12));
  console.log(pad('BBWP',22)+padL(media(excepcionalesConPerfil,'bbwp').toFixed(1),15)+padL(media(restoConPerfil,'bbwp').toFixed(1),12));
  console.log(pad('Cambios AO (12 velas)',22)+padL(media(excepcionalesConPerfil,'cambiosAO').toFixed(2),15)+padL(media(restoConPerfil,'cambiosAO').toFixed(2),12));
  console.log(pad('ML RSI coincide (%)',22)+padL(pctTrue(excepcionalesConPerfil,'mlCoincide').toFixed(1)+'%',15)+padL(pctTrue(restoConPerfil,'mlCoincide').toFixed(1)+'%',12));
  console.log(pad('LaRSI alineado',22)+padL(media(excepcionalesConPerfil,'larsiAlineado').toFixed(1),15)+padL(media(restoConPerfil,'larsiAlineado').toFixed(1),12));
  console.log(pad('Trend Speed alineado',22)+padL(media(excepcionalesConPerfil,'tsFuerza').toFixed(1),15)+padL(media(restoConPerfil,'tsFuerza').toFixed(1),12));

  console.log('\n--- Reparto largo/corto y por año, dentro de este mismo grupo excepcional ---');
  const excLargas = excepcionalesConPerfil.filter(o=>o.direction==='long').length;
  const excCortas = excepcionalesConPerfil.filter(o=>o.direction==='short').length;
  console.log('Largas: ' + excLargas + ' · Cortas: ' + excCortas);

  // ---------- ANÁLISIS AV: ¿la combinación BBWP≥90 + ML RSI coincide es una señal real, o la comparten muchas mediocres? ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS AV — ¿BBWP≥90 + ML RSI coincide distingue de verdad, o la comparten muchas operaciones mediocres?');
  console.log('========================================');
  console.log('18 de las 26 excepcionales (69%) tenían esta combinación. Aquí se comprueba cuántas operaciones');
  console.log('de TODAS las 1.510 (no solo las excepcionales) también la cumplen — y qué resultado tuvieron.');

  const conFirma = perfilOperaciones.filter(o=>o.bbwp>=90 && o.mlCoincide);
  const sinFirma = perfilOperaciones.filter(o=>!(o.bbwp>=90 && o.mlCoincide));
  const excepcionalesConComb = conFirma.filter(o=>o.equityChangePct>=3).length;
  const excepcionalesSinComb = sinFirma.filter(o=>o.equityChangePct>=3).length;

  console.log('\nOperaciones con BBWP≥90 + ML RSI coincide: ' + conFirma.length + ' de ' + perfilOperaciones.length + ' totales (' + (conFirma.length/perfilOperaciones.length*100).toFixed(1) + '%)');
  console.log('  De esas, ' + excepcionalesConComb + ' fueron excepcionales (≥+3%) — tasa: ' + (excepcionalesConComb/conFirma.length*100).toFixed(2) + '%');
  console.log('Operaciones SIN esa combinación: ' + sinFirma.length);
  console.log('  De esas, ' + excepcionalesSinComb + ' fueron excepcionales (≥+3%) — tasa: ' + (excepcionalesSinComb/sinFirma.length*100).toFixed(2) + '%');

  const mConComb = metricsForTradeSubset(conFirma.map(o=>({equityChangePct:o.equityChangePct})));
  const mSinComb = metricsForTradeSubset(sinFirma.map(o=>({equityChangePct:o.equityChangePct})));
  console.log('\n--- Resultado agregado de cada grupo (comparable con el Análisis AS) ---');
  console.log(pad('Grupo',20)+padL('Operac.',9)+padL('% Acierto',11)+padL('Retorno',14)+padL('P.Factor',10));
  console.log(pad('Con la combinación',20)+padL(mConComb.trades,9)+padL(mConComb.winRatePct.toFixed(1)+'%',11)+padL(fmtPct(mConComb.totalReturnPct),14)+padL(mConComb.profitFactor.toFixed(2),10));
  console.log(pad('Sin la combinación',20)+padL(mSinComb.trades,9)+padL(mSinComb.winRatePct.toFixed(1)+'%',11)+padL(fmtPct(mSinComb.totalReturnPct),14)+padL(mSinComb.profitFactor.toFixed(2),10));

  // ---------- ANÁLISIS AW: filtro real de la combinación BBWP≥90 + ML RSI sobre la 20/80 REAL ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS AW — Filtro real de BBWP≥90 + ML RSI coincide sobre la 20/80 real (mismo rigor que AF/AK/AN)');
  console.log('========================================');
  console.log('El hallazgo del Análisis AV se midió sobre el trailing -1.0%, no sobre la 20/80 real del bot.');
  console.log('Aquí se prueba la MISMA combinación como filtro real de entrada, sobre la configuración validada.');

  const filtroCombinado = (i, direction) => {
    const b = s4H.bbwp[i];
    if(isNaN(b)) return true;
    const mlOk = direction==='long' ? mlSignal4H[i]==='Alcista' : mlSignal4H[i]==='Bajista';
    return b>=90 && mlOk;
  };

  const rSinFiltroComb = simulateConfluenciaTPParcial(s4H, sD, 3, LEVERAGE, 0.12, 4, 0.20, false);
  const rConFiltroComb = simulateConfluenciaTPParcial(s4H, sD, 3, LEVERAGE, 0.12, 4, 0.20, false, filtroCombinado);

  console.log('\n--- Comparación directa (20/80, 12% capital, 5x) ---');
  console.log(pad('Variante',24)+padL('Operac.',9)+padL('% Acierto',11)+padL('Retorno',12)+padL('Drawdown',11)+padL('P.Factor',10));
  console.log(pad('Sin filtro combinado',24)+padL(rSinFiltroComb.trades,9)+padL(rSinFiltroComb.winRatePct.toFixed(1)+'%',11)+padL(fmtPct(rSinFiltroComb.totalReturnPct),12)+padL('-'+rSinFiltroComb.maxDrawdownPct.toFixed(1)+'%',11)+padL(rSinFiltroComb.profitFactor.toFixed(2),10));
  console.log(pad('Con filtro combinado',24)+padL(rConFiltroComb.trades,9)+padL(rConFiltroComb.winRatePct.toFixed(1)+'%',11)+padL(fmtPct(rConFiltroComb.totalReturnPct),12)+padL('-'+rConFiltroComb.maxDrawdownPct.toFixed(1)+'%',11)+padL(rConFiltroComb.profitFactor.toFixed(2),10));

  console.log('\n--- Walk-forward año por año, CON el filtro combinado ---');
  console.log(pad('Año',8)+padL('Operac.',9)+padL('% Acierto',11)+padL('Retorno',12)+padL('Drawdown',11)+padL('P.Factor',10));
  const bucketsComb = {};
  rConFiltroComb.tradeLog.forEach(t=>{
    const year = new Date(s4H.times[t.entryIdx]).getUTCFullYear();
    if(!bucketsComb[year]) bucketsComb[year] = [];
    bucketsComb[year].push(t);
  });
  let aniosPositivosComb=0, aniosTotalComb=0;
  Object.keys(bucketsComb).map(Number).sort((a,b)=>a-b).forEach(year=>{
    const m = metricsForTradeSubset(bucketsComb[year]);
    console.log(pad(String(year),8)+padL(m.trades,9)+padL(m.winRatePct.toFixed(1)+'%',11)+padL(fmtPct(m.totalReturnPct),12)+padL('-'+m.maxDrawdownPct.toFixed(1)+'%',11)+padL(m.profitFactor.toFixed(2),10));
    aniosTotalComb++;
    if(m.totalReturnPct>0) aniosPositivosComb++;
  });
  console.log('Años con retorno positivo: ' + aniosPositivosComb + ' de ' + aniosTotalComb);

  console.log('\n--- Validación fuera de muestra: últimos ' + MESES_RESERVADOS + ' meses reservados ---');
  const cutoffReservadoComb = ohlcv4H.times[ohlcv4H.times.length-1] - MESES_RESERVADOS*30*86400000;
  const tradesAntesComb = rConFiltroComb.tradeLog.filter(t => s4H.times[t.entryIdx] < cutoffReservadoComb);
  const tradesReservadoComb = rConFiltroComb.tradeLog.filter(t => s4H.times[t.entryIdx] >= cutoffReservadoComb);
  const mAntesComb = metricsForTradeSubset(tradesAntesComb);
  const mReservadoComb = metricsForTradeSubset(tradesReservadoComb);
  console.log(pad('Tramo',20)+padL('Operac.',9)+padL('% Acierto',11)+padL('Retorno',12)+padL('Drawdown',11)+padL('P.Factor',10));
  console.log(pad('Resto del histórico',20)+padL(mAntesComb.trades,9)+padL(mAntesComb.winRatePct.toFixed(1)+'%',11)+padL(fmtPct(mAntesComb.totalReturnPct),12)+padL('-'+mAntesComb.maxDrawdownPct.toFixed(1)+'%',11)+padL(mAntesComb.profitFactor.toFixed(2),10));
  console.log(pad('TRAMO RESERVADO',20)+padL(mReservadoComb.trades,9)+padL(mReservadoComb.winRatePct.toFixed(1)+'%',11)+padL(fmtPct(mReservadoComb.totalReturnPct),12)+padL('-'+mReservadoComb.maxDrawdownPct.toFixed(1)+'%',11)+padL(mReservadoComb.profitFactor.toFixed(2),10));

  // ---------- ANÁLISIS AX: ¿había también confluencia en el SEMANAL en las operaciones excepcionales? ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS AX — ¿Coincidía también el SEMANAL (AO+Koncorde) en las operaciones excepcionales, más que en el resto?');
  console.log('========================================');
  console.log('El Diario ya coincide siempre con el 4H (es requisito de entrada del propio bot). El Semanal NO');
  console.log('se comprueba nunca en la Confluencia actual — aquí se calcula por primera vez, para ver si las');
  console.log('operaciones excepcionales tenían, además, ese nivel extra de confirmación que el resto no tenía.');

  console.log('\nDescargando velas semanales (nunca usadas hasta ahora)...');
  const ohlcvSemanal = await fetchCandlesForMonths('1w', MESES_HISTORICO, 60);
  const sSemanal = computeFullSeries(ohlcvSemanal);
  console.log('Velas semanales: ' + sSemanal.n);

  const idxSemanalPara4H = alignDailyIndex(sSemanal, s4H.times);

  function semanalCoincide(entryIdx, direction){
    const iSem = idxSemanalPara4H[entryIdx];
    if(iSem<0) return false;
    return direction==='long'
      ? (sSemanal.aoState[iSem]==='Alcista' && sSemanal.koBull[iSem])
      : (sSemanal.aoState[iSem]==='Bajista' && sSemanal.koBear[iSem]);
  }

  const perfilConSemanal = rTrail10.tradeLog.map(t=>{
    const i = t.entryIdx;
    const direction = (s4H.aoState[i]==='Alcista' && s4H.koBull[i]) ? 'long' : 'short';
    return { equityChangePct:t.equityChangePct, direction, semanalCoincide: semanalCoincide(i, direction) };
  });

  const excepcionalesSem = perfilConSemanal.filter(o=>o.equityChangePct>=3);
  const restoSem = perfilConSemanal.filter(o=>o.equityChangePct<3);

  const pctExcConSemanal = excepcionalesSem.filter(o=>o.semanalCoincide).length / excepcionalesSem.length * 100;
  const pctRestoConSemanal = restoSem.filter(o=>o.semanalCoincide).length / restoSem.length * 100;

  console.log('\n--- ¿Cuántas tenían también el semanal a favor? ---');
  console.log('Excepcionales (' + excepcionalesSem.length + '): ' + excepcionalesSem.filter(o=>o.semanalCoincide).length + ' con semanal a favor (' + pctExcConSemanal.toFixed(1) + '%)');
  console.log('Resto (' + restoSem.length + '): ' + restoSem.filter(o=>o.semanalCoincide).length + ' con semanal a favor (' + pctRestoConSemanal.toFixed(1) + '%)');

  console.log('\n--- Detalle: de las excepcionales, ¿cuáles tenían el semanal a favor y cuáles no? ---');
  excepcionalesSem.forEach((o,idx)=>{
    console.log('  #' + (idx+1) + ' (' + (o.direction==='long'?'COMPRA':'VENTA') + ', +' + o.equityChangePct.toFixed(1) + '%): semanal ' + (o.semanalCoincide?'SÍ coincidía':'no coincidía'));
  });

  // ---------- ANÁLISIS AY: la combinación BBWP+ML RSI, aplicada a entradas de 1H (no 4H) ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS AY — La combinación BBWP≥90 + ML RSI, aplicada como filtro sobre entradas de 1H (confirmadas por 4H)');
  console.log('========================================');
  console.log('El 1H "en bruto" fallaba por exceso de comisiones (Análisis AA). Aquí se prueba si, exigiendo');
  console.log('la misma combinación exigente que en el Análisis AW (esta vez calculada sobre el propio 1H),');
  console.log('el 1H se queda solo con entradas de calidad suficiente para compensar esa desventaja.');

  const filtroCombinado1H = (i, direction) => {
    const b = s.bbwp[i];
    if(isNaN(b)) return true;
    const mlOk = direction==='long' ? mlSignal[i]==='Alcista' : mlSignal[i]==='Bajista';
    return b>=90 && mlOk;
  };

  console.log('\n--- Comparación: 1H confirmado por 4H, sin filtro vs con el filtro combinado ---');
  console.log(pad('Variante',24)+padL('Operac.',9)+padL('% Acierto',11)+padL('Retorno',12)+padL('Drawdown',11)+padL('P.Factor',10));
  const r1HSinFiltro = simulateConfluenciaTPParcial(s, s4H, 3, LEVERAGE, 0.12, 1, 0.20, false);
  const r1HConFiltro = simulateConfluenciaTPParcial(s, s4H, 3, LEVERAGE, 0.12, 1, 0.20, false, filtroCombinado1H);
  console.log(pad('1H sin filtro',24)+padL(r1HSinFiltro.trades,9)+padL(r1HSinFiltro.winRatePct.toFixed(1)+'%',11)+padL(fmtPct(r1HSinFiltro.totalReturnPct),12)+padL('-'+r1HSinFiltro.maxDrawdownPct.toFixed(1)+'%',11)+padL(r1HSinFiltro.profitFactor.toFixed(2),10));
  console.log(pad('1H con filtro combinado',24)+padL(r1HConFiltro.trades,9)+padL(r1HConFiltro.winRatePct.toFixed(1)+'%',11)+padL(fmtPct(r1HConFiltro.totalReturnPct),12)+padL('-'+r1HConFiltro.maxDrawdownPct.toFixed(1)+'%',11)+padL(r1HConFiltro.profitFactor.toFixed(2),10));
  console.log('\n(referencia, misma configuración en 4H, Análisis AW): sin filtro 404 operac. +461.42% PF 2.13 · con filtro 120 operac. +92.36% PF 2.27');

  console.log('\n--- Walk-forward año por año, 1H con el filtro combinado ---');
  console.log(pad('Año',8)+padL('Operac.',9)+padL('% Acierto',11)+padL('Retorno',12)+padL('Drawdown',11)+padL('P.Factor',10));
  const buckets1HComb = {};
  r1HConFiltro.tradeLog.forEach(t=>{
    const year = new Date(s.times[t.entryIdx]).getUTCFullYear();
    if(!buckets1HComb[year]) buckets1HComb[year] = [];
    buckets1HComb[year].push(t);
  });
  let aniosPositivos1HComb=0, aniosTotal1HComb=0;
  Object.keys(buckets1HComb).map(Number).sort((a,b)=>a-b).forEach(year=>{
    const m = metricsForTradeSubset(buckets1HComb[year]);
    console.log(pad(String(year),8)+padL(m.trades,9)+padL(m.winRatePct.toFixed(1)+'%',11)+padL(fmtPct(m.totalReturnPct),12)+padL('-'+m.maxDrawdownPct.toFixed(1)+'%',11)+padL(m.profitFactor.toFixed(2),10));
    aniosTotal1HComb++;
    if(m.totalReturnPct>0) aniosPositivos1HComb++;
  });
  console.log('Años con retorno positivo: ' + aniosPositivos1HComb + ' de ' + aniosTotal1HComb);

  console.log('\n--- Validación fuera de muestra: últimos ' + MESES_RESERVADOS + ' meses reservados, 1H con filtro combinado ---');
  const cutoffReservado1HComb = ohlcv.times[ohlcv.times.length-1] - MESES_RESERVADOS*30*86400000;
  const tradesAntes1HComb = r1HConFiltro.tradeLog.filter(t => s.times[t.entryIdx] < cutoffReservado1HComb);
  const tradesReservado1HComb = r1HConFiltro.tradeLog.filter(t => s.times[t.entryIdx] >= cutoffReservado1HComb);
  const mAntes1HComb = metricsForTradeSubset(tradesAntes1HComb);
  const mReservado1HComb = metricsForTradeSubset(tradesReservado1HComb);
  console.log(pad('Tramo',20)+padL('Operac.',9)+padL('% Acierto',11)+padL('Retorno',12)+padL('Drawdown',11)+padL('P.Factor',10));
  console.log(pad('Resto del histórico',20)+padL(mAntes1HComb.trades,9)+padL(mAntes1HComb.winRatePct.toFixed(1)+'%',11)+padL(fmtPct(mAntes1HComb.totalReturnPct),12)+padL('-'+mAntes1HComb.maxDrawdownPct.toFixed(1)+'%',11)+padL(mAntes1HComb.profitFactor.toFixed(2),10));
  console.log(pad('TRAMO RESERVADO',20)+padL(mReservado1HComb.trades,9)+padL(mReservado1HComb.winRatePct.toFixed(1)+'%',11)+padL(fmtPct(mReservado1HComb.totalReturnPct),12)+padL('-'+mReservado1HComb.maxDrawdownPct.toFixed(1)+'%',11)+padL(mReservado1HComb.profitFactor.toFixed(2),10));

  // ---------- ANÁLISIS AZ: tamaño de posición VARIABLE según BBWP+ML RSI, sin excluir ninguna operación ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS AZ — Tamaño de posición variable (pesar, no excluir): más capital cuando BBWP≥90+ML RSI coincide');
  console.log('========================================');
  console.log('Se mantienen las 404 operaciones de la 20/80 (nada se descarta) — solo cambia cuánto capital se');
  console.log('arriesga en cada una: más cuando se cumple la combinación de calidad, menos cuando no se cumple.');
  console.log('Se prueban varios repartos, todos con una media parecida al 12% actual, para comparar en igualdad.');

  function fraccionSegunCombinacion(fraccionAlta, fraccionBaja){
    return (i, direction) => {
      const b = s4H.bbwp[i];
      const mlOk = direction==='long' ? mlSignal4H[i]==='Alcista' : mlSignal4H[i]==='Bajista';
      const cumpleCombinacion = !isNaN(b) && b>=90 && mlOk;
      return cumpleCombinacion ? fraccionAlta : fraccionBaja;
    };
  }

  console.log('\n' + pad('Reparto',16) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',14) + padL('Drawdown',11) + padL('P.Factor',10));
  const rBaseAZ = simulateConfluenciaTPParcial(s4H, sD, 3, LEVERAGE, 0.12, 4, 0.20, false);
  console.log(pad('(fijo 12%, actual)',16) + padL(rBaseAZ.trades,9) + padL(rBaseAZ.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(rBaseAZ.totalReturnPct),14) + padL('-'+rBaseAZ.maxDrawdownPct.toFixed(1)+'%',11) + padL(rBaseAZ.profitFactor.toFixed(2),10));

  const repartos = [[16,10],[20,8],[24,6],[30,4],[40,2]];
  const resultadosAZ = {};
  repartos.forEach(([alta,baja])=>{
    const fn = fraccionSegunCombinacion(alta/100, baja/100);
    const r = simulateConfluenciaTPParcial(s4H, sD, 3, LEVERAGE, 0.12, 4, 0.20, false, undefined, undefined, undefined, fn);
    resultadosAZ[alta+'/'+baja] = r;
    console.log(pad(alta+'%/'+baja+'%',16) + padL(r.trades,9) + padL(r.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(r.totalReturnPct),14) + padL('-'+r.maxDrawdownPct.toFixed(1)+'%',11) + padL(r.profitFactor.toFixed(2),10));
  });

  // ---------- ANÁLISIS BA: validación rigurosa del reparto 24%/6% (el mejor punto del Análisis AZ) ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS BA — Validación rigurosa del tamaño de posición variable 24%/6% (mismo rigor que AF/AK/AN/AW)');
  console.log('========================================');
  console.log('El reparto 24%/6% maximizaba la relación Retorno/Drawdown en el Análisis AZ, sin excluir ninguna');
  console.log('operación. Aquí se somete al mismo walk-forward + fuera de muestra que el resto de hallazgos de hoy.');

  const fnMejorReparto = fraccionSegunCombinacion(0.24, 0.06);
  const rBA = simulateConfluenciaTPParcial(s4H, sD, 3, LEVERAGE, 0.12, 4, 0.20, false, undefined, undefined, undefined, fnMejorReparto);

  console.log('\n--- Walk-forward año por año, reparto 24%/6% ---');
  console.log(pad('Año',8) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',14) + padL('Drawdown',11) + padL('P.Factor',10));
  const bucketsBA = {};
  rBA.tradeLog.forEach(t=>{
    const year = new Date(s4H.times[t.entryIdx]).getUTCFullYear();
    if(!bucketsBA[year]) bucketsBA[year] = [];
    bucketsBA[year].push(t);
  });
  let aniosPositivosBA=0, aniosTotalBA=0;
  Object.keys(bucketsBA).map(Number).sort((a,b)=>a-b).forEach(year=>{
    const m = metricsForTradeSubset(bucketsBA[year]);
    console.log(pad(String(year),8) + padL(m.trades,9) + padL(m.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(m.totalReturnPct),14) + padL('-'+m.maxDrawdownPct.toFixed(1)+'%',11) + padL(m.profitFactor.toFixed(2),10));
    aniosTotalBA++;
    if(m.totalReturnPct>0) aniosPositivosBA++;
  });
  console.log('Años con retorno positivo: ' + aniosPositivosBA + ' de ' + aniosTotalBA);

  console.log('\n--- Validación fuera de muestra: últimos ' + MESES_RESERVADOS + ' meses reservados, reparto 24%/6% ---');
  const cutoffReservadoBA = ohlcv4H.times[ohlcv4H.times.length-1] - MESES_RESERVADOS*30*86400000;
  const tradesAntesBA = rBA.tradeLog.filter(t => s4H.times[t.entryIdx] < cutoffReservadoBA);
  const tradesReservadoBA = rBA.tradeLog.filter(t => s4H.times[t.entryIdx] >= cutoffReservadoBA);
  const mAntesBA = metricsForTradeSubset(tradesAntesBA);
  const mReservadoBA = metricsForTradeSubset(tradesReservadoBA);
  console.log(pad('Tramo',20) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',14) + padL('Drawdown',11) + padL('P.Factor',10));
  console.log(pad('Resto del histórico',20) + padL(mAntesBA.trades,9) + padL(mAntesBA.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(mAntesBA.totalReturnPct),14) + padL('-'+mAntesBA.maxDrawdownPct.toFixed(1)+'%',11) + padL(mAntesBA.profitFactor.toFixed(2),10));
  console.log(pad('TRAMO RESERVADO',20) + padL(mReservadoBA.trades,9) + padL(mReservadoBA.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(mReservadoBA.totalReturnPct),14) + padL('-'+mReservadoBA.maxDrawdownPct.toFixed(1)+'%',11) + padL(mReservadoBA.profitFactor.toFixed(2),10));

  // ---------- ANÁLISIS BB: el mismo tamaño de posición variable, con BBWP≥50% en vez de BBWP≥90% ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS BB — Tamaño de posición variable con BBWP≥50% (en vez de 90%) + ML RSI');
  console.log('========================================');
  console.log('Mismo mecanismo que el Análisis AZ/BA, cambiando solo el umbral de BBWP — un umbral más bajo');
  console.log('significa que la condición "de calidad" se cumple con mucha más frecuencia (más operaciones');
  console.log('reciben la fracción alta), lo que en principio debería suavizar el efecto, para bien o para mal.');

  function fraccionSegunCombinacionUmbral(fraccionAlta, fraccionBaja, umbralBBWP){
    return (i, direction) => {
      const b = s4H.bbwp[i];
      const mlOk = direction==='long' ? mlSignal4H[i]==='Alcista' : mlSignal4H[i]==='Bajista';
      const cumpleCombinacion = !isNaN(b) && b>=umbralBBWP && mlOk;
      return cumpleCombinacion ? fraccionAlta : fraccionBaja;
    };
  }

  // Primero, ¿a cuántas operaciones afecta el umbral más bajo? (para poner el resultado en contexto)
  let cuentaUmbral50 = 0, cuentaUmbral90 = 0;
  rBaseAZ.tradeLog.forEach(t=>{
    const i = t.entryIdx;
    const direction = (s4H.aoState[i]==='Alcista' && s4H.koBull[i]) ? 'long' : 'short';
    const mlOk = direction==='long' ? mlSignal4H[i]==='Alcista' : mlSignal4H[i]==='Bajista';
    const b = s4H.bbwp[i];
    if(!isNaN(b) && b>=50 && mlOk) cuentaUmbral50++;
    if(!isNaN(b) && b>=90 && mlOk) cuentaUmbral90++;
  });
  console.log('\nOperaciones que reciben la fracción ALTA: con BBWP≥90 → ' + cuentaUmbral90 + ' de ' + rBaseAZ.trades + ' · con BBWP≥50 → ' + cuentaUmbral50 + ' de ' + rBaseAZ.trades);

  console.log('\n' + pad('Reparto',16) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',14) + padL('Drawdown',11) + padL('P.Factor',10) + padL('Ret/DD',9));
  console.log(pad('(fijo 12%, actual)',16) + padL(rBaseAZ.trades,9) + padL(rBaseAZ.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(rBaseAZ.totalReturnPct),14) + padL('-'+rBaseAZ.maxDrawdownPct.toFixed(1)+'%',11) + padL(rBaseAZ.profitFactor.toFixed(2),10) + padL((rBaseAZ.totalReturnPct/rBaseAZ.maxDrawdownPct).toFixed(1),9));

  repartos.forEach(([alta,baja])=>{
    const fn = fraccionSegunCombinacionUmbral(alta/100, baja/100, 50);
    const r = simulateConfluenciaTPParcial(s4H, sD, 3, LEVERAGE, 0.12, 4, 0.20, false, undefined, undefined, undefined, fn);
    console.log(pad(alta+'%/'+baja+'%',16) + padL(r.trades,9) + padL(r.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(r.totalReturnPct),14) + padL('-'+r.maxDrawdownPct.toFixed(1)+'%',11) + padL(r.profitFactor.toFixed(2),10) + padL((r.totalReturnPct/r.maxDrawdownPct).toFixed(1),9));
  });

  console.log('\n(referencia, con BBWP≥90, Análisis AZ): 16/10 Ret/DD=67.7 · 20/8=71.6 · 24/6=72.9 · 30/4=69.2 · 40/2=53.9');

  // ---------- ANÁLISIS BC: tamaño de posición variable, aplicado a entradas de 1H (confirmadas por 4H) ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS BC — Tamaño de posición variable (BBWP≥90+ML RSI, calculado en 1H) sobre entradas de 1H');
  console.log('========================================');
  console.log('El filtro (excluir) en 1H fallaba (Análisis AY). Aquí se prueba PESAR en vez de excluir —');
  console.log('mismo principio que funcionó en 4H (Análisis AZ/BA), esta vez sobre la señal base de 1H.');

  function fraccionSegunCombinacion1H(fraccionAlta, fraccionBaja, umbralBBWP){
    return (i, direction) => {
      const b = s.bbwp[i];
      const mlOk = direction==='long' ? mlSignal[i]==='Alcista' : mlSignal[i]==='Bajista';
      const cumpleCombinacion = !isNaN(b) && b>=umbralBBWP && mlOk;
      return cumpleCombinacion ? fraccionAlta : fraccionBaja;
    };
  }

  const rBase1HBC = simulateConfluenciaTPParcial(s, s4H, 3, LEVERAGE, 0.12, 1, 0.20, false);
  console.log('\nBase 1H (12% fijo, sin ningún filtro ni peso): ' + rBase1HBC.trades + ' operaciones · ' + fmtPct(rBase1HBC.totalReturnPct) + ' · Drawdown -' + rBase1HBC.maxDrawdownPct.toFixed(1) + '% · P.Factor ' + rBase1HBC.profitFactor.toFixed(2));

  console.log('\n' + pad('Reparto',16) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',14) + padL('Drawdown',11) + padL('P.Factor',10) + padL('Ret/DD',9));
  console.log(pad('(fijo 12%)',16) + padL(rBase1HBC.trades,9) + padL(rBase1HBC.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(rBase1HBC.totalReturnPct),14) + padL('-'+rBase1HBC.maxDrawdownPct.toFixed(1)+'%',11) + padL(rBase1HBC.profitFactor.toFixed(2),10) + padL((rBase1HBC.totalReturnPct/rBase1HBC.maxDrawdownPct).toFixed(1),9));

  [[16,10],[20,8],[24,6],[30,4],[40,2]].forEach(([alta,baja])=>{
    const fn = fraccionSegunCombinacion1H(alta/100, baja/100, 90);
    const r = simulateConfluenciaTPParcial(s, s4H, 3, LEVERAGE, 0.12, 1, 0.20, false, undefined, undefined, undefined, fn);
    console.log(pad(alta+'%/'+baja+'%',16) + padL(r.trades,9) + padL(r.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(r.totalReturnPct),14) + padL('-'+r.maxDrawdownPct.toFixed(1)+'%',11) + padL(r.profitFactor.toFixed(2),10) + padL((r.totalReturnPct/r.maxDrawdownPct).toFixed(1),9));
  });

  console.log('\n(referencia, mismo mecanismo en 4H, Análisis AZ): 24%/6% → Retorno +1057.42% · Drawdown -14.5% · Ret/DD=72.9');

  // ---------- ANÁLISIS BD: PROYECTO NUEVO — ¿qué indicadores predicen mejor un movimiento rápido en 15M y 1H? ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS BD — Proyecto nuevo desde cero: poder predictivo de cada indicador por separado, en 15M y 1H');
  console.log('========================================');
  console.log('Objetivo: entradas cortas, +2% de precio (+10% a 5x) y salir. Para cada indicador, medido por');
  console.log('separado (sin exigir que coincidan varios a la vez), se comprueba: cuando dispara, ¿el precio');
  console.log('llega antes a +2% a favor o a -2% en contra? Ventana: 40 velas. Sin confirmación de temporalidad');
  console.log('superior — cada temporalidad se evalúa de forma completamente independiente.');

  const TARGET_PCT = 2, STOP_PCT = 2, MAX_BARS = 40;

  console.log('\nDescargando velas de 15M (24 meses, para mantener el tiempo de cálculo razonable)...');
  const ohlcv15MBD = await fetchCandlesForMonths('15m', 24, 300);
  const s15MBD = computeFullSeries(ohlcv15MBD);
  console.log('Calculando ML RSI en 15M...');
  const mlSignal15MBD = computeMLRSISeries(s15MBD.closes);
  console.log('Velas 15M: ' + s15MBD.n);

  const disparadores15M = construirDisparadores(s15MBD, mlSignal15MBD);
  const disparadores1H = construirDisparadores(s, mlSignal);

  function evaluarIndicador(series, disparo, direction, target, stop, maxBars){
    const resultados = carreraHaciaObjetivo(series, disparo, direction, target, stop, maxBars);
    const resueltos = resultados.filter(r=>r.resultado!==null);
    const ganadas = resueltos.filter(r=>r.resultado===true);
    const mediaBarras = ganadas.length ? ganadas.reduce((a,r)=>a+r.barsHasta,0)/ganadas.length : NaN;
    return {
      disparos: resultados.length,
      resueltos: resueltos.length,
      winRate: resueltos.length ? ganadas.length/resueltos.length*100 : NaN,
      mediaBarras
    };
  }

  console.log('\n--- Resultado por indicador y temporalidad (objetivo ±2%, ventana 40 velas) ---');
  console.log(pad('Indicador',18) + pad('Temp.',7) + pad('Dir.',6) + padL('Disparos',10) + padL('% Acierto',11) + padL('Velas medias',13));
  const nombresIndicadores = ['AO','Koncorde','ADX (cruce DI)','BBWP (despierta)','LaRSI','Trend Speed','ML RSI'];
  nombresIndicadores.forEach(nombre=>{
    ['long','short'].forEach(direccion=>{
      const e15 = evaluarIndicador(s15MBD, disparadores15M[nombre][direccion], direccion, TARGET_PCT, STOP_PCT, MAX_BARS);
      const e1h = evaluarIndicador(s, disparadores1H[nombre][direccion], direccion, TARGET_PCT, STOP_PCT, MAX_BARS);
      console.log(pad(nombre,18) + pad('15M',7) + pad(direccion==='long'?'Largo':'Corto',6) + padL(e15.disparos,10) + padL(isNaN(e15.winRate)?'—':e15.winRate.toFixed(1)+'%',11) + padL(isNaN(e15.mediaBarras)?'—':e15.mediaBarras.toFixed(1),13));
      console.log(pad('',18) + pad('1H',7) + pad(direccion==='long'?'Largo':'Corto',6) + padL(e1h.disparos,10) + padL(isNaN(e1h.winRate)?'—':e1h.winRate.toFixed(1)+'%',11) + padL(isNaN(e1h.mediaBarras)?'—':e1h.mediaBarras.toFixed(1),13));
    });
  });
  console.log('\n(referencia: 50% de acierto sería el punto de equilibrio con objetivo y stop simétricos — por');
  console.log('encima indica poder predictivo real; por debajo, que el indicador acierta menos que el azar)');

  // ---------- ANÁLISIS BE: señal combinada — impulso en 15M + retroceso completándose en 1H ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS BE — Señal combinada: impulso en 15M + retroceso completándose en 1H');
  console.log('========================================');
  console.log('15M (impulso): Koncorde DENTRO de la zona amarilla + AO/ADX mostrando impulso + BBWP>50.');
  console.log('1H (retroceso completándose, en las últimas 4 horas): Koncorde ENTRANDO en la zona amarilla +');
  console.log('AO cerca de cero + BBWP acercándose a 50 desde abajo. Se prueba con la misma carrera ±2% que el');
  console.log('Análisis BD, para comparar directamente contra los indicadores sueltos.');

  function impulso15M(i, direction){
    return dentroZonaAmarilla(s15MBD, i, direction)
      && (direction==='long' ? s15MBD.aoState[i]==='Alcista' : s15MBD.aoState[i]==='Bajista')
      && s15MBD.adxSubiendo[i]
      && s15MBD.bbwp[i]>50;
  }
  function retroceso1H(j, direction){
    return entrandoZonaAmarilla(s, j, direction)
      && aoCercaDeCero(s, j, 50, 0.35)
      && bbwpAcercandoseA(s, j, 50, 15, 3);
  }

  const idx1HPara15M = alignDailyIndex(s, s15MBD.times);
  const VENTANA_RETROCESO_HORAS = 4;

  function retrocesoRecienteEn1H(i15M, direction){
    const j = idx1HPara15M[i15M];
    if(j<0) return false;
    const desde = Math.max(0, j - VENTANA_RETROCESO_HORAS);
    for(let k=desde; k<=j; k++){ if(retroceso1H(k, direction)) return true; }
    return false;
  }

  const disparoLargo = new Array(s15MBD.n).fill(false), disparoCorto = new Array(s15MBD.n).fill(false);
  for(let i=0;i<s15MBD.n;i++){
    if(impulso15M(i,'long') && retrocesoRecienteEn1H(i,'long')) disparoLargo[i]=true;
    if(impulso15M(i,'short') && retrocesoRecienteEn1H(i,'short')) disparoCorto[i]=true;
  }

  const numDisparosLargo = disparoLargo.filter(Boolean).length;
  const numDisparosCorto = disparoCorto.filter(Boolean).length;
  console.log('\nDisparos encontrados: ' + numDisparosLargo + ' largos, ' + numDisparosCorto + ' cortos (de ' + s15MBD.n + ' velas de 15M)');

  const evalLargo = evaluarIndicador(s15MBD, disparoLargo, 'long', TARGET_PCT, STOP_PCT, MAX_BARS);
  const evalCorto = evaluarIndicador(s15MBD, disparoCorto, 'short', TARGET_PCT, STOP_PCT, MAX_BARS);
  console.log('\n' + pad('Dirección',10) + padL('Disparos',10) + padL('Resueltos',11) + padL('% Acierto',11) + padL('Velas medias',13));
  console.log(pad('Largo',10) + padL(evalLargo.disparos,10) + padL(evalLargo.resueltos,11) + padL(isNaN(evalLargo.winRate)?'—':evalLargo.winRate.toFixed(1)+'%',11) + padL(isNaN(evalLargo.mediaBarras)?'—':evalLargo.mediaBarras.toFixed(1),13));
  console.log(pad('Corto',10) + padL(evalCorto.disparos,10) + padL(evalCorto.resueltos,11) + padL(isNaN(evalCorto.winRate)?'—':evalCorto.winRate.toFixed(1)+'%',11) + padL(isNaN(evalCorto.mediaBarras)?'—':evalCorto.mediaBarras.toFixed(1),13));
  console.log('\n(referencia: 50% es el punto de equilibrio; comparar contra los indicadores sueltos del Análisis BD)');

  // ---------- ANÁLISIS BF: ampliar la ventana del retroceso en 1H (4h → 8h → 12h) ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS BF — Misma señal combinada, ampliando la ventana del retroceso en 1H (para conseguir muestra)');
  console.log('========================================');
  console.log('Con 4 horas de ventana solo había 7 disparos largos y 4 cortos — insuficiente para confiar en');
  console.log('el resultado. Se prueba con 8 y 12 horas, para ver cuánto crece la muestra y si el % de acierto');
  console.log('se mantiene parecido o cambia mucho al tener más casos.');

  function retrocesoRecienteEn1HVentana(i15M, direction, ventanaHoras){
    const j = idx1HPara15M[i15M];
    if(j<0) return false;
    const desde = Math.max(0, j - ventanaHoras);
    for(let k=desde; k<=j; k++){ if(retroceso1H(k, direction)) return true; }
    return false;
  }

  [4, 8, 12].forEach(ventanaHoras=>{
    const dLargo = new Array(s15MBD.n).fill(false), dCorto = new Array(s15MBD.n).fill(false);
    for(let i=0;i<s15MBD.n;i++){
      if(impulso15M(i,'long') && retrocesoRecienteEn1HVentana(i,'long',ventanaHoras)) dLargo[i]=true;
      if(impulso15M(i,'short') && retrocesoRecienteEn1HVentana(i,'short',ventanaHoras)) dCorto[i]=true;
    }
    const eLargo = evaluarIndicador(s15MBD, dLargo, 'long', TARGET_PCT, STOP_PCT, MAX_BARS);
    const eCorto = evaluarIndicador(s15MBD, dCorto, 'short', TARGET_PCT, STOP_PCT, MAX_BARS);
    console.log('\n--- Ventana de ' + ventanaHoras + ' horas ---');
    console.log(pad('Dirección',10) + padL('Disparos',10) + padL('Resueltos',11) + padL('% Acierto',11) + padL('Velas medias',13));
    console.log(pad('Largo',10) + padL(eLargo.disparos,10) + padL(eLargo.resueltos,11) + padL(isNaN(eLargo.winRate)?'—':eLargo.winRate.toFixed(1)+'%',11) + padL(isNaN(eLargo.mediaBarras)?'—':eLargo.mediaBarras.toFixed(1),13));
    console.log(pad('Corto',10) + padL(eCorto.disparos,10) + padL(eCorto.resueltos,11) + padL(isNaN(eCorto.winRate)?'—':eCorto.winRate.toFixed(1)+'%',11) + padL(isNaN(eCorto.mediaBarras)?'—':eCorto.mediaBarras.toFixed(1),13));
  });

  // ---------- ANÁLISIS BG: comparación automática de las tres ventanas, con diagnóstico calculado (no leído a ojo) ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS BG — Comparación automática de las tres ventanas, con el diagnóstico ya calculado en el código');
  console.log('========================================');
  console.log('El propio análisis decide y declara si la muestra es suficiente y si el resultado es estable —');
  console.log('no hace falta leer tablas sueltas ni comparar números a ojo.');

  const UMBRAL_MUESTRA_MINIMA = 20; // operaciones resueltas (largo+corto juntas) para considerar la muestra fiable
  const UMBRAL_ESTABILIDAD_PUNTOS = 15; // diferencia máxima de % de acierto entre ventanas para considerarlo estable

  const resumenBG = [4, 8, 12].map(ventanaHoras=>{
    const dLargo = new Array(s15MBD.n).fill(false), dCorto = new Array(s15MBD.n).fill(false);
    for(let i=0;i<s15MBD.n;i++){
      if(impulso15M(i,'long') && retrocesoRecienteEn1HVentana(i,'long',ventanaHoras)) dLargo[i]=true;
      if(impulso15M(i,'short') && retrocesoRecienteEn1HVentana(i,'short',ventanaHoras)) dCorto[i]=true;
    }
    const eLargo = evaluarIndicador(s15MBD, dLargo, 'long', TARGET_PCT, STOP_PCT, MAX_BARS);
    const eCorto = evaluarIndicador(s15MBD, dCorto, 'short', TARGET_PCT, STOP_PCT, MAX_BARS);
    const resueltosTotal = eLargo.resueltos + eCorto.resueltos;
    const ganadasTotal = Math.round(eLargo.resueltos*(isNaN(eLargo.winRate)?0:eLargo.winRate)/100) + Math.round(eCorto.resueltos*(isNaN(eCorto.winRate)?0:eCorto.winRate)/100);
    const winRateTotal = resueltosTotal>0 ? ganadasTotal/resueltosTotal*100 : NaN;
    return { ventanaHoras, eLargo, eCorto, resueltosTotal, winRateTotal };
  });

  console.log('\n--- Diagnóstico por ventana (calculado, no leído a ojo) ---');
  resumenBG.forEach(r=>{
    const muestraOk = r.resueltosTotal >= UMBRAL_MUESTRA_MINIMA;
    console.log('\nVentana ' + r.ventanaHoras + 'h: ' + r.resueltosTotal + ' operaciones resueltas en total (largo+corto) → ' +
      (muestraOk ? 'MUESTRA SUFICIENTE' : 'MUESTRA INSUFICIENTE (mínimo recomendado: ' + UMBRAL_MUESTRA_MINIMA + ')'));
    console.log('  % de acierto conjunto: ' + (isNaN(r.winRateTotal) ? '—' : r.winRateTotal.toFixed(1)+'%') +
      ' (largo: ' + (isNaN(r.eLargo.winRate)?'—':r.eLargo.winRate.toFixed(1)+'%') + ' con ' + r.eLargo.resueltos + ' · corto: ' +
      (isNaN(r.eCorto.winRate)?'—':r.eCorto.winRate.toFixed(1)+'%') + ' con ' + r.eCorto.resueltos + ')');
  });

  const ventanasConMuestra = resumenBG.filter(r=>r.resueltosTotal >= UMBRAL_MUESTRA_MINIMA && !isNaN(r.winRateTotal));
  console.log('\n--- Conclusión automática ---');
  if(ventanasConMuestra.length===0){
    console.log('NINGUNA ventana alcanza la muestra mínima de ' + UMBRAL_MUESTRA_MINIMA + ' operaciones resueltas.');
    console.log('No se puede evaluar la estabilidad todavía — haría falta relajar más la definición o ampliar el histórico.');
  } else if(ventanasConMuestra.length===1){
    console.log('Solo la ventana de ' + ventanasConMuestra[0].ventanaHoras + 'h alcanza muestra suficiente (' + ventanasConMuestra[0].resueltosTotal + ' operaciones), con ' + ventanasConMuestra[0].winRateTotal.toFixed(1) + '% de acierto.');
    console.log('No hay más de una ventana para comparar estabilidad todavía.');
  } else {
    const tasas = ventanasConMuestra.map(r=>r.winRateTotal);
    const diferencia = Math.max(...tasas) - Math.min(...tasas);
    const esEstable = diferencia <= UMBRAL_ESTABILIDAD_PUNTOS;
    console.log('Ventanas con muestra suficiente: ' + ventanasConMuestra.map(r=>r.ventanaHoras+'h ('+r.winRateTotal.toFixed(1)+'%)').join(', '));
    console.log('Diferencia entre la más alta y la más baja: ' + diferencia.toFixed(1) + ' puntos → ' +
      (esEstable ? 'ESTABLE (por debajo del umbral de ' + UMBRAL_ESTABILIDAD_PUNTOS + ' puntos)' : 'INESTABLE (por encima del umbral de ' + UMBRAL_ESTABILIDAD_PUNTOS + ' puntos — el resultado cambia demasiado según la ventana elegida)'));
  }

  // ---------- ANÁLISIS BH: retroceso en 1H con solo 2 condiciones (sin AO cerca de cero) + 48 meses de 15M ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS BH — Retroceso en 1H con solo 2 condiciones (se quita el AO cerca de cero) + 48 meses de 15M');
  console.log('========================================');
  console.log('1H (retroceso, ahora con 2 condiciones en vez de 3): Koncorde entrando en la zona amarilla +');
  console.log('BBWP acercándose a 50 desde abajo. 15M (impulso) se mantiene igual, con sus 3 condiciones.');

  console.log('\nDescargando 48 meses de velas de 15M (el doble que antes)...');
  const ohlcv15MBH = await fetchCandlesForMonths('15m', 48, 300);
  const s15MBH = computeFullSeries(ohlcv15MBH);
  console.log('Velas 15M: ' + s15MBH.n + ' (antes, con 24 meses: ' + s15MBD.n + ')');

  function impulso15M_BH(series, i, direction){
    return dentroZonaAmarilla(series, i, direction)
      && (direction==='long' ? series.aoState[i]==='Alcista' : series.aoState[i]==='Bajista')
      && series.adxSubiendo[i]
      && series.bbwp[i]>50;
  }
  function retroceso1H_2cond(j, direction){
    return entrandoZonaAmarilla(s, j, direction)
      && bbwpAcercandoseA(s, j, 50, 15, 3);
  }
  const idx1HPara15M_BH = alignDailyIndex(s, s15MBH.times);
  function retrocesoRecienteEn1H_2cond(i15M, direction, ventanaHoras){
    const j = idx1HPara15M_BH[i15M];
    if(j<0) return false;
    const desde = Math.max(0, j - ventanaHoras);
    for(let k=desde; k<=j; k++){ if(retroceso1H_2cond(k, direction)) return true; }
    return false;
  }

  const resumenBH = [4, 8, 12].map(ventanaHoras=>{
    const dLargo = new Array(s15MBH.n).fill(false), dCorto = new Array(s15MBH.n).fill(false);
    for(let i=0;i<s15MBH.n;i++){
      if(impulso15M_BH(s15MBH,i,'long') && retrocesoRecienteEn1H_2cond(i,'long',ventanaHoras)) dLargo[i]=true;
      if(impulso15M_BH(s15MBH,i,'short') && retrocesoRecienteEn1H_2cond(i,'short',ventanaHoras)) dCorto[i]=true;
    }
    const eLargo = evaluarIndicador(s15MBH, dLargo, 'long', TARGET_PCT, STOP_PCT, MAX_BARS);
    const eCorto = evaluarIndicador(s15MBH, dCorto, 'short', TARGET_PCT, STOP_PCT, MAX_BARS);
    const resueltosTotal = eLargo.resueltos + eCorto.resueltos;
    const ganadasTotal = Math.round(eLargo.resueltos*(isNaN(eLargo.winRate)?0:eLargo.winRate)/100) + Math.round(eCorto.resueltos*(isNaN(eCorto.winRate)?0:eCorto.winRate)/100);
    const winRateTotal = resueltosTotal>0 ? ganadasTotal/resueltosTotal*100 : NaN;
    return { ventanaHoras, eLargo, eCorto, resueltosTotal, winRateTotal };
  });

  console.log('\n--- Diagnóstico por ventana (calculado, no leído a ojo) ---');
  resumenBH.forEach(r=>{
    const muestraOk = r.resueltosTotal >= UMBRAL_MUESTRA_MINIMA;
    console.log('\nVentana ' + r.ventanaHoras + 'h: ' + r.resueltosTotal + ' operaciones resueltas en total (largo+corto) → ' +
      (muestraOk ? 'MUESTRA SUFICIENTE' : 'MUESTRA INSUFICIENTE (mínimo recomendado: ' + UMBRAL_MUESTRA_MINIMA + ')'));
    console.log('  % de acierto conjunto: ' + (isNaN(r.winRateTotal) ? '—' : r.winRateTotal.toFixed(1)+'%') +
      ' (largo: ' + (isNaN(r.eLargo.winRate)?'—':r.eLargo.winRate.toFixed(1)+'%') + ' con ' + r.eLargo.resueltos + ' · corto: ' +
      (isNaN(r.eCorto.winRate)?'—':r.eCorto.winRate.toFixed(1)+'%') + ' con ' + r.eCorto.resueltos + ')');
  });

  const ventanasConMuestraBH = resumenBH.filter(r=>r.resueltosTotal >= UMBRAL_MUESTRA_MINIMA && !isNaN(r.winRateTotal));
  console.log('\n--- Conclusión automática ---');
  if(ventanasConMuestraBH.length===0){
    console.log('NINGUNA ventana alcanza la muestra mínima de ' + UMBRAL_MUESTRA_MINIMA + ' operaciones resueltas.');
    console.log('Ni relajando a 2 condiciones en 1H ni ampliando a 48 meses fue suficiente — haría falta relajar también el 15M.');
  } else if(ventanasConMuestraBH.length===1){
    console.log('Solo la ventana de ' + ventanasConMuestraBH[0].ventanaHoras + 'h alcanza muestra suficiente (' + ventanasConMuestraBH[0].resueltosTotal + ' operaciones), con ' + ventanasConMuestraBH[0].winRateTotal.toFixed(1) + '% de acierto.');
  } else {
    const tasas = ventanasConMuestraBH.map(r=>r.winRateTotal);
    const diferencia = Math.max(...tasas) - Math.min(...tasas);
    const esEstable = diferencia <= UMBRAL_ESTABILIDAD_PUNTOS;
    console.log('Ventanas con muestra suficiente: ' + ventanasConMuestraBH.map(r=>r.ventanaHoras+'h ('+r.winRateTotal.toFixed(1)+'%)').join(', '));
    console.log('Diferencia entre la más alta y la más baja: ' + diferencia.toFixed(1) + ' puntos → ' +
      (esEstable ? 'ESTABLE' : 'INESTABLE'));
  }

  // ---------- ANÁLISIS BI: corregido — zona amarilla ÚNICA (entrando=largo, saliendo hacia abajo=corto) ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS BI — Corregido: zona amarilla única del Koncorde (entrando=impulso alcista, saliendo hacia abajo=se agota)');
  console.log('========================================');
  console.log('15M (impulso): largo = dentro de la zona + AO Alcista + ADX subiendo + BBWP>50.');
  console.log('               corto = saliendo de la zona hacia abajo + AO Bajista + ADX subiendo + BBWP>50.');
  console.log('1H (retroceso, 2 condiciones): largo = entrando en la zona + BBWP acercándose a 50.');
  console.log('                                corto = saliendo de la zona hacia abajo + BBWP acercándose a 50.');
  console.log('Reutilizando los 48 meses de 15M ya descargados (' + s15MBH.n + ' velas).');

  function impulso15M_BI(series, i, direction){
    const koncordeOk = direction==='long' ? dentroZonaAmarillaUnica(series, i) : saliendoZonaAmarillaHaciaAbajo(series, i);
    return koncordeOk
      && (direction==='long' ? series.aoState[i]==='Alcista' : series.aoState[i]==='Bajista')
      && series.adxSubiendo[i]
      && series.bbwp[i]>50;
  }
  function retroceso1H_BI(j, direction){
    const koncordeOk = direction==='long' ? entrandoZonaAmarillaUnica(s, j) : saliendoZonaAmarillaHaciaAbajo(s, j);
    return koncordeOk && bbwpAcercandoseA(s, j, 50, 15, 3);
  }
  const idx1HPara15M_BI = alignDailyIndex(s, s15MBH.times);
  function retrocesoRecienteEn1H_BI(i15M, direction, ventanaHoras){
    const j = idx1HPara15M_BI[i15M];
    if(j<0) return false;
    const desde = Math.max(0, j - ventanaHoras);
    for(let k=desde; k<=j; k++){ if(retroceso1H_BI(k, direction)) return true; }
    return false;
  }

  const resumenBI = [4, 8, 12].map(ventanaHoras=>{
    const dLargo = new Array(s15MBH.n).fill(false), dCorto = new Array(s15MBH.n).fill(false);
    for(let i=0;i<s15MBH.n;i++){
      if(impulso15M_BI(s15MBH,i,'long') && retrocesoRecienteEn1H_BI(i,'long',ventanaHoras)) dLargo[i]=true;
      if(impulso15M_BI(s15MBH,i,'short') && retrocesoRecienteEn1H_BI(i,'short',ventanaHoras)) dCorto[i]=true;
    }
    const eLargo = evaluarIndicador(s15MBH, dLargo, 'long', TARGET_PCT, STOP_PCT, MAX_BARS);
    const eCorto = evaluarIndicador(s15MBH, dCorto, 'short', TARGET_PCT, STOP_PCT, MAX_BARS);
    const resueltosTotal = eLargo.resueltos + eCorto.resueltos;
    const ganadasTotal = Math.round(eLargo.resueltos*(isNaN(eLargo.winRate)?0:eLargo.winRate)/100) + Math.round(eCorto.resueltos*(isNaN(eCorto.winRate)?0:eCorto.winRate)/100);
    const winRateTotal = resueltosTotal>0 ? ganadasTotal/resueltosTotal*100 : NaN;
    return { ventanaHoras, eLargo, eCorto, resueltosTotal, winRateTotal };
  });

  console.log('\n--- Diagnóstico por ventana (calculado, no leído a ojo) ---');
  resumenBI.forEach(r=>{
    const muestraOk = r.resueltosTotal >= UMBRAL_MUESTRA_MINIMA;
    console.log('\nVentana ' + r.ventanaHoras + 'h: ' + r.resueltosTotal + ' operaciones resueltas en total (largo+corto) → ' +
      (muestraOk ? 'MUESTRA SUFICIENTE' : 'MUESTRA INSUFICIENTE (mínimo recomendado: ' + UMBRAL_MUESTRA_MINIMA + ')'));
    console.log('  % de acierto conjunto: ' + (isNaN(r.winRateTotal) ? '—' : r.winRateTotal.toFixed(1)+'%') +
      ' (largo: ' + (isNaN(r.eLargo.winRate)?'—':r.eLargo.winRate.toFixed(1)+'%') + ' con ' + r.eLargo.resueltos + ' · corto: ' +
      (isNaN(r.eCorto.winRate)?'—':r.eCorto.winRate.toFixed(1)+'%') + ' con ' + r.eCorto.resueltos + ')');
  });

  const ventanasConMuestraBI = resumenBI.filter(r=>r.resueltosTotal >= UMBRAL_MUESTRA_MINIMA && !isNaN(r.winRateTotal));
  console.log('\n--- Conclusión automática ---');
  if(ventanasConMuestraBI.length===0){
    console.log('NINGUNA ventana alcanza la muestra mínima de ' + UMBRAL_MUESTRA_MINIMA + ' operaciones resueltas.');
  } else if(ventanasConMuestraBI.length===1){
    console.log('Solo la ventana de ' + ventanasConMuestraBI[0].ventanaHoras + 'h alcanza muestra suficiente (' + ventanasConMuestraBI[0].resueltosTotal + ' operaciones), con ' + ventanasConMuestraBI[0].winRateTotal.toFixed(1) + '% de acierto.');
  } else {
    const tasas = ventanasConMuestraBI.map(r=>r.winRateTotal);
    const diferencia = Math.max(...tasas) - Math.min(...tasas);
    const esEstable = diferencia <= UMBRAL_ESTABILIDAD_PUNTOS;
    console.log('Ventanas con muestra suficiente: ' + ventanasConMuestraBI.map(r=>r.ventanaHoras+'h ('+r.winRateTotal.toFixed(1)+'%)').join(', '));
    console.log('Diferencia entre la más alta y la más baja: ' + diferencia.toFixed(1) + ' puntos → ' + (esEstable ? 'ESTABLE' : 'INESTABLE'));
  }

  // ---------- ANÁLISIS BJ: ¿son pocos disparos, o muchos disparos que no llegan a resolverse? ----------
  console.log('\n\n========================================');
  console.log('ANÁLISIS BJ — ¿El problema es pocos DISPAROS, o disparos que SÍ hay pero no resuelven dentro de la ventana?');
  console.log('========================================');
  console.log('Hasta ahora solo se mostraban las operaciones RESUELTAS (llegan a +2% o -2% en 40 velas). Aquí se');
  console.log('desglosa también cuántas NO llegan a resolverse (el precio no se mueve lo suficiente en ningún');
  console.log('sentido dentro de la ventana) — para saber si el cuello de botella es la señal o la propia carrera.');

  console.log('\n' + pad('Ventana',9) + pad('Dir.',6) + padL('Disparos',10) + padL('Resueltos',11) + padL('Sin resolver',13) + padL('% sin resolver',15));
  [4, 8, 12].forEach(ventanaHoras=>{
    ['long','short'].forEach(direccion=>{
      const disparoArr = new Array(s15MBH.n).fill(false);
      for(let i=0;i<s15MBH.n;i++){
        if(impulso15M_BI(s15MBH,i,direccion) && retrocesoRecienteEn1H_BI(i,direccion,ventanaHoras)) disparoArr[i]=true;
      }
      const resultados = carreraHaciaObjetivo(s15MBH, disparoArr, direccion, TARGET_PCT, STOP_PCT, MAX_BARS);
      const sinResolver = resultados.filter(r=>r.resultado===null).length;
      const resueltos = resultados.length - sinResolver;
      const pctSinResolver = resultados.length ? (sinResolver/resultados.length*100) : NaN;
      console.log(pad(ventanaHoras+'h',9) + pad(direccion==='long'?'Largo':'Corto',6) + padL(resultados.length,10) + padL(resueltos,11) + padL(sinResolver,13) + padL(isNaN(pctSinResolver)?'—':pctSinResolver.toFixed(1)+'%',15));
    });
  });


  // ============================================================
  // ANÁLISIS BK — Embudo de atrición: dónde se pierde exactamente la muestra
  // ============================================================
  // No se mueve ninguna ventana (eso ya está descartado). Se cuenta, sobre TODAS
  // las velas de 15M descargadas, cuántas pasan cada condición POR SEPARADO y
  // cuántas sobreviven ACUMULADAS en orden. La condición con la peor retención es
  // la que mata el proyecto. Se usa la definición vigente de la señal (la corregida
  // en BI) y la ventana de 1H más laxa de las probadas (12h), para medir el MEJOR
  // caso posible, no el peor.
  console.log('\n\n========================================');
  console.log('ANÁLISIS BK — Embudo de atrición: dónde se pierde la muestra, condición por condición');
  console.log('========================================');

  const UMBRAL_MUESTRA_PROYECTO = 100; // operaciones resueltas exigidas por las instrucciones del proyecto
  const VENTANA_1H_BK = 12;            // la ventana más laxa de las ya probadas: mejor caso posible

  // --- Cobertura temporal de cada serie (esto se imprime ANTES que nada) ---
  const isoDia = ms => new Date(ms).toISOString().slice(0,10);
  const mesesEntre = (a,b) => (b-a)/(30*86400000);
  const cobertura1HVelas = idx1HPara15M_BI.reduce((acc,j)=>acc+(j>=0?1:0), 0);
  const pctCobertura1H = s15MBH.n>0 ? cobertura1HVelas/s15MBH.n*100 : NaN;

  console.log('\n--- Cobertura temporal de las series (condición previa a todo lo demás) ---');
  console.log('Serie 15M : ' + s15MBH.n + ' velas · ' + isoDia(s15MBH.times[0]) + ' → ' + isoDia(s15MBH.times[s15MBH.n-1]) +
    ' (' + mesesEntre(s15MBH.times[0], s15MBH.times[s15MBH.n-1]).toFixed(1) + ' meses)');
  console.log('Serie 1H  : ' + s.n + ' velas · ' + isoDia(s.times[0]) + ' → ' + isoDia(s.times[s.n-1]) +
    ' (' + mesesEntre(s.times[0], s.times[s.n-1]).toFixed(1) + ' meses)');
  console.log('Velas de 15M que tienen una vela de 1H disponible para confirmar: ' + cobertura1HVelas +
    ' de ' + s15MBH.n + ' (' + pctCobertura1H.toFixed(1) + '%)');
  if(pctCobertura1H < 99){
    console.log('AVISO: la serie de 1H NO cubre todo el histórico de 15M. Para las velas fuera de cobertura la');
    console.log('confirmación de 1H es imposible por construcción, no por criterio de mercado. Ese porcentaje es');
    console.log('un tope estructural de la muestra, independiente de lo buena o mala que sea la señal.');
  }

  // --- Definición de las condiciones atómicas, en el orden en que se aplican ---
  const condicionesBK = {
    long: [
      { nombre: 'Koncorde 15M: dentro zona amarilla',   test: i => dentroZonaAmarillaUnica(s15MBH, i) },
      { nombre: 'AO 15M: estado Alcista',               test: i => s15MBH.aoState[i] === 'Alcista' },
      { nombre: 'ADX 15M: subiendo',                    test: i => s15MBH.adxSubiendo[i] },
      { nombre: 'BBWP 15M: > 50',                       test: i => s15MBH.bbwp[i] > 50 },
      { nombre: 'Existe vela de 1H en esa fecha',       test: i => idx1HPara15M_BI[i] >= 0 },
      { nombre: 'Confirmación 1H (' + VENTANA_1H_BK + 'h)', test: i => retrocesoRecienteEn1H_BI(i, 'long', VENTANA_1H_BK) }
    ],
    short: [
      { nombre: 'Koncorde 15M: saliendo zona por abajo', test: i => saliendoZonaAmarillaHaciaAbajo(s15MBH, i) },
      { nombre: 'AO 15M: estado Bajista',               test: i => s15MBH.aoState[i] === 'Bajista' },
      { nombre: 'ADX 15M: subiendo',                    test: i => s15MBH.adxSubiendo[i] },
      { nombre: 'BBWP 15M: > 50',                       test: i => s15MBH.bbwp[i] > 50 },
      { nombre: 'Existe vela de 1H en esa fecha',       test: i => idx1HPara15M_BI[i] >= 0 },
      { nombre: 'Confirmación 1H (' + VENTANA_1H_BK + 'h)', test: i => retrocesoRecienteEn1H_BI(i, 'short', VENTANA_1H_BK) }
    ]
  };

  const IDX_ULTIMA_COND_15M_BK = 3; // índice de 'BBWP 15M: > 50' — último escalón que no depende del 1H

  function embudoBK(direction){
    const conds = condicionesBK[direction];
    const nTot = s15MBH.n;

    // Paso 1: cuántas velas pasan cada condición POR SEPARADO (independientes entre sí)
    const sueltas = conds.map(() => 0);
    for(let c=0; c<conds.length; c++){
      const test = conds[c].test;
      for(let i=0; i<nTot; i++) if(test(i)) sueltas[c]++;
    }

    // Paso 2: supervivientes ACUMULADAS aplicando las condiciones en orden
    let vivos = new Array(nTot).fill(true);
    const acumuladas = [];
    let vivosTras15M = null;
    conds.forEach((cond, c) => {
      const siguiente = new Array(nTot).fill(false);
      let cuenta = 0;
      for(let i=0; i<nTot; i++){
        if(vivos[i] && cond.test(i)){ siguiente[i] = true; cuenta++; }
      }
      vivos = siguiente;
      acumuladas.push(cuenta);
      if(c === IDX_ULTIMA_COND_15M_BK) vivosTras15M = vivos.slice();
    });

    // Paso 3: último escalón del embudo — que la carrera ±2% llegue a resolverse
    const resultados = carreraHaciaObjetivo(s15MBH, vivos, direction, TARGET_PCT, STOP_PCT, MAX_BARS);
    const resueltos = resultados.filter(r => r.resultado !== null);
    const ganadas = resueltos.filter(r => r.resultado === true).length;

    // Referencia: el mismo embudo cortado antes del 1H (techo si el 1H no cortara nada)
    const resultadosSin1H = carreraHaciaObjetivo(s15MBH, vivosTras15M, direction, TARGET_PCT, STOP_PCT, MAX_BARS);
    const resueltosSin1H = resultadosSin1H.filter(r => r.resultado !== null).length;

    return {
      direction, conds, sueltas, acumuladas,
      disparos: resultados.length,
      resueltos: resueltos.length,
      ganadas,
      winRate: resueltos.length ? ganadas/resueltos.length*100 : NaN,
      resultados,
      disparosSin1H: resultadosSin1H.length,
      resueltosSin1H
    };
  }

  function imprimirEmbudoBK(res){
    const nTot = s15MBH.n;
    console.log('\n--- Embudo ' + (res.direction === 'long' ? 'LARGO' : 'CORTO') + ' (total de velas de 15M: ' + nTot + ') ---');
    console.log(pad('Condición', 38) + padL('Pasan', 10) + padL('% total', 10) + padL('Superviv.', 11) + padL('% del ant.', 12));
    let anterior = nTot;
    res.conds.forEach((cond, c) => {
      const sup = res.acumuladas[c];
      const pctTotal = nTot > 0 ? res.sueltas[c]/nTot*100 : NaN;
      const pctAnterior = anterior > 0 ? sup/anterior*100 : NaN;
      console.log(pad(cond.nombre, 38) + padL(res.sueltas[c], 10) + padL(pctTotal.toFixed(2)+'%', 10) +
        padL(sup, 11) + padL(isNaN(pctAnterior) ? '—' : pctAnterior.toFixed(1)+'%', 12));
      anterior = sup;
    });
    const pctResueltas = res.disparos > 0 ? res.resueltos/res.disparos*100 : NaN;
    console.log(pad('Carrera ±' + TARGET_PCT + '% resuelta en ' + MAX_BARS + ' velas', 38) + padL('—', 10) + padL('—', 10) +
      padL(res.resueltos, 11) + padL(isNaN(pctResueltas) ? '—' : pctResueltas.toFixed(1)+'%', 12));
    console.log('Referencia sin el filtro de 1H: ' + res.disparosSin1H + ' disparos → ' + res.resueltosSin1H + ' resueltas.');
  }

  // --- Localiza el escalón con peor retención (el que "mata" el embudo) ---
  function peorEscalonBK(res){
    const nTot = s15MBH.n;
    let anterior = nTot, peor = null;
    res.conds.forEach((cond, c) => {
      const sup = res.acumuladas[c];
      const ratio = anterior > 0 ? sup/anterior : 1;
      if(peor === null || ratio < peor.ratio) peor = { nombre: cond.nombre, ratio, sup, anterior };
      anterior = sup;
    });
    const ratioResolucion = res.disparos > 0 ? res.resueltos/res.disparos : 1;
    if(res.disparos > 0 && ratioResolucion < peor.ratio){
      peor = { nombre: 'Carrera ±' + TARGET_PCT + '% resuelta en ' + MAX_BARS + ' velas', ratio: ratioResolucion, sup: res.resueltos, anterior: res.disparos };
    }
    return peor;
  }

  const embudoLargoBK = embudoBK('long');
  const embudoCortoBK = embudoBK('short');
  imprimirEmbudoBK(embudoLargoBK);
  imprimirEmbudoBK(embudoCortoBK);

  // --- Desglose por año ---
  function desglosePorAnioBK(res){
    const porAnio = new Map();
    for(let i=0; i<s15MBH.n; i++){
      const anio = new Date(s15MBH.times[i]).getUTCFullYear();
      if(!porAnio.has(anio)) porAnio.set(anio, { velas:0, con1H:0, disparos:0, resueltos:0, ganadas:0 });
      const e = porAnio.get(anio);
      e.velas++;
      if(idx1HPara15M_BI[i] >= 0) e.con1H++;
    }
    res.resultados.forEach(r => {
      const anio = new Date(s15MBH.times[r.entryIdx]).getUTCFullYear();
      const e = porAnio.get(anio);
      if(!e) return;
      e.disparos++;
      if(r.resultado !== null){ e.resueltos++; if(r.resultado === true) e.ganadas++; }
    });
    return porAnio;
  }

  console.log('\n--- Desglose por año (largo + corto juntos) ---');
  const anioLargoBK = desglosePorAnioBK(embudoLargoBK);
  const anioCortoBK = desglosePorAnioBK(embudoCortoBK);
  const aniosBK = Array.from(new Set([...anioLargoBK.keys(), ...anioCortoBK.keys()])).sort((a,b)=>a-b);
  console.log(pad('Año', 8) + padL('Velas 15M', 11) + padL('Con 1H', 10) + padL('% con 1H', 10) + padL('Disparos', 10) + padL('Resueltas', 11) + padL('% acierto', 11));
  aniosBK.forEach(anio => {
    const a = anioLargoBK.get(anio) || { velas:0, con1H:0, disparos:0, resueltos:0, ganadas:0 };
    const b = anioCortoBK.get(anio) || { velas:0, con1H:0, disparos:0, resueltos:0, ganadas:0 };
    const disparos = a.disparos + b.disparos;
    const resueltos = a.resueltos + b.resueltos;
    const ganadas = a.ganadas + b.ganadas;
    const pctCon1H = a.velas > 0 ? a.con1H/a.velas*100 : NaN;
    const winRate = resueltos > 0 ? ganadas/resueltos*100 : NaN;
    console.log(pad(anio, 8) + padL(a.velas, 11) + padL(a.con1H, 10) + padL(isNaN(pctCon1H)?'—':pctCon1H.toFixed(0)+'%', 10) +
      padL(disparos, 10) + padL(resueltos, 11) + padL(isNaN(winRate)?'—':winRate.toFixed(1)+'%', 11));
  });

  // --- Conclusión automática de BK (la emite el script, no se lee la tabla a ojo) ---
  const resueltosTotalBK = embudoLargoBK.resueltos + embudoCortoBK.resueltos;
  const resueltosSin1HBK = embudoLargoBK.resueltosSin1H + embudoCortoBK.resueltosSin1H;
  const peorLargoBK = peorEscalonBK(embudoLargoBK);
  const peorCortoBK = peorEscalonBK(embudoCortoBK);

  console.log('\n--- Conclusión automática (BK) ---');
  console.log('TAMAÑO DE MUESTRA PRIMERO: ' + resueltosTotalBK + ' operaciones resueltas (largo+corto) sobre ' +
    s15MBH.n + ' velas de 15M.');
  if(resueltosTotalBK < UMBRAL_MUESTRA_PROYECTO){
    console.log('→ MUESTRA INSUFICIENTE (mínimo del proyecto: ' + UMBRAL_MUESTRA_PROYECTO + '). No se interpreta ningún');
    console.log('  resultado de rendimiento de esta configuración. Solo se diagnostica dónde se pierde la muestra.');
  } else {
    console.log('→ MUESTRA SUFICIENTE (mínimo del proyecto: ' + UMBRAL_MUESTRA_PROYECTO + '). El rendimiento sí es interpretable.');
  }
  console.log('Escalón que más corta en LARGO: "' + peorLargoBK.nombre + '" → deja pasar el ' +
    (peorLargoBK.ratio*100).toFixed(1) + '% (' + peorLargoBK.anterior + ' → ' + peorLargoBK.sup + ').');
  console.log('Escalón que más corta en CORTO: "' + peorCortoBK.nombre + '" → deja pasar el ' +
    (peorCortoBK.ratio*100).toFixed(1) + '% (' + peorCortoBK.anterior + ' → ' + peorCortoBK.sup + ').');
  console.log('Techo si el filtro de 1H no cortara absolutamente nada: ' + resueltosSin1HBK + ' operaciones resueltas.');
  if(resueltosSin1HBK < UMBRAL_MUESTRA_PROYECTO){
    console.log('→ CONCLUSIÓN: el 1H NO es el cuello de botella. Ni eliminándolo por completo se llega a ' +
      UMBRAL_MUESTRA_PROYECTO + '.');
    console.log('  El problema está en las condiciones de 15M, no en la confirmación. Quitar el 1H no arregla nada.');
  } else {
    console.log('→ CONCLUSIÓN: el filtro de 1H SÍ es el cuello de botella. Sin él la muestra pasa de ' +
      resueltosTotalBK + ' a ' + resueltosSin1HBK + ' operaciones resueltas, por encima del mínimo de ' +
      UMBRAL_MUESTRA_PROYECTO + '. El 1H debería usarse para modular tamaño, no para cortar entradas.');
  }
  if(pctCobertura1H < 99){
    console.log('AVISO REPETIDO: solo el ' + pctCobertura1H.toFixed(1) + '% de las velas de 15M tenía 1H disponible. Parte de');
    console.log('la atrición atribuida al 1H es falta de datos, no criterio. Comparar con BO antes de decidir nada.');
  }

  // ============================================================
  // ANÁLISIS BO — Techo de histórico: cuánta muestra es alcanzable como máximo
  // ============================================================
  // Descarga el máximo de velas de 15M que la API permite, mide desde qué fecha
  // llega, y calcula cuántas operaciones resueltas dan las condiciones de 15M
  // SIN ningún filtro de 1H. Ese número es el techo absoluto del concepto.
  console.log('\n\n========================================');
  console.log('ANÁLISIS BO — Techo de histórico: máximo de velas de 15M descargables y máximo de muestra alcanzable');
  console.log('========================================');

  const MAX_PAGINAS_BO = 500; // 500 páginas × 1000 velas = 500.000 velas de 15M ≈ 14 años

  async function descargarTodoElHistoricoBO(interval, maxPaginas){
    const primera = await fetchKlinesRaw(interval, SIGNAL_LIMIT);
    const paginasDatos = [primera];
    let masAntiguo = primera[0][0];
    let paginas = 1;
    let motivoParada = 'límite de páginas del script alcanzado (' + maxPaginas + ')';
    let finDeHistorico = false;
    while(paginas < maxPaginas){
      let pagina;
      try{ pagina = await fetchKlinesRaw(interval, SIGNAL_LIMIT, masAntiguo - 1); }
      catch(e){
        // 'Respuesta vacía' en TODOS los hosts = no hay más velas antiguas (fin real del histórico).
        // Cualquier otro error (HTTP, red, rate limit) = corte técnico, NO es el techo de datos.
        if(/Respuesta vacía/.test(e.message)){ motivoParada = 'todos los hosts devolvieron vacío (fin del histórico)'; finDeHistorico = true; }
        else { motivoParada = 'CORTE TÉCNICO, no fin de histórico: ' + e.message; }
        break;
      }
      if(!pagina || pagina.length === 0){ motivoParada = 'la API devolvió una página vacía (fin del histórico)'; finDeHistorico = true; break; }
      const nuevas = pagina.filter(k => k[0] < masAntiguo);
      if(nuevas.length === 0){ motivoParada = 'la API dejó de devolver velas más antiguas (fin del histórico)'; finDeHistorico = true; break; }
      paginasDatos.unshift(nuevas);
      masAntiguo = nuevas[0][0];
      paginas++;
      if(paginas % 50 === 0) console.log('  ... ' + paginas + ' páginas descargadas, llegando hasta ' + new Date(masAntiguo).toISOString().slice(0,10));
      if(pagina.length < SIGNAL_LIMIT){ motivoParada = 'la API devolvió una página incompleta (fin del histórico)'; finDeHistorico = true; break; }
    }
    const map = new Map();
    paginasDatos.forEach(p => p.forEach(k => map.set(k[0], k)));
    const sorted = Array.from(map.values()).sort((a,b) => a[0]-b[0]);
    return {
      paginas, motivoParada, finDeHistorico,
      times: sorted.map(k => k[0]),
      opens: sorted.map(k => parseFloat(k[1])),
      highs: sorted.map(k => parseFloat(k[2])),
      lows: sorted.map(k => parseFloat(k[3])),
      closes: sorted.map(k => parseFloat(k[4])),
      volumes: sorted.map(k => parseFloat(k[5]))
    };
  }

  try{
    console.log('\nDescargando TODO el histórico de 15M disponible en la API (esto tarda unos minutos)...');
    const t0BO = Date.now();
    const ohlcv15MBO = await descargarTodoElHistoricoBO('15m', MAX_PAGINAS_BO);
    const nBO = ohlcv15MBO.times.length;
    const segundosBO = (Date.now() - t0BO)/1000;

    const primeraFechaBO = ohlcv15MBO.times[0];
    const ultimaFechaBO = ohlcv15MBO.times[nBO-1];
    const esperadasBO = Math.round((ultimaFechaBO - primeraFechaBO)/900000) + 1;
    const huecosBO = esperadasBO - nBO;
    const aniosBO = (ultimaFechaBO - primeraFechaBO)/(365.25*86400000);

    console.log('\n--- Lo que la API entrega realmente (símbolo ' + SYMBOL + ') ---');
    console.log('Velas de 15M descargadas : ' + nBO + ' (en ' + ohlcv15MBO.paginas + ' páginas, ' + segundosBO.toFixed(0) + 's)');
    console.log('Desde                    : ' + new Date(primeraFechaBO).toISOString());
    console.log('Hasta                    : ' + new Date(ultimaFechaBO).toISOString());
    console.log('Periodo cubierto         : ' + aniosBO.toFixed(2) + ' años');
    console.log('Velas esperadas sin huecos: ' + esperadasBO + ' → huecos detectados: ' + huecosBO +
      ' (' + (esperadasBO>0 ? (huecosBO/esperadasBO*100).toFixed(2) : '0.00') + '%)');
    console.log('Motivo de parada         : ' + ohlcv15MBO.motivoParada);
    const topeReal = ohlcv15MBO.finDeHistorico;
    console.log(topeReal
      ? '→ Se agotó el histórico de la API: este es el TECHO REAL de datos.'
      : '→ NO se llegó al techo real: la descarga se cortó antes. La cifra de abajo es un SUELO, no el máximo.');

    console.log('\nCalculando indicadores sobre el histórico completo...');
    const t1BO = Date.now();
    const s15MBO = computeFullSeries(ohlcv15MBO);
    console.log('Indicadores calculados en ' + ((Date.now()-t1BO)/1000).toFixed(0) + 's sobre ' + s15MBO.n + ' velas.');

    // Disparador de 15M puro: las mismas cuatro condiciones de BI, SIN filtro de 1H.
    function disparo15MPuroBO(series, i, direction){
      const koncordeOk = direction === 'long' ? dentroZonaAmarillaUnica(series, i) : saliendoZonaAmarillaHaciaAbajo(series, i);
      return koncordeOk
        && (direction === 'long' ? series.aoState[i] === 'Alcista' : series.aoState[i] === 'Bajista')
        && series.adxSubiendo[i]
        && series.bbwp[i] > 50;
    }

    const resumenBO = ['long','short'].map(direction => {
      const disparo = new Array(s15MBO.n).fill(false);
      for(let i=0; i<s15MBO.n; i++) if(disparo15MPuroBO(s15MBO, i, direction)) disparo[i] = true;
      const resultados = carreraHaciaObjetivo(s15MBO, disparo, direction, TARGET_PCT, STOP_PCT, MAX_BARS);
      const resueltos = resultados.filter(r => r.resultado !== null);
      const ganadas = resueltos.filter(r => r.resultado === true).length;
      return {
        direction,
        disparos: resultados.length,
        resueltos: resueltos.length,
        ganadas,
        winRate: resueltos.length ? ganadas/resueltos.length*100 : NaN,
        resultados
      };
    });

    console.log('\n--- Máximo de muestra alcanzable: disparador de 15M puro, SIN filtro de 1H, sobre todo el histórico ---');
    console.log(pad('Dirección', 12) + padL('Disparos', 10) + padL('Resueltas', 11) + padL('Sin resolver', 14) + padL('% acierto', 11));
    resumenBO.forEach(r => {
      console.log(pad(r.direction === 'long' ? 'Largo' : 'Corto', 12) + padL(r.disparos, 10) + padL(r.resueltos, 11) +
        padL(r.disparos - r.resueltos, 14) + padL(isNaN(r.winRate) ? '—' : r.winRate.toFixed(1)+'%', 11));
    });
    const disparosTotalBO = resumenBO.reduce((a,r) => a+r.disparos, 0);
    const resueltosTotalBO = resumenBO.reduce((a,r) => a+r.resueltos, 0);
    const ganadasTotalBO = resumenBO.reduce((a,r) => a+r.ganadas, 0);
    const winRateTotalBO = resueltosTotalBO > 0 ? ganadasTotalBO/resueltosTotalBO*100 : NaN;
    console.log(pad('TOTAL', 12) + padL(disparosTotalBO, 10) + padL(resueltosTotalBO, 11) +
      padL(disparosTotalBO - resueltosTotalBO, 14) + padL(isNaN(winRateTotalBO) ? '—' : winRateTotalBO.toFixed(1)+'%', 11));

    // Reparto por año: para ver si la muestra está concentrada en unos pocos años
    const porAnioBO = new Map();
    for(let i=0; i<s15MBO.n; i++){
      const anio = new Date(s15MBO.times[i]).getUTCFullYear();
      if(!porAnioBO.has(anio)) porAnioBO.set(anio, { velas:0, disparos:0, resueltos:0, ganadas:0 });
      porAnioBO.get(anio).velas++;
    }
    resumenBO.forEach(r => r.resultados.forEach(x => {
      const anio = new Date(s15MBO.times[x.entryIdx]).getUTCFullYear();
      const e = porAnioBO.get(anio);
      if(!e) return;
      e.disparos++;
      if(x.resultado !== null){ e.resueltos++; if(x.resultado === true) e.ganadas++; }
    }));
    console.log('\n--- Reparto por año (¿la muestra está concentrada o repartida?) ---');
    console.log(pad('Año', 8) + padL('Velas 15M', 11) + padL('Disparos', 10) + padL('Resueltas', 11) + padL('% acierto', 11));
    const aniosOrdenadosBO = Array.from(porAnioBO.keys()).sort((a,b) => a-b);
    let aniosConMuestraBO = 0;
    aniosOrdenadosBO.forEach(anio => {
      const e = porAnioBO.get(anio);
      const wr = e.resueltos > 0 ? e.ganadas/e.resueltos*100 : NaN;
      if(e.resueltos > 0) aniosConMuestraBO++;
      console.log(pad(anio, 8) + padL(e.velas, 11) + padL(e.disparos, 10) + padL(e.resueltos, 11) +
        padL(isNaN(wr) ? '—' : wr.toFixed(1)+'%', 11));
    });

    // --- Conclusión automática de BO ---
    console.log('\n--- Conclusión automática (BO) ---');
    console.log('TAMAÑO DE MUESTRA PRIMERO: ' + resueltosTotalBO + ' operaciones resueltas con el histórico máximo (' +
      aniosBO.toFixed(2) + ' años) y SIN ningún filtro de 1H.');
    if(resueltosTotalBO < UMBRAL_MUESTRA_PROYECTO){
      console.log('→ MUESTRA INSUFICIENTE. Ni con todo el histórico posible ni quitando el filtro de 1H se alcanzan ' +
        UMBRAL_MUESTRA_PROYECTO + ' operaciones resueltas.');
      console.log('→ DECISIÓN AUTOMÁTICA: ARCHIVAR el concepto de 15M. No hay forma de conseguir muestra suficiente');
      console.log('  sin cambiar la señal, así que no procede seguir con BL, BM ni BN. Volver al 4H, que sí funciona.');
      if(!topeReal){
        console.log('  MATIZ QUE INVALIDA LA DECISIÓN: la descarga NO llegó al fin del histórico (' + ohlcv15MBO.motivoParada + ').');
        console.log('  No se archiva nada con este dato. Repetir BO subiendo MAX_PAGINAS_BO o cuando la API responda bien.');
      }
    } else {
      console.log('→ MUESTRA SUFICIENTE en el techo. El concepto de 15M NO se archiva: hay margen para seguir con BL y BN.');
      const margen = resueltosTotalBO / UMBRAL_MUESTRA_PROYECTO;
      console.log('  Margen sobre el mínimo: ×' + margen.toFixed(2) + '. Cualquier filtro que se añada solo puede reducir');
      console.log('  esta cifra, así que un filtro que corte más del ' + ((1 - UMBRAL_MUESTRA_PROYECTO/resueltosTotalBO)*100).toFixed(0) +
        '% de las entradas deja el análisis sin muestra.');
      console.log('  Años con al menos una operación resuelta: ' + aniosConMuestraBO + ' de ' + aniosOrdenadosBO.length +
        ' → ' + (aniosConMuestraBO >= aniosOrdenadosBO.length - 1 ? 'muestra REPARTIDA en el tiempo.' : 'muestra CONCENTRADA: revisar en qué años, no dar el resultado por bueno sin ese contexto.'));
    }
    console.log('\nComparación BK vs BO: BK midió ' + resueltosTotalBK + ' operaciones resueltas con la señal completa sobre ' +
      s15MBH.n + ' velas; BO mide ' + resueltosTotalBO + ' en el techo con ' + s15MBO.n + ' velas y sin filtro de 1H.');
    console.log('La diferencia entre esas dos cifras es todo lo que hay que ganar optimizando; el resto no existe.');

  }catch(errBO){
    console.log('\nANÁLISIS BO NO COMPLETADO — fallo al descargar o procesar el histórico: ' + errBO.message);
    console.log('No se emite conclusión: sin el dato del techo de histórico, BK por sí solo no decide si se archiva el 15M.');
  }

  console.log('\n=== Fin del backtest ===');
}

main().catch(err=>{
  console.error('Error en el backtest:', err);
  process.exit(1);
});

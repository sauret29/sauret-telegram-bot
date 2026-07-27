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

const MESES_HISTORICO = 6;
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
  const msPerCandle = { '1h': 3600000, '4h': 14400000, '1d': 86400000 }[interval] || 3600000;
  const monthsCandles = Math.ceil((months * 30 * 86400000) / msPerCandle);
  const targetCandles = monthsCandles + warmupMargin;
  let all = await fetchKlinesRaw(interval, SIGNAL_LIMIT);
  let pages = 1;
  while(all.length < targetCandles && pages < 15){
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
  for(let i=0;i<n;i++){
    const i4 = idx4H[i], iD = idxD[i];
    bull4[i] = i4>=0 && series4H.aoState[i4]==='Alcista' && series4H.koBull[i4];
    bear4[i] = i4>=0 && series4H.aoState[i4]==='Bajista' && series4H.koBear[i4];
    bullD[i] = iD>=0 && seriesD.aoState[iD]==='Alcista' && seriesD.koBull[iD];
    bearD[i] = iD>=0 && seriesD.aoState[iD]==='Bajista' && seriesD.koBear[iD];
  }
  // 'bullish'/'bearish' (con OR) se mantienen para no romper la variante ya usada.
  const bullish = bull4.map((v,i)=>v||bullD[i]);
  const bearish = bear4.map((v,i)=>v||bearD[i]);
  return {bullish, bearish, bull4, bear4, bullD, bearD};
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
    {key:'adx_estricto',     label:'ADX estricto (actual)'},
    {key:'sin_adx',          label:'Sin ADX (solo AO+Koncorde)'},
    {key:'adx_no_bajando',   label:'ADX no cayendo'},
    {key:'ml_rsi',           label:'ML RSI en vez de ADX'},
    {key:'confluencia_htf',  label:'Confluencia 1H+(4H o Diario)'}
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

  console.log('\n=== Fin del backtest ===');
}

main().catch(err=>{
  console.error('Error en el backtest:', err);
  process.exit(1);
});

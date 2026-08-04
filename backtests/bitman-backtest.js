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
  const msPerCandle = { '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000, '1d': 86400000 }[interval] || 3600000;
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
    larsi, larsiState
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
function simulateConfluenciaTPParcial(series4H, seriesD, tpPct, leverage, marginFraction, horasPorVela, fraccionCierre, protegerBreakeven){
  const idxD = alignDailyIndex(seriesD, series4H.times);
  const n = series4H.n;
  let equity = 1.0, peak = 1.0, maxDrawdown = 0;
  let position=null, entryPrice=null, tpPrice=null, entryIdx=null, tpParcialHecho=false, fraccionRestante=null, ultimoCierreIdx=null, equityAntesEntrada=null;
  const trades = [];
  const nocionalFraction = marginFraction * leverage;

  function cerrarFraccion(fraccion, exitPrice, feePct, iExit, iDesde){
    const rawReturn = position==='long' ? (exitPrice/entryPrice - 1) : (1 - exitPrice/entryPrice);
    const leveraged = rawReturn * leverage;
    const comisionPct = (nocionalFraction*fraccion) * (feePct/100) * 100;
    const horasAbierta = (iExit - iDesde) * horasPorVela;
    const periodosFunding = Math.floor(horasAbierta / 8);
    const fundingPct = (nocionalFraction*fraccion) * (BITGET_FUNDING_PCT_PER_8H/100) * periodosFunding * 100;
    const equityChange = (marginFraction*fraccion) * leveraged - comisionPct/100 - fundingPct/100;
    equity *= Math.max(0, 1 + equityChange);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }

  function cerrarOperacionCompleta(){
    trades.push({ equityChangePct: (equity/equityAntesEntrada - 1)*100, entryIdx, tocoTP: tpParcialHecho });
    position=null; entryPrice=null; tpPrice=null; entryIdx=null; tpParcialHecho=false; equityAntesEntrada=null;
  }

  for(let i=1;i<n;i++){
    const iD = idxD[i];
    if(position){
      if(!tpParcialHecho){
        const hitTP = position==='long' ? series4H.highs[i] >= tpPrice : series4H.lows[i] <= tpPrice;
        const forzado = position==='long' && !isNaN(series4H.konVal[i]) && !isNaN(series4H.maTrend[i]) && series4H.konVal[i] < series4H.maTrend[i];
        const v = verdicts4H_local(series4H, seriesD, i, iD);
        const stillValid = (position==='long' && v==='COMPRAR') || (position==='short' && v==='VENDER');
        if(hitTP){
          // Cierra la fracción indicada al precio del TP, deja correr el resto.
          cerrarFraccion(fraccionCierre, tpPrice, BITGET_MAKER_FEE_PCT, i, entryIdx);
          tpParcialHecho = true; fraccionRestante = 1-fraccionCierre; ultimoCierreIdx = i;
        } else if(forzado || !stillValid){
          cerrarFraccion(1.0, series4H.closes[i], BITGET_TAKER_FEE_PCT, i, entryIdx);
          cerrarOperacionCompleta();
        }
      } else {
        // Ya se cobró la parte parcial — el resto corre con las reglas normales
        // (y opcionalmente breakeven) hasta su propio cierre.
        const forzado = position==='long' && !isNaN(series4H.konVal[i]) && !isNaN(series4H.maTrend[i]) && series4H.konVal[i] < series4H.maTrend[i];
        const v = verdicts4H_local(series4H, seriesD, i, iD);
        const stillValid = (position==='long' && v==='COMPRAR') || (position==='short' && v==='VENDER');
        const hitBreakeven = protegerBreakeven && (position==='long' ? series4H.lows[i] <= entryPrice : series4H.highs[i] >= entryPrice);
        if(hitBreakeven){
          cerrarFraccion(fraccionRestante, entryPrice, BITGET_TAKER_FEE_PCT, i, ultimoCierreIdx);
          cerrarOperacionCompleta();
        } else if(forzado || !stillValid){
          cerrarFraccion(fraccionRestante, series4H.closes[i], BITGET_TAKER_FEE_PCT, i, ultimoCierreIdx);
          cerrarOperacionCompleta();
        }
      }
    }
    if(!position){
      const v = verdicts4H_local(series4H, seriesD, i, iD);
      if(v==='COMPRAR' || v==='VENDER'){
        position = v==='COMPRAR' ? 'long' : 'short';
        entryPrice = series4H.closes[i];
        tpPrice = position==='long' ? entryPrice*(1+tpPct/100) : entryPrice*(1-tpPct/100);
        entryIdx = i; tpParcialHecho=false; equityAntesEntrada=equity;
        const comisionEntradaPct = nocionalFraction * (BITGET_TAKER_FEE_PCT/100) * 100;
        equity *= Math.max(0, 1 - comisionEntradaPct/100);
      }
    }
  }
  if(position){
    const fraccionFinal = tpParcialHecho ? fraccionRestante : 1.0;
    const desde = tpParcialHecho ? ultimoCierreIdx : entryIdx;
    cerrarFraccion(fraccionFinal, series4H.closes[n-1], BITGET_TAKER_FEE_PCT, n-1, desde);
    cerrarOperacionCompleta();
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

  console.log('\n=== Fin del backtest ===');
}

main().catch(err=>{
  console.error('Error en el backtest:', err);
  process.exit(1);
});

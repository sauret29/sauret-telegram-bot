// ============================================================
// Bitman · Backtest — Trend Speed Analyzer en solitario (solo largos)
// ------------------------------------------------------------
// Estrategia deliberadamente simple, sin Koncorde/AO/ADX de por medio:
//   - Abre LARGO cuando el precio cierra por ENCIMA de la EMA dinámica
//     del Trend Speed Analyzer (cruce alcista).
//   - Cierra el largo cuando una vela cierra por DEBAJO de esa misma
//     línea. Sin Take Profit, sin Stop Loss — el único gatillo es la
//     propia línea dinámica.
// Se prueba en 1H, 4H y Diario por separado. Comisiones y funding
// reales de Bitget incluidos desde el principio, con position sizing.
// ============================================================

const MESES_HISTORICO = parseInt(process.env.MESES_HISTORICO || '6', 10);
const MESES_RESERVADOS = parseInt(process.env.MESES_RESERVADOS || '12', 10);
const LEVERAGE = 5;

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

async function fetchCandlesForMonths(interval, months, warmupMargin){
  if(warmupMargin==null) warmupMargin = 300;
  const msPerCandle = { '1h': 3600000, '4h': 14400000, '1d': 86400000 }[interval] || 3600000;
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
// MOTOR DEL TREND SPEED ANALYZER (ya construido y probado antes)
// ============================================================

// Función auxiliar que el motor necesita (máximo móvil sobre 'period' velas)
function highestPeriod(values,period){
  const out=new Array(values.length).fill(NaN);
  for(let i=0;i<values.length;i++){
    if(i>=period-1) out[i]=Math.max(...values.slice(i-period+1,i+1));
  }
  return out;
}

// ---------- AO + ADX (motor ya validado en la Confluencia) ----------
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
// Clasificación estándar (1 vela de lookback, la misma que usa toda la sesión)
function computeAoAdxState(highs,lows,closes){
  const n=closes.length;
  const ao = awesomeOscillator(highs,lows);
  const {adx} = adxWilder(highs,lows,closes,14);
  const aoState = new Array(n).fill('Sin datos');
  const adxSubiendo = new Array(n).fill(false);
  for(let i=1;i<n;i++){
    if(!isNaN(ao[i]) && !isNaN(ao[i-1])){
      const subiendo = ao[i] > ao[i-1];
      if(ao[i]>=0 && subiendo) aoState[i]='Alcista';
      else if(ao[i]>=0 && !subiendo) aoState[i]='Retroceso alcista';
      else if(ao[i]<0 && !subiendo) aoState[i]='Bajista';
      else aoState[i]='Retroceso bajista';
    }
    if(!isNaN(adx[i]) && !isNaN(adx[i-1])) adxSubiendo[i] = adx[i] > adx[i-1];
  }
  return { ao, adx, aoState, adxSubiendo };
}

// ============================================================
// TREND SPEED ANALYZER [Zeiierman] — motor replicado del Pine
// ============================================================

// RMA de Wilder (igual que ta.rma): semilla = SMA de los primeros 'period'
// valores, luego suavizado recursivo con peso 1/period.
function rma(values, period){
  const out = new Array(values.length).fill(NaN);
  let sum = 0;
  for(let i=0;i<values.length;i++){
    if(i < period){
      sum += values[i];
      if(i === period-1) out[i] = sum/period;
    } else {
      out[i] = (out[i-1]*(period-1) + values[i]) / period;
    }
  }
  return out;
}

// Media móvil ponderada linealmente (igual que ta.wma): el peso más alto
// es para el dato más reciente dentro de la ventana.
function wma(values, period){
  const out = new Array(values.length).fill(NaN);
  const denom = period*(period+1)/2;
  for(let i=0;i<values.length;i++){
    if(i >= period-1){
      let sum = 0;
      for(let k=0;k<period;k++){
        // values[i-k] es el dato "k pasos atrás"; peso = period-k (el más
        // reciente, k=0, pesa 'period'; el más antiguo, k=period-1, pesa 1).
        sum += values[i-k] * (period-k);
      }
      out[i] = sum/denom;
    }
  }
  return out;
}

// Hull Moving Average (igual que ta.hma): combina dos WMA de distinta
// longitud y las vuelve a suavizar con una WMA de longitud sqrt(period).
function hma(values, period){
  const half = Math.floor(period/2);
  const sqrtLen = Math.max(1, Math.round(Math.sqrt(period)));
  const wmaHalf = wma(values, half);
  const wmaFull = wma(values, period);
  const diff = values.map((_, i) => {
    if(isNaN(wmaHalf[i]) || isNaN(wmaFull[i])) return NaN;
    return 2*wmaHalf[i] - wmaFull[i];
  });
  return wma(diff, sqrtLen);
}

// Calcula la EMA dinámica y la "velocidad de tendencia" (trend speed) para
// toda la serie, vela a vela, exactamente como el indicador original:
//  1) Una EMA cuyo factor de suavizado (alpha) se acelera cuando el precio
//     se mueve rápido (usa el rango de los últimos 200 cierres como escala).
//  2) Un acumulador ("speed") que suma cada vela la diferencia entre
//     RMA(close,10) y RMA(open,10), y que se reinicia cada vez que el
//     precio cruza la EMA dinámica (cambio de tendencia).
//  3) La serie final que se pinta es un Hull MA (longitud 5) de ese
//     acumulador — eso es lo que usamos como señal: positivo = Alcista,
//     negativo = Bajista.
function computeTrendSpeed(closes, opens, opts){
  opts = opts || {};
  const maxLength = opts.maxLength || 50;
  const accelMultiplier = opts.accelMultiplier != null ? opts.accelMultiplier : 5.0;
  const n = closes.length;

  const absClose = closes.map(v=>Math.abs(v));
  const maxAbsClose200 = highestPeriod(absClose, 200);

  const deltaClose = new Array(n).fill(0);
  for(let i=0;i<n;i++){
    const prevClose = i>0 ? closes[i-1] : 0; // nz(counts_diff[1]) trata el primer valor como 0
    deltaClose[i] = Math.abs(closes[i] - prevClose);
  }
  const maxDelta200 = highestPeriod(deltaClose, 200);

  const c = rma(closes, 10);
  const o = rma(opens, 10);

  const dynEma = new Array(n).fill(NaN);
  const speedArr = new Array(n).fill(0);

  let speed = 0.0;
  let x1 = 0;

  for(let i=0;i<n;i++){
    // --- EMA dinámica ---
    const maxAbs = (maxAbsClose200[i] && maxAbsClose200[i] !== 0) ? maxAbsClose200[i] : 1;
    const countsDiffNorm = (closes[i] + maxAbs) / (2*maxAbs);
    const dynLength = 5 + countsDiffNorm * (maxLength - 5);

    const maxDeltaSafe = (maxDelta200[i] && maxDelta200[i] !== 0) ? maxDelta200[i] : 1;
    const accelFactor = deltaClose[i] / maxDeltaSafe;

    const alphaBase = 2 / (dynLength + 1);
    let alpha = alphaBase * (1 + accelFactor*accelMultiplier);
    if(alpha > 1) alpha = 1;
    if(alpha < 0) alpha = 0; // guarda defensiva, no debería darse con datos reales

    if(i === 0 || isNaN(dynEma[i-1])){
      dynEma[i] = closes[i];
    } else {
      dynEma[i] = alpha*closes[i] + (1-alpha)*dynEma[i-1];
    }

    // --- Cruce y acumulador de velocidad ---
    const cVal = isNaN(c[i]) ? 0 : c[i];
    const oVal = isNaN(o[i]) ? 0 : o[i];

    if(i > 0){
      const crossUp = closes[i] > dynEma[i] && closes[i-1] <= dynEma[i-1];
      const crossDown = closes[i] < dynEma[i] && closes[i-1] >= dynEma[i-1];
      if(crossUp){ x1 = i; speed = cVal - oVal; }
      if(crossDown){ x1 = i; speed = cVal - oVal; }
    }
    speed = speed + (cVal - oVal);
    speedArr[i] = speed;
  }

  const trendspeed = hma(speedArr, 5);
  const signal = trendspeed.map(v=>{
    if(isNaN(v)) return 'Sin datos';
    if(v > 0) return 'Alcista';
    if(v < 0) return 'Bajista';
    return 'Neutral';
  });

  return { dynEma, speed:speedArr, trendspeed, signal };
}

const BITGET_TAKER_FEE_PCT = 0.06;
const BITGET_FUNDING_PCT_PER_8H = 0.01;

// Simulador LARGO-SOLO: entra cuando el cierre pasa por ENCIMA de la EMA
// dinámica (cruce) Y ADEMÁS AO está "Alcista" Y ADX está subiendo. Sale
// cuando una vela CIERRA por debajo de la línea (sin cambios respecto a
// la versión anterior — el filtro extra solo endurece la ENTRADA).
// Si no se pasan aoState/adxSubiendo, se comporta igual que antes (solo cruce).
function simulateTrendSpeedLongOnly(closes, times, dynEma, leverage, marginFraction, horasPorVela, aoState, adxSubiendo){
  const n = closes.length;
  let equity = 1.0, peak = 1.0, maxDrawdown = 0;
  let inPosition = false, entryPrice = null, entryIdx = null;
  const trades = [];
  const nocionalFraction = marginFraction * leverage;

  const closeTrade = (exitPrice, exitIdx) => {
    const rawReturn = (exitPrice/entryPrice - 1);
    const leveraged = rawReturn * leverage;
    const comisionSalidaPct = nocionalFraction * (BITGET_TAKER_FEE_PCT/100) * 100;
    const horasAbierta = (exitIdx - entryIdx) * horasPorVela;
    const periodosFunding = Math.floor(horasAbierta / 8);
    const fundingPct = nocionalFraction * (BITGET_FUNDING_PCT_PER_8H/100) * periodosFunding * 100;
    const equityChange = marginFraction * leveraged - comisionSalidaPct/100 - fundingPct/100;
    equity *= Math.max(0, 1 + equityChange);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    trades.push({ equityChangePct: equityChange*100, entryIdx });
    inPosition = false; entryPrice = null; entryIdx = null;
  };

  for(let i=1;i<n;i++){
    if(isNaN(dynEma[i]) || isNaN(dynEma[i-1])) continue; // aún calentando (ventana de 200 velas)
    if(inPosition){
      if(closes[i] < dynEma[i]) closeTrade(closes[i], i);
    }
    if(!inPosition){
      const cruceAlcista = closes[i] > dynEma[i] && closes[i-1] <= dynEma[i-1];
      const filtroOk = !aoState || (aoState[i]==='Alcista' && adxSubiendo[i]);
      if(cruceAlcista && filtroOk){
        inPosition = true; entryPrice = closes[i]; entryIdx = i;
        const comisionEntradaPct = nocionalFraction * (BITGET_TAKER_FEE_PCT/100) * 100;
        equity *= Math.max(0, 1 - comisionEntradaPct/100);
      }
    }
  }
  if(inPosition) closeTrade(closes[n-1], n-1);

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

function pad(str,len){ str=String(str); return str.length>=len?str:str+' '.repeat(len-str.length); }
function padL(str,len){ str=String(str); return str.length>=len?str:' '.repeat(len-str.length)+str; }
function fmtPct(n){ return (n>=0?'+':'')+n.toFixed(2)+'%'; }

async function analizarTemporalidad(interval, label, horasPorVela){
  console.log('\n\n========================================');
  console.log('TEMPORALIDAD: ' + label);
  console.log('========================================');

  const ohlcv = await fetchCandlesForMonths(interval, MESES_HISTORICO, 300);
  console.log('Velas descargadas: ' + ohlcv.closes.length + ' (desde ' + new Date(ohlcv.times[0]).toISOString() + ' hasta ' + new Date(ohlcv.times[ohlcv.times.length-1]).toISOString() + ')');

  const ts = computeTrendSpeed(ohlcv.closes, ohlcv.opens);
  const dynEma = ts.dynEma;
  const { aoState, adxSubiendo } = computeAoAdxState(ohlcv.highs, ohlcv.lows, ohlcv.closes);

  console.log('\n--- Solo cruce vs cruce+AO+ADX (12% de capital) ---');
  console.log(pad('Variante',16) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  const rSoloCruce = simulateTrendSpeedLongOnly(ohlcv.closes, ohlcv.times, dynEma, LEVERAGE, 0.12, horasPorVela);
  const rConFiltro = simulateTrendSpeedLongOnly(ohlcv.closes, ohlcv.times, dynEma, LEVERAGE, 0.12, horasPorVela, aoState, adxSubiendo);
  console.log(pad('Solo cruce',16) + padL(rSoloCruce.trades,9) + padL(rSoloCruce.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(rSoloCruce.totalReturnPct),12) + padL('-'+rSoloCruce.maxDrawdownPct.toFixed(1)+'%',11) + padL(rSoloCruce.profitFactor.toFixed(2),10));
  console.log(pad('+ AO + ADX',16) + padL(rConFiltro.trades,9) + padL(rConFiltro.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(rConFiltro.totalReturnPct),12) + padL('-'+rConFiltro.maxDrawdownPct.toFixed(1)+'%',11) + padL(rConFiltro.profitFactor.toFixed(2),10));

  console.log('\n--- Barrido de capital usado, CON el filtro AO+ADX ---');
  console.log(pad('% capital usado',18) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  [2,4,8,12,20].forEach(marginPct=>{
    const r = simulateTrendSpeedLongOnly(ohlcv.closes, ohlcv.times, dynEma, LEVERAGE, marginPct/100, horasPorVela, aoState, adxSubiendo);
    console.log(pad(marginPct+'%',18) + padL(r.trades,9) + padL(r.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(r.totalReturnPct),12) + padL('-'+r.maxDrawdownPct.toFixed(1)+'%',11) + padL(r.profitFactor.toFixed(2),10));
  });

  console.log('\n--- Walk-forward año por año, CON el filtro AO+ADX (12% de capital) ---');
  const rWF = rConFiltro;
  console.log(pad('Año',8) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('Drawdown',11) + padL('P.Factor',10));
  const buckets = {};
  rWF.tradeLog.forEach(t=>{
    const year = new Date(ohlcv.times[t.entryIdx]).getUTCFullYear();
    if(!buckets[year]) buckets[year] = [];
    buckets[year].push(t);
  });
  let aniosPositivos = 0, aniosTotal = 0;
  Object.keys(buckets).map(Number).sort((a,b)=>a-b).forEach(year=>{
    const m = metricsForTradeSubset(buckets[year]);
    console.log(pad(String(year),8) + padL(m.trades,9) + padL(m.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(m.totalReturnPct),12) + padL('-'+m.maxDrawdownPct.toFixed(1)+'%',11) + padL(m.profitFactor.toFixed(2),10));
    aniosTotal++;
    if(m.totalReturnPct>0) aniosPositivos++;
  });
  console.log('Años con retorno positivo: ' + aniosPositivos + ' de ' + aniosTotal);

  // Validación fuera de muestra: últimos MESES_RESERVADOS meses, aislados
  const cutoffReservado = ohlcv.times[ohlcv.times.length-1] - MESES_RESERVADOS*30*86400000;
  const tradesAntes = rWF.tradeLog.filter(t => ohlcv.times[t.entryIdx] < cutoffReservado);
  const tradesReservado = rWF.tradeLog.filter(t => ohlcv.times[t.entryIdx] >= cutoffReservado);
  const mAntes = metricsForTradeSubset(tradesAntes);
  const mReservado = metricsForTradeSubset(tradesReservado);
  console.log('\n--- Fuera de muestra, CON el filtro AO+ADX: últimos ' + MESES_RESERVADOS + ' meses reservados (12% capital) ---');
  console.log(pad('Tramo',20) + padL('Operac.',9) + padL('% Acierto',11) + padL('Retorno',12) + padL('P.Factor',10));
  console.log(pad('Resto del histórico',20) + padL(mAntes.trades,9) + padL(mAntes.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(mAntes.totalReturnPct),12) + padL(mAntes.profitFactor.toFixed(2),10));
  console.log(pad('TRAMO RESERVADO',20) + padL(mReservado.trades,9) + padL(mReservado.winRatePct.toFixed(1)+'%',11) + padL(fmtPct(mReservado.totalReturnPct),12) + padL(mReservado.profitFactor.toFixed(2),10));
}

async function main(){
  console.log('=== Bitman Backtest — Trend Speed Analyzer en solitario (solo largos) ===');
  console.log('Símbolo: ' + SYMBOL + ' · Periodo: últimos ' + MESES_HISTORICO + ' meses · Apalancamiento: ' + LEVERAGE + 'x');
  console.log('Sin Take Profit ni Stop Loss — solo entra/sale con el cruce de la EMA dinámica.');

  await analizarTemporalidad('1h', '1 HORA', 1);
  await analizarTemporalidad('4h', '4 HORAS', 4);
  await analizarTemporalidad('1d', 'DIARIO', 24);

  console.log('\n=== Fin del backtest ===');
}

main().catch(err=>{
  console.error('Error en el backtest:', err);
  process.exit(1);
});

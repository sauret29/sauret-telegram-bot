// ============================================================
// Bitman · Bot de avisos por Telegram
// ------------------------------------------------------------
// Ejecuta el MISMO motor de indicadores que el dashboard HTML
// (copiado tal cual, sin modificar — ya probado con 60 tests),
// y avisa por Telegram solo cuando cambia el veredicto de alguna
// temporalidad o se activa una alerta de retroceso/rebote.
//
// Pensado para correr con GitHub Actions cada X minutos (gratis).
// No necesita ninguna librería externa (usa fetch nativo de Node 18+).
// ============================================================

const fs = require('fs');
const path = require('path');

// ---------- Configuración (variables de entorno) ----------
const SYMBOL = process.env.SYMBOL || 'BTCUSDT';
const STRATEGY = process.env.STRATEGY || 'base';                         // 'base' | 'pro'
const KONCORDE_FILTER = (process.env.KONCORDE_FILTER || 'true') === 'true';
const ENHANCED_FILTER = (process.env.ENHANCED_FILTER || 'false') === 'true';
const REINFORCED_DAILY_GATE = (process.env.REINFORCED_DAILY_GATE || 'false') === 'true';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

const STATE_FILE = path.join(__dirname, 'state.json');

const HOSTS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com'
];
const TIMEFRAMES = [
  {key:'W',  label:'Semanal', interval:'1w'},
  {key:'D',  label:'Diario',  interval:'1d'},
  {key:'H4', label:'4 Horas', interval:'4h'},
  {key:'H1', label:'1 Hora',  interval:'1h'}
];
const SIGNAL_LIMIT = 1000;

/* =========================================================
   MOTOR DE INDICADORES — copiado tal cual del dashboard HTML,
   sin modificar ni una línea. No editar esta sección a mano;
   si el motor del HTML cambia, se vuelve a copiar entero.
========================================================= */
const ADX_MIN_LEVEL = 20;
const BBWP_MIN_LEVEL = 25;
const CONFIRM_LOOKBACK = 3;

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

function alignDailyAO(dailySeries, targetTimes){
  // Para cada bar objetivo, busca el AO del último cierre diario <= su timestamp
  const dTimes=dailySeries.times, dAO=dailySeries.ao;
  const out=new Array(targetTimes.length).fill(NaN);
  let j=0;
  for(let i=0;i<targetTimes.length;i++){
    while(j+1<dTimes.length && dTimes[j+1]<=targetTimes[i]) j++;
    if(dTimes[j]<=targetTimes[i]) out[i]=dAO[j];
  }
  return out;
}

// Igual que alignDailyAO pero devuelve el ÍNDICE del diario alineado (no el valor),
// para poder consultar cualquier campo diario (incluidas varias velas hacia atrás).
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

const DAILY_SUSTAIN_BARS = 2; // nº de cierres diarios consecutivos exigidos por la confirmación reforzada

// Confirmación diaria reforzada al alza: AO en estado "Alcista" sostenido varias velas + Koncorde y ADX confirmando ahora mismo.
function dailyConfirmsBullishSustained(dailySeries, idx, sustainBars){
  if(idx==null || idx<0 || idx<sustainBars-1) return false;
  for(let k=0;k<sustainBars;k++){
    if(dailySeries.aoState[idx-k]!=='Alcista') return false;
  }
  return dailySeries.koBull[idx]===true && dailySeries.adxSubiendo[idx]===true;
}
// Confirmación diaria reforzada a la baja (para forzar salida anticipada de 4h/1h en modo Pro).
function dailyConfirmsBearishAt(dailySeries, idx){
  if(idx==null || idx<0) return false;
  return dailySeries.aoState[idx]==='Bajista' && dailySeries.koBear[idx]===true && dailySeries.adxSubiendo[idx]===true;
}

// Construye, para cada bar objetivo (p.ej. cada vela de 4h), si el Diario alineado confirma alcista/bajista.
// reinforced=false reproduce el filtro simple original (dailyAO>=0, nunca fuerza salida).
function computeDailyGateArrays(dailySeries, targetTimes, reinforced, sustainBars){
  const dIdx = alignDailyIndex(dailySeries, targetTimes);
  const n = targetTimes.length;
  const bullish = new Array(n).fill(false);
  const bearish = new Array(n).fill(false);
  for(let i=0;i<n;i++){
    const idx = dIdx[i];
    if(idx<0) continue;
    if(reinforced){
      bullish[i] = dailyConfirmsBullishSustained(dailySeries, idx, sustainBars||DAILY_SUSTAIN_BARS);
      bearish[i] = dailyConfirmsBearishAt(dailySeries, idx);
    } else {
      bullish[i] = !isNaN(dailySeries.ao[idx]) && dailySeries.ao[idx]>=0;
      bearish[i] = false;
    }
  }
  return {bullish, bearish};
}

/* =========================================================
   VEREDICTOS (Base / Pro) + filtro Koncorde>media
========================================================= */
function computeMomentumState(s, i, enhanced){
  const lookback = enhanced ? CONFIRM_LOOKBACK : 1;
  if(i < lookback || isNaN(s.ao[i]) || isNaN(s.ao[i-lookback])){
    return { aoState:'Sin datos', adxSubiendo:false };
  }
  const subiendo = s.ao[i] > s.ao[i-lookback];
  let aoState;
  if(s.ao[i]>=0 && subiendo) aoState='Alcista';
  else if(s.ao[i]>=0 && !subiendo) aoState='Retroceso alcista';
  else if(s.ao[i]<0 && !subiendo) aoState='Bajista';
  else aoState='Retroceso bajista';
  const adxSubiendo = !isNaN(s.adx[i]) && !isNaN(s.adx[i-lookback]) && s.adx[i] > s.adx[i-lookback];
  return { aoState, adxSubiendo };
}

function baseVerdictAt(s, i, opts){
  opts = opts || {};
  const enhanced = !!opts.enhanced;
  const entryMs = enhanced ? computeMomentumState(s,i,true) : {aoState:s.aoState[i], adxSubiendo:s.adxSubiendo[i]};
  let comprarOk = entryMs.aoState==='Alcista' && entryMs.adxSubiendo && s.koBull[i];
  // las SALIDAS siempre usan la lectura estándar de 1 vela: el filtro reforzado nunca debe retrasar un cierre
  const venderOk = s.aoState[i]==='Bajista' && s.adxSubiendo[i] && s.koBear[i];
  let adxFloorOk=true, bbwpOk=true;
  if(enhanced){
    adxFloorOk = !isNaN(s.adx[i]) && s.adx[i] >= ADX_MIN_LEVEL;
    bbwpOk = !isNaN(s.bbwp[i]) && s.bbwp[i] > BBWP_MIN_LEVEL;
    comprarOk = comprarOk && adxFloorOk && bbwpOk; // el filtro extra solo endurece la ENTRADA, nunca la salida
  }
  const verdict = comprarOk ? 'COMPRAR' : (venderOk ? 'VENDER' : 'ESPERAR');
  return { verdict, aoState:entryMs.aoState, adxSubiendo:entryMs.adxSubiendo, adxFloorOk, bbwpOk };
}

function computeCardVerdict(tfKey, s, dailyGateBullish, dailyGateBearish, strategy, koncordeFilterActive, enhancedFilter){
  const i=s.n-1, prev=s.n-2;
  const base = baseVerdictAt(s,i,{enhanced:enhancedFilter});
  let verdict = base.verdict;
  let vetoedPro=false;
  let dailyBearishExit=false;
  const isIntraday=(tfKey==='H4'||tfKey==='H1');

  if(strategy==='pro' && isIntraday){
    if(verdict==='COMPRAR' && !dailyGateBullish){ verdict='ESPERAR'; vetoedPro=true; }
    else if(dailyGateBearish){ verdict='VENDER'; dailyBearishExit=true; }
  }

  let filterForced=false;
  if(koncordeFilterActive && !isNaN(s.konVal[i]) && !isNaN(s.maTrend[i]) && s.konVal[i] < s.maTrend[i]){
    if(verdict!=='VENDER'){ verdict='VENDER'; filterForced=true; }
    else filterForced=true;
  }

  // motivo
  let motivo='';
  if(verdict==='COMPRAR'){
    motivo = enhancedFilter
      ? 'AO alcista confirmado en '+CONFIRM_LOOKBACK+' velas, ADX≥'+ADX_MIN_LEVEL+' con impulso, BBWP fuera de compresión y Koncorde confirmando (koBull).'
      : 'AO alcista con impulso ADX creciente y Koncorde confirmando fuerza compradora (koBull).';
  } else if(verdict==='VENDER'){
    if(filterForced) motivo = strategy==='pro'
      ? 'Cierre forzado: Koncorde por debajo de su media (maTrend).'
      : 'Forzado a VENDER: Koncorde por debajo de su media (maTrend).';
    else if(dailyBearishExit) motivo = 'Cierre anticipado: el Diario ha confirmado giro bajista (AO Bajista + ADX subiendo + koBear).';
    else motivo = strategy==='pro'
      ? 'Señal de cierre de largos: AO bajista con impulso ADX creciente y koBear.'
      : 'AO bajista con impulso ADX creciente y Koncorde confirmando presión vendedora (koBear).';
  } else {
    const razones=[];
    if(vetoedPro) razones.push('el Diario no confirma tendencia alcista (filtro de tendencia diaria del modo Pro)');
    if(base.aoState==='Retroceso alcista') razones.push('el AO está en retroceso dentro de una tendencia alcista');
    else if(base.aoState==='Retroceso bajista') razones.push('el AO está en retroceso dentro de una tendencia bajista');
    else if(base.aoState==='Sin datos') razones.push('no hay datos suficientes para el AO');
    if(!base.adxSubiendo) razones.push('el ADX no muestra impulso creciente'+(enhancedFilter?(' (confirmado en '+CONFIRM_LOOKBACK+' velas)'):''));
    if(enhancedFilter && !base.adxFloorOk) razones.push('el ADX está por debajo de '+ADX_MIN_LEVEL+' (sin tendencia real según Wilder)');
    if(enhancedFilter && !base.bbwpOk) razones.push('el BBWP indica compresión de volatilidad (<'+BBWP_MIN_LEVEL+')');
    if(razones.length===0) razones.push('no se cumplen todas las condiciones de la estrategia');
    motivo='Se mantiene en espera porque '+razones.join(', y ')+'.';
  }

  return {verdict, motivo, vetoedPro, filterForced, dailyBearishExit};
}

// Alerta temprana de posible agotamiento de la tendencia (retroceso si es alcista, posible rebote si es
// bajista) — NO es un VENDER/COMPRAR, es un aviso informativo para decidir manualmente (cerrar parcial,
// cerrar todo, o esperar). Funciona en ambas direcciones, siempre activa, sin selector.
function computeEarlyExitWarning(s, i, divergences){
  if(i<1) return {active:false, reasons:[], direction:null};
  const bullishContext = s.aoState[i]==='Alcista' || s.aoState[i]==='Retroceso alcista';
  const bearishContext = s.aoState[i]==='Bajista' || s.aoState[i]==='Retroceso bajista';
  if(!bullishContext && !bearishContext) return {active:false, reasons:[], direction:null};

  const reasons=[];
  if(bullishContext){
    if(s.aoState[i]==='Retroceso alcista'){
      reasons.push('AO en retroceso dentro de la tendencia alcista (el impulso comprador pierde fuerza)');
    }
    if(!isNaN(s.konVal[i]) && !isNaN(s.maTrend[i]) && s.konVal[i]>0 && s.konVal[i]<s.maTrend[i]){
      reasons.push('Koncorde por debajo de su media aunque sigue en positivo (el dinero grande empieza a soltar)');
    }
    if(!isNaN(s.adx[i]) && !isNaN(s.adx[i-1]) && s.adx[i]<s.adx[i-1]){
      reasons.push('el ADX ha dejado de subir (pérdida de impulso direccional)');
    }
    if(divergences && divergences.length){
      const recentBearish = divergences.find(d=> d.type==='bearish' && d.i2>=i-5);
      if(recentBearish){
        reasons.push('divergencia bajista '+(recentBearish.confirmed?'confirmada':'provisional')+' reciente entre precio y AO');
      }
    }
  } else {
    if(s.aoState[i]==='Retroceso bajista'){
      reasons.push('AO en retroceso dentro de la tendencia bajista (el impulso vendedor pierde fuerza)');
    }
    if(!isNaN(s.konVal[i]) && !isNaN(s.maTrend[i]) && s.konVal[i]<0 && s.konVal[i]>s.maTrend[i]){
      reasons.push('Koncorde por encima de su media aunque sigue en negativo (las ventas empiezan a frenar)');
    }
    if(!isNaN(s.adx[i]) && !isNaN(s.adx[i-1]) && s.adx[i]<s.adx[i-1]){
      reasons.push('el ADX ha dejado de subir (pérdida de impulso direccional)');
    }
    if(divergences && divergences.length){
      const recentBullish = divergences.find(d=> d.type==='bullish' && d.i2>=i-5);
      if(recentBullish){
        reasons.push('divergencia alcista '+(recentBullish.confirmed?'confirmada':'provisional')+' reciente entre precio y AO');
      }
    }
  }
  return { active: reasons.length>0, reasons, direction: bullishContext?'alcista':'bajista' };
}

/* =========================================================
   MÁQUINAS DE ESTADO LARGO/FUERA (genérica)
========================================================= */
function computeLongFlatSeries(n, entryFn, exitFn){
  const state=new Array(n).fill(false);
  let long=false;
  for(let i=1;i<n;i++){
    if(long){ if(exitFn(i)) long=false; }
    else { if(entryFn(i)) long=true; }
    state[i]=long;
  }
  return state;
}

/* Igual que computeLongFlatSeries, pero con stop-loss técnico opcional (stopMultiplier×ATR14)
   y toma de ganancias opcional (takeProfitPct, % sobre el precio de entrada).
   Con stopMultiplier=0 y takeProfitPct=0 se comporta EXACTAMENTE igual que computeLongFlatSeries.
   Si en la misma vela se tocan stop y toma de ganancias, se prioriza el stop (asunción conservadora). */
function computeLongFlatSeriesWithStop(n, entryFn, exitFn, closes, lows, atr, stopMultiplier, highs, takeProfitPct){
  const state=new Array(n).fill(false);
  const stoppedOut=new Array(n).fill(false);
  const tookProfit=new Array(n).fill(false);
  const exitPriceOverride=new Array(n).fill(NaN);
  const tpActive = (takeProfitPct||0) > 0 && !!highs;
  let long=false, stopLevel=null, tpLevel=null;
  for(let i=1;i<n;i++){
    if(long){
      if(stopMultiplier>0 && stopLevel!=null && lows[i]<=stopLevel){
        long=false; stoppedOut[i]=true; exitPriceOverride[i]=stopLevel;
      } else if(tpActive && tpLevel!=null && highs[i]>=tpLevel){
        long=false; tookProfit[i]=true; exitPriceOverride[i]=tpLevel;
      } else if(exitFn(i)){
        long=false;
      }
    } else {
      if(entryFn(i)){
        long=true;
        const atrAtEntry = (atr && !isNaN(atr[i]) && atr[i]>0) ? atr[i] : (closes[i]*0.01);
        stopLevel = stopMultiplier>0 ? (closes[i]-stopMultiplier*atrAtEntry) : null;
        tpLevel = tpActive ? (closes[i]*(1+takeProfitPct/100)) : null;
      }
    }
    state[i]=long;
  }
  return {state, stoppedOut, tookProfit, exitPriceOverride};
}

function computeCapitalAllocation(seriesH4, seriesD, koncordeFilterActive, enhancedFilter, stopMultiplier, takeProfitPct, reinforcedDailyGate){
  const mult = stopMultiplier || 0;
  const tp = takeProfitPct || 0;
  const gateH4 = computeDailyGateArrays(seriesD, seriesH4.times, !!reinforcedDailyGate, DAILY_SUSTAIN_BARS);

  const entryA=(i)=> baseVerdictAt(seriesH4,i,{enhanced:enhancedFilter}).verdict==='COMPRAR' && gateH4.bullish[i];
  const exitA=(i)=> baseVerdictAt(seriesH4,i,{enhanced:enhancedFilter}).verdict==='VENDER' ||
                     (koncordeFilterActive && !isNaN(seriesH4.konVal[i]) && !isNaN(seriesH4.maTrend[i]) && seriesH4.konVal[i]<seriesH4.maTrend[i]) ||
                     gateH4.bearish[i];
  const stateA=computeLongFlatSeriesWithStop(seriesH4.n, entryA, exitA, seriesH4.closes, seriesH4.lows, seriesH4.atr, mult, seriesH4.highs, tp).state;

  const entryB=(i)=> baseVerdictAt(seriesD,i,{enhanced:enhancedFilter}).verdict==='COMPRAR';
  const exitB=(i)=> baseVerdictAt(seriesD,i,{enhanced:enhancedFilter}).verdict==='VENDER' ||
                     (koncordeFilterActive && !isNaN(seriesD.konVal[i]) && !isNaN(seriesD.maTrend[i]) && seriesD.konVal[i]<seriesD.maTrend[i]);
  const stateB=computeLongFlatSeriesWithStop(seriesD.n, entryB, exitB, seriesD.closes, seriesD.lows, seriesD.atr, mult, seriesD.highs, tp).state;

  const longA=stateA[stateA.length-1]===true;
  const longB=stateB[stateB.length-1]===true;
  const pct=(longA?80:0)+(longB?20:0);
  return {longA, longB, pct};
}

/* =========================================================
   DIVERGENCIAS (pivotes del AO)
========================================================= */
function findConfirmedPivots(ao, window, nLimit){
  const highs=[], lows=[];
  const n = nLimit!=null ? nLimit : ao.length;
  for(let i=window;i<n-window;i++){
    if(isNaN(ao[i])) continue;
    let isHigh=true, isLow=true;
    for(let j=i-window;j<=i+window;j++){
      if(j===i||isNaN(ao[j])) continue;
      if(ao[j]>=ao[i]) isHigh=false;
      if(ao[j]<=ao[i]) isLow=false;
    }
    if(isHigh) highs.push(i);
    if(isLow) lows.push(i);
  }
  return {highs, lows};
}
function findProvisionalPivot(ao, window, n){
  // extremo más reciente que supera a sus vecinos de la izquierda dentro de la ventana
  for(let i=n-1;i>=Math.max(1,n-window-1);i--){
    if(isNaN(ao[i])) continue;
    let isHigh=true, isLow=true;
    const leftStart=Math.max(0,i-window);
    for(let j=leftStart;j<i;j++){
      if(isNaN(ao[j])) continue;
      if(ao[j]>=ao[i]) isHigh=false;
      if(ao[j]<=ao[i]) isLow=false;
    }
    for(let j=i+1;j<n;j++){
      if(isNaN(ao[j])) continue;
      if(ao[j]>=ao[i]) isHigh=false;
      if(ao[j]<=ao[i]) isLow=false;
    }
    if(isHigh) return {index:i, type:'high'};
    if(isLow) return {index:i, type:'low'};
  }
  return null;
}
function detectDivergences(s, window){
  const n=s.n;
  const {highs, lows}=findConfirmedPivots(s.ao, window, n);
  const divergences=[];
  for(let k=1;k<highs.length;k++){
    const i2=highs[k], i1=highs[k-1];
    if(s.highs[i2] > s.highs[i1] && s.ao[i2] < s.ao[i1]){
      divergences.push({type:'bearish', i1, i2, confirmed:true});
    }
  }
  for(let k=1;k<lows.length;k++){
    const i2=lows[k], i1=lows[k-1];
    if(s.lows[i2] < s.lows[i1] && s.ao[i2] > s.ao[i1]){
      divergences.push({type:'bullish', i1, i2, confirmed:true});
    }
  }
  // pivote provisional en el borde derecho
  const prov=findProvisionalPivot(s.ao, window, n);
  if(prov){
    if(prov.type==='high' && highs.length){
      const i1=highs[highs.length-1];
      if(i1<prov.index && s.highs[prov.index]>s.highs[i1] && s.ao[prov.index]<s.ao[i1]){
        divergences.push({type:'bearish', i1, i2:prov.index, confirmed:false});
      }
    } else if(prov.type==='low' && lows.length){
      const i1=lows[lows.length-1];
      if(i1<prov.index && s.lows[prov.index]<s.lows[i1] && s.ao[prov.index]>s.ao[i1]){
        divergences.push({type:'bullish', i1, i2:prov.index, confirmed:false});
      }
    }
  }
  return divergences;
}

/* =========================================================
   ZONAS DE IMPULSO
========================================================= */


/* =========================================================
   FIN DEL MOTOR DE INDICADORES
========================================================= */

// ---------- Descarga de datos (Node: sin problema de CORS, no hace falta proxy) ----------
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

async function fetchChartCandles(interval){
  const page1 = await fetchKlinesRaw(interval, SIGNAL_LIMIT);
  let all = page1;
  if(page1.length >= SIGNAL_LIMIT){
    try{
      const oldestOpenTime = page1[0][0];
      const page2 = await fetchKlinesRaw(interval, SIGNAL_LIMIT, oldestOpenTime-1);
      if(page2 && page2.length) all = page2.concat(page1);
    }catch(e){ /* seguimos con lo que tenemos */ }
  }
  const map = new Map();
  all.forEach(k=>map.set(k[0],k));
  const sorted = Array.from(map.values()).sort((a,b)=>a[0]-b[0]);
  const capped = sorted.slice(-2000);
  return {
    times:capped.map(k=>k[0]),
    opens:capped.map(k=>parseFloat(k[1])),
    highs:capped.map(k=>parseFloat(k[2])),
    lows:capped.map(k=>parseFloat(k[3])),
    closes:capped.map(k=>parseFloat(k[4])),
    volumes:capped.map(k=>parseFloat(k[5]))
  };
}

// ---------- Telegram ----------
async function sendTelegramMessage(text){
  if(!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID){
    console.log('[SIN CONFIGURAR] Falta TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID.');
    console.log('Mensaje que se habría enviado:\n' + text);
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' })
  });
  if(!resp.ok){
    const body = await resp.text();
    throw new Error('Error al enviar a Telegram: HTTP ' + resp.status + ' — ' + body);
  }
}

// ---------- Estado persistido entre ejecuciones ----------
function loadState(){
  try{
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  }catch(e){
    return { symbol: null, verdicts: {}, warnings: {} };
  }
}
function saveState(state){
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

// ---------- Programa principal ----------
// Calcula y avisa SIEMPRE con las dos estrategias en paralelo (Base y Pro),
// diferenciadas en el mensaje de Telegram con una etiqueta [Base] / [Pro].
// La variable de entorno STRATEGY ya no elige una sola estrategia: se deja
// solo por compatibilidad y aparece en el log informativo si está definida.
const STRATEGIES = ['base', 'pro'];
const STRATEGY_LABEL = { base: 'Base', pro: 'Pro' };

async function main(){
  const now = new Date();
  console.log('Bitman Bot — comprobando ' + SYMBOL + ' a las ' + now.toISOString());
  console.log('Estrategias: Base + Pro (en paralelo) · Koncorde>media: ' + KONCORDE_FILTER + ' · Confirmación reforzada: ' + ENHANCED_FILTER + ' · Puerta diaria reforzada: ' + REINFORCED_DAILY_GATE);

  const prevState = loadState();
  const sameSymbol = prevState.symbol === SYMBOL;
  // Compatibilidad con el formato de estado anterior (una sola estrategia):
  // si el state.json es del formato viejo, se trata como si no hubiera datos
  // previos para esa estrategia, así no se envían avisos falsos al migrar.
  const prevVerdictsByStrategy = (prevState.verdicts && prevState.verdicts.base && prevState.verdicts.pro)
    ? prevState.verdicts
    : { base: {}, pro: {} };
  const prevWarnings = prevState.warnings || {};

  const rawResults = {};
  for(const tf of TIMEFRAMES){
    try{
      const ohlcv = await fetchChartCandles(tf.interval);
      rawResults[tf.key] = computeFullSeries(ohlcv);
      console.log('  ' + tf.label + ': OK (' + rawResults[tf.key].n + ' velas)');
    }catch(err){
      console.error('  ' + tf.label + ': ERROR — ' + err.message);
      rawResults[tf.key] = null;
    }
  }

  // La puerta diaria (filtro de tendencia del modo Pro) se calcula siempre,
  // independientemente de si luego se usa (solo la consume la estrategia Pro).
  const dailySeries = rawResults['D'];
  let gateH4 = null, gateH1 = null;
  if(dailySeries){
    if(rawResults['H4']) gateH4 = computeDailyGateArrays(dailySeries, rawResults['H4'].times, REINFORCED_DAILY_GATE, DAILY_SUSTAIN_BARS);
    if(rawResults['H1']) gateH1 = computeDailyGateArrays(dailySeries, rawResults['H1'].times, REINFORCED_DAILY_GATE, DAILY_SUSTAIN_BARS);
  }

  const messages = [];
  const newVerdicts = { base: {}, pro: {} };
  const newWarnings = {};

  TIMEFRAMES.forEach(tf=>{
    const s = rawResults[tf.key];
    if(!s){ return; }

    const gate = tf.key==='H4' ? gateH4 : (tf.key==='H1' ? gateH1 : null);
    const last = s.n - 1;
    const gateBullishLast = gate ? !!gate.bullish[last] : false;
    const gateBearishLast = gate ? !!gate.bearish[last] : false;

    // La alerta temprana (divergencias) no depende de la estrategia: se calcula una vez.
    const divergences = detectDivergences(s, 8);
    const warning = computeEarlyExitWarning(s, last, divergences);
    newWarnings[tf.key] = warning.active;

    let logLine = '  ' + tf.label + ' →';

    STRATEGIES.forEach(strategy=>{
      const cv = computeCardVerdict(tf.key, s, gateBullishLast, gateBearishLast, strategy, KONCORDE_FILTER, ENHANCED_FILTER);
      newVerdicts[strategy][tf.key] = cv.verdict;
      logLine += ' [' + STRATEGY_LABEL[strategy] + ': ' + cv.verdict + ']';

      if(sameSymbol){
        const prevVerdict = prevVerdictsByStrategy[strategy] ? prevVerdictsByStrategy[strategy][tf.key] : undefined;
        if(prevVerdict && prevVerdict !== cv.verdict){
          messages.push('🔔 <b>[' + STRATEGY_LABEL[strategy] + '] ' + tf.label + '</b>: ' + prevVerdict + ' → <b>' + cv.verdict + '</b>\n' + escapeHtml(cv.motivo));
        }
      }
    });

    console.log(logLine + (warning.active ? ' (⚠️ aviso activo, dirección ' + warning.direction + ')' : ''));

    // La alerta de retroceso/rebote se envía una sola vez por temporalidad
    // (es la misma para las dos estrategias, no es exclusiva de ninguna).
    if(sameSymbol){
      const wasWarning = !!prevWarnings[tf.key];
      if(warning.active && !wasWarning){
        const dirLabel = warning.direction === 'bajista' ? 'Alerta de posible rebote' : 'Alerta de retroceso';
        messages.push('⚠️ <b>' + tf.label + '</b> — ' + dirLabel + '\n' + escapeHtml(warning.reasons.join(' · ')));
      }
    }
  });

  if(!sameSymbol){
    console.log('Primera comprobación para este símbolo (o símbolo distinto al de la última vez): se guarda la línea base sin enviar avisos.');
  }

  if(messages.length){
    const header = '📊 <b>Bitman · ' + SYMBOL + '</b>\n\n';
    await sendTelegramMessage(header + messages.join('\n\n'));
    console.log(messages.length + ' aviso(s) enviado(s) a Telegram.');
  } else {
    console.log('Sin cambios de señal esta vez — no se envía nada.');
  }

  saveState({ symbol: SYMBOL, verdicts: newVerdicts, warnings: newWarnings, lastCheck: now.toISOString() });
}

function escapeHtml(str){
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

main().catch(err=>{
  console.error('Error fatal:', err);
  process.exit(1);
});

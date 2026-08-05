// ============================================================
// MOTOR COMPARTIDO · Bots de alertas Bitman en vivo
// ------------------------------------------------------------
// Este archivo contiene TODO lo que "El Cauto Temerario" y
// "El Zorro Salvaje" tenían duplicado: descarga de velas, motor
// de indicadores, veredicto, máquina de estados y envío a
// Telegram. Los dos bots pasan a ser un archivo de configuración
// de unas pocas líneas.
//
// Antes eran dos archivos de ~650 líneas cuya única diferencia
// funcional era FRACCION_TP_PARCIAL (0.5 vs 0.20). Cualquier
// arreglo había que aplicarlo dos veces sin equivocarse.
//
// ------------------------------------------------------------
// CORRECCIONES INCLUIDAS (respecto a los bots anteriores)
// ------------------------------------------------------------
// 1. CIERRE FORZADO DE KONCORDE — antes reescribía el veredicto
//    global a 'VENDER' sin mirar si había posición. Eso hacía tres
//    cosas que el backtest NO hace: abría cortos nuevos con una
//    sola condición, impedía cerrar cortos (stillValid se quedaba
//    verdadero) y pisaba cualquier COMPRAR válido.
//    Ahora se comporta como en el backtest (bitman-backtest.js,
//    líneas 1477 y 1494): solo cierra LARGOS, se evalúa únicamente
//    con posición abierta, y jamás genera una entrada.
//
// 2. VELA CERRADA — antes se decidía sobre la vela de 4H EN CURSO
//    (índice n-1 del array que devuelve Binance, que incluye la
//    vela viva). Con el cron cada 15 minutos, la misma vela se
//    evaluaba 16 veces mientras aún podía cambiar: repintado.
//    Ahora se descartan las velas sin cerrar antes de calcular nada.
//
// 3. REPLAY DESDE LA ÚLTIMA VELA PROCESADA — antes solo se miraba
//    la última vela, así que si un run fallaba o GitHub se saltaba
//    la ejecución programada, el TP tocado en una vela intermedia
//    se perdía para siempre. Ahora el estado guarda hasta qué vela
//    se procesó y se recorren todas las cerradas desde entonces,
//    igual que hace el bucle del backtest.
//
// 4. ESTADO SOLO SI EL AVISO LLEGA — antes el estado se guardaba
//    aunque el envío a Telegram fallara: el bot te daba por dentro
//    de una posición de la que nunca te enteraste. Ahora, si el
//    envío falla, no se guarda nada y el run termina en error, así
//    que la siguiente ejecución vuelve a intentarlo.
//
// ------------------------------------------------------------
// AVISO PENDIENTE (no corregido aquí a propósito)
// ------------------------------------------------------------
// alignDailyIndex asocia a cada vela de 4H la vela DIARIA que la
// contiene. En el backtest esa vela diaria ya está cerrada, así que
// sus indicadores usan el cierre del día — información que en vivo
// todavía no existe cuando se opera la vela de 4H de las 04:00.
// El backtest, por tanto, es optimista respecto a lo que el bot
// puede saber en tiempo real.
// Se mantiene el comportamiento actual para no separar el bot del
// backtest por decisión propia: cambiarlo obliga a revalidar la
// estrategia entera. Está anotado para decidirlo aparte.
// ============================================================

const fs = require('fs');

const HOSTS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com'
];
const SIGNAL_LIMIT = 1000;

// Máximo de velas de 4H que se reprocesan de una vez si el bot ha
// estado parado. 30 velas son 5 días. Si el parón fue más largo,
// se avisa en el log en vez de reconstruir un historial entero.
const MAX_VELAS_REPLAY = 30;

// ============================================================
// DESCARGA
// ============================================================
async function fetchKlinesRaw(symbol, interval, limit, endTime){
  let lastError=null;
  for(const host of HOSTS){
    try{
      let url = `${host}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
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

// Descarga velas y DESCARTA la que aún no ha cerrado.
// El campo 6 de cada kline de Binance es closeTime: si es mayor o
// igual que "ahora", esa vela sigue viva y no debe usarse para
// decidir nada (arreglo nº 2).
async function fetchRecentCandles(symbol, interval, targetCandles, incluirVelaEnCurso){
  let all = await fetchKlinesRaw(symbol, interval, SIGNAL_LIMIT);
  if(all.length < targetCandles){
    try{
      const oldestOpenTime = all[0][0];
      const page2 = await fetchKlinesRaw(symbol, interval, SIGNAL_LIMIT, oldestOpenTime-1);
      if(page2 && page2.length) all = page2.concat(all);
    }catch(e){ /* seguimos con lo que tenemos */ }
  }
  const map = new Map();
  all.forEach(k=>map.set(k[0],k));
  let sorted = Array.from(map.values()).sort((a,b)=>a[0]-b[0]);

  let descartadas = 0;
  if(!incluirVelaEnCurso){
    const ahora = Date.now();
    const antes = sorted.length;
    sorted = sorted.filter(k => Number(k[6]) < ahora);
    descartadas = antes - sorted.length;
  }

  const capped = sorted.slice(-targetCandles);
  return {
    times:capped.map(k=>k[0]),
    closeTimes:capped.map(k=>Number(k[6])),
    opens:capped.map(k=>parseFloat(k[1])),
    highs:capped.map(k=>parseFloat(k[2])),
    lows:capped.map(k=>parseFloat(k[3])),
    closes:capped.map(k=>parseFloat(k[4])),
    volumes:capped.map(k=>parseFloat(k[5])),
    velasEnCursoDescartadas: descartadas
  };
}

// ============================================================
// ESTADO
// ============================================================
function loadState(stateFile){
  try{
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if(s.tpParcialHecho === undefined) s.tpParcialHecho = false;
    if(s.lastProcessedTime === undefined) s.lastProcessedTime = null; // migración
    return s;
  }catch(e){
    return { position:null, entryPrice:null, tpPrice:null, entryTime:null, tpParcialHecho:false, lastProcessedTime:null };
  }
}
function saveState(stateFile, state){
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

// ============================================================
// TELEGRAM
// ============================================================
// Devuelve true SOLO si el mensaje llegó a todos los destinatarios.
// El resultado decide si se guarda el estado (arreglo nº 4).
async function sendTelegramMessage(token, chatIds, text){
  if(!token || chatIds.length === 0){
    console.log('[SIN CONFIGURAR] Falta TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID.');
    console.log('Mensaje que se habría enviado:\n' + text);
    return false;
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  let todosOk = true;
  for(const chatId of chatIds){
    let entregado = false;
    for(let intento=1; intento<=3 && !entregado; intento++){
      try{
        const resp = await fetch(url, {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ chat_id: chatId, text, parse_mode:'HTML' })
        });
        if(resp.ok){
          entregado = true;
          console.log('Mensaje enviado correctamente a chat_id ' + chatId + '.');
        } else {
          const body = await resp.text();
          console.error('Intento ' + intento + ' — Telegram (chat_id ' + chatId + '): HTTP ' + resp.status + ' — ' + body);
        }
      }catch(err){
        console.error('Intento ' + intento + ' — red al enviar a Telegram (chat_id ' + chatId + '): ' + err.message);
      }
      if(!entregado && intento<3) await new Promise(r=>setTimeout(r, 2000*intento));
    }
    if(!entregado) todosOk = false;
  }
  return todosOk;
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
  const tprice=opens.map((o,i)=>(o+highs[i]+lows[i]+closes[i])/4);
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

  const tendencia=new Array(n).fill(NaN);
  const pececillos=new Array(n).fill(NaN);
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

// ============================================================
// VEREDICTO
// ------------------------------------------------------------
// Copia literal de verdicts4H_local() del backtest (línea 1440 de
// bitman-backtest.js). Sin la regla de cierre forzado: esa regla
// NO forma parte del veredicto, solo de la gestión de una posición
// abierta. Ese era el fallo nº 1.
// ============================================================
function verdictoEn(s4h, sD, idxD, i){
  const iD = idxD[i];
  const aoAlcista = s4h.aoState[i]==='Alcista', aoBajista = s4h.aoState[i]==='Bajista';
  const dailyBullish = iD>=0 && sD.aoState[iD]==='Alcista' && sD.koBull[iD];
  const dailyBearish = iD>=0 && sD.aoState[iD]==='Bajista' && sD.koBear[iD];
  const comprarOk = aoAlcista && s4h.adxSubiendo[i] && s4h.koBull[i] && dailyBullish;
  const venderOk  = aoBajista && s4h.adxSubiendo[i] && s4h.koBear[i] && dailyBearish;
  return comprarOk ? 'COMPRAR' : (venderOk ? 'VENDER' : 'ESPERAR');
}

// El cierre forzado, tal y como está en el backtest: SOLO para
// largos y SOLO como motivo de cierre.
function cierreForzadoLargo(s4h, i){
  return !isNaN(s4h.konVal[i]) && !isNaN(s4h.maTrend[i]) && s4h.konVal[i] < s4h.maTrend[i];
}

// ============================================================
// MÁQUINA DE ESTADOS (replay sobre velas cerradas)
// ------------------------------------------------------------
// Reproduce el mismo orden de decisiones que simulateConfluenciaTPParcial
// del backtest: primero se gestiona la posición abierta (TP parcial →
// cierre forzado o pérdida de veredicto), y solo después, si quedó
// plana, se evalúa una entrada nueva.
// ============================================================
function replay(s4h, sD, state, cfg){
  const idxD = alignDailyIndex(sD, s4h.times);
  const messages = [];
  const st = Object.assign({}, state);
  const banner = cfg.modoPrueba ? '🧪 <i>MODO PRUEBA</i>\n' : '';
  const ultima = s4h.n - 1;
  const fechaDe = t => new Date(t).toISOString().replace('T',' ').slice(0,16) + ' UTC';

  let desde;
  if(st.lastProcessedTime == null){
    desde = ultima; // primera ejecución con el formato nuevo: solo la última vela cerrada
  } else {
    desde = s4h.times.findIndex(t => t > st.lastProcessedTime);
    if(desde === -1) return { messages:[], newState:st, procesadas:0, truncado:false };
  }

  let truncado = false;
  if(ultima - desde + 1 > MAX_VELAS_REPLAY){
    desde = ultima - MAX_VELAS_REPLAY + 1;
    truncado = true;
  }

  for(let i=desde; i<=ultima; i++){
    if(st.position){
      const esLargo = st.position === 'long';
      const forzado = esLargo && cierreForzadoLargo(s4h, i);
      const v = verdictoEn(s4h, sD, idxD, i);
      const stillValid = (esLargo && v==='COMPRAR') || (!esLargo && v==='VENDER');
      const precioCierre = s4h.closes[i];
      const gananciaEn = p => esLargo ? (p/st.entryPrice - 1)*100 : (1 - p/st.entryPrice)*100;

      if(!st.tpParcialHecho){
        const hitTP = esLargo ? s4h.highs[i] >= st.tpPrice : s4h.lows[i] <= st.tpPrice;
        if(hitTP){
          const g = gananciaEn(st.tpPrice);
          messages.push(
            banner + '🎯 <b>TP parcial alcanzado (' + (cfg.fraccionTpParcial*100) + '%)</b> (' + (esLargo?'largo':'corto') + ')\n' +
            'Vela de 4H: ' + fechaDe(s4h.times[i]) + '\n' +
            'Se cierra el ' + (cfg.fraccionTpParcial*100) + '% de la posición en ' + st.tpPrice.toFixed(2) +
            ' (precio +' + g.toFixed(2) + '% · posición +' + (g*cfg.leverage).toFixed(1) + '% con x' + cfg.leverage + ')\n' +
            '<i>El resto sigue abierto, sin nuevo TP — se cierra por cambio de veredicto o cierre forzado.</i>'
          );
          st.tpParcialHecho = true;
        } else if(forzado || !stillValid){
          const g = gananciaEn(precioCierre);
          messages.push(
            banner + '🔻 <b>Cierre completo (100%), sin haber tocado TP</b> (' + (esLargo?'largo':'corto') + ')\n' +
            'Vela de 4H: ' + fechaDe(s4h.times[i]) + '\n' +
            'Entrada: ' + st.entryPrice.toFixed(2) + ' → Cierre: ' + precioCierre.toFixed(2) +
            ' (' + (g>=0?'+':'') + g.toFixed(2) + '% de precio, x' + cfg.leverage + ' apalancamiento)\n' +
            escapeHtml(forzado
              ? 'Cierre forzado: Koncorde por debajo de su media (maTrend).'
              : 'El veredicto de 4H ha dejado de confirmar esta dirección.')
          );
          st.position=null; st.entryPrice=null; st.tpPrice=null; st.entryTime=null; st.tpParcialHecho=false;
        }
      } else {
        if(forzado || !stillValid){
          const g = gananciaEn(precioCierre);
          messages.push(
            banner + '🔻 <b>Cierre del resto (' + ((1-cfg.fraccionTpParcial)*100) + '% restante)</b> (' + (esLargo?'largo':'corto') + ')\n' +
            'Vela de 4H: ' + fechaDe(s4h.times[i]) + '\n' +
            'Entrada: ' + st.entryPrice.toFixed(2) + ' → Cierre: ' + precioCierre.toFixed(2) +
            ' (' + (g>=0?'+':'') + g.toFixed(2) + '% de precio, x' + cfg.leverage + ' apalancamiento)\n' +
            escapeHtml(forzado
              ? 'Cierre forzado: Koncorde por debajo de su media (maTrend).'
              : 'El veredicto de 4H ha dejado de confirmar esta dirección.')
          );
          st.position=null; st.entryPrice=null; st.tpPrice=null; st.entryTime=null; st.tpParcialHecho=false;
        }
      }
    }

    if(!st.position){
      const v = verdictoEn(s4h, sD, idxD, i);
      if(v==='COMPRAR' || v==='VENDER'){
        const direction = v==='COMPRAR' ? 'long' : 'short';
        const precio = s4h.closes[i];
        const tpPrice = direction==='long' ? precio*(1+cfg.tpPct/100) : precio*(1-cfg.tpPct/100);
        messages.push(
          banner + (direction==='long' ? '🟢' : '🔴') + ' <b>Nueva entrada: ' + (direction==='long'?'LARGO':'CORTO') + '</b>\n' +
          'Vela de 4H: ' + fechaDe(s4h.times[i]) + '\n' +
          'Precio: ' + precio.toFixed(2) + ' · TP parcial (' + (cfg.fraccionTpParcial*100) + '%): ' + tpPrice.toFixed(2) +
          ' (precio +' + cfg.tpPct.toFixed(1) + '% · posición +' + cfg.tpEquityPct + '% con x' + cfg.leverage + ')\n' +
          escapeHtml('AO + ADX subiendo + Koncorde en 4H, confirmado por el Diario.') + '\n' +
          '<i>Recordatorio de gestión: ' + cfg.riskPct + '% del capital, x' + cfg.leverage + '. Sin stop loss. Al llegar al TP se cierra el ' +
          (cfg.fraccionTpParcial*100) + '% y el resto sigue corriendo sin protección adicional.</i>'
        );
        st.position=direction; st.entryPrice=precio; st.tpPrice=tpPrice; st.entryTime=s4h.times[i]; st.tpParcialHecho=false;
      }
    }
  }

  st.lastProcessedTime = s4h.times[ultima];
  return { messages, newState: st, procesadas: ultima - desde + 1, truncado };
}

// ============================================================
// EJECUCIÓN
// ============================================================
async function ejecutarBot(cfg){
  console.log(cfg.nombre + ' — comprobando ' + cfg.symbol + ' a las ' + new Date().toISOString());

  // 4H solo con velas CERRADAS (arreglo nº 2).
  const ohlcv4h = await fetchRecentCandles(cfg.symbol, '4h', 400, false);
  // El Diario mantiene la vela en curso, para no separarnos del backtest
  // por decisión propia (ver el aviso pendiente de la cabecera).
  const ohlcvD  = await fetchRecentCandles(cfg.symbol, '1d', 400, true);

  console.log('Velas 4H cerradas: ' + ohlcv4h.closes.length +
              ' (descartadas por seguir abiertas: ' + ohlcv4h.velasEnCursoDescartadas + ')' +
              ' · Diario: ' + ohlcvD.closes.length);

  if(ohlcv4h.closes.length < 100){
    throw new Error('Muy pocas velas de 4H cerradas (' + ohlcv4h.closes.length + '): los indicadores no estarían calentados.');
  }

  const s4h = computeFullSeries(ohlcv4h);
  const sD  = computeFullSeries(ohlcvD);
  const idxD = alignDailyIndex(sD, s4h.times);
  const ultima = s4h.n - 1;

  console.log('Última vela CERRADA de 4H: ' + new Date(s4h.times[ultima]).toISOString() +
              ' · cierre ' + s4h.closes[ultima] +
              ' · veredicto ' + verdictoEn(s4h, sD, idxD, ultima) +
              (cierreForzadoLargo(s4h, ultima) ? ' · Koncorde por debajo de maTrend (cerraría un largo abierto)' : ''));

  const state = loadState(cfg.stateFile);
  const { messages, newState, procesadas, truncado } = replay(s4h, sD, state, cfg);
  console.log('Velas de 4H procesadas en este run: ' + procesadas + (truncado ? ' (recortado: el bot llevaba parado más de ' + MAX_VELAS_REPLAY + ' velas)' : ''));

  if(messages.length){
    let cuerpo = messages.join('\n\n');
    if(truncado){
      cuerpo = '⚠️ <i>El bot llevaba parado un tiempo; se han reprocesado solo las últimas ' +
               MAX_VELAS_REPLAY + ' velas de 4H.</i>\n\n' + cuerpo;
    }
    const texto = cfg.emoji + ' <b>' + cfg.nombre + ' · ' + cfg.symbol + '</b>\n\n' + cuerpo;
    const entregado = await sendTelegramMessage(cfg.telegramToken, cfg.telegramChatIds, texto);

    // Arreglo nº 4: el estado solo avanza si el aviso llegó de verdad.
    if(!entregado){
      throw new Error('No se pudo entregar el aviso a Telegram. NO se guarda el estado: la próxima ejecución volverá a intentarlo.');
    }
    console.log(messages.length + ' aviso(s) enviado(s).');
  } else {
    console.log('Sin cambios — no se envía nada. Posición actual: ' + (newState.position || 'ninguna'));
  }

  saveState(cfg.stateFile, newState);
}

module.exports = {
  ejecutarBot,
  // exportado para las pruebas
  replay, verdictoEn, cierreForzadoLargo, computeFullSeries, alignDailyIndex,
  fetchRecentCandles, loadState, saveState, sendTelegramMessage, MAX_VELAS_REPLAY
};

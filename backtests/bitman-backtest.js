// ============================================================
// Bitman · Diagnóstico de la señal de 15M (script independiente)
// ------------------------------------------------------------
// Este script NO evalúa rentabilidad. Responde a una sola pregunta:
//
//   ¿Es posible conseguir muestra suficiente con el concepto de 15M
//   (impulso en 15M + confirmación de retroceso en 1H), o no?
//
// Los análisis BE→BJ de bitman-backtest.js dejaron el concepto con 5-20
// operaciones resueltas: demasiadas pocas para interpretar nada. Antes de
// seguir tocando parámetros hay que saber DÓNDE se pierde la muestra y
// CUÁNTA muestra es alcanzable como máximo. Eso es lo único que se mide aquí.
//
// Se ejecuta aparte de bitman-backtest.js a propósito: aquel script tarda
// mucho y ejecuta decenas de análisis ya cerrados. Este arranca directo en
// lo único que sigue abierto.
//
// CORRECCIÓN IMPORTANTE respecto a BE→BJ
// --------------------------------------
// En bitman-backtest.js la serie de 1H se descargaba para MESES_HISTORICO
// meses (6 por defecto) mientras que la de 15M se descargaba para 48 meses.
// Resultado: la mayoría de velas de 15M no tenía NINGUNA vela de 1H con la
// que confirmar, así que la señal era imposible por falta de datos, no por
// criterio de mercado. Aquí la serie de 1H se descarga expresamente para
// cubrir TODO el rango de la serie de 15M, y el script audita e imprime esa
// cobertura ANTES de cualquier otra cosa. Si la cobertura no es ~100%, el
// resto de conclusiones quedan marcadas como no fiables.
//
// Solo lee datos públicos de Binance — no opera, no necesita credenciales
// de Telegram, no toca state.json ni el bot real.
// ============================================================

const SYMBOL = process.env.SYMBOL || 'BTCUSDT';
const MESES_15M = parseInt(process.env.MESES_15M || '48', 10);
const UMBRAL_MUESTRA = parseInt(process.env.UMBRAL_MUESTRA || '100', 10); // mínimo del proyecto
const VENTANA_1H = parseInt(process.env.VENTANA_1H || '12', 10);          // la más laxa ya probada: mejor caso
const SALTAR_TECHO = process.env.SALTAR_TECHO === '1';                    // saltar el análisis C (el más lento)
const MAX_PAGINAS_TECHO = parseInt(process.env.MAX_PAGINAS_TECHO || '500', 10);

const TARGET_PCT = parseFloat(process.env.TARGET_PCT || '2');
const STOP_PCT = parseFloat(process.env.STOP_PCT || '2');
const MAX_BARS = parseInt(process.env.MAX_BARS || '40', 10);

const HOSTS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com'
];
const SIGNAL_LIMIT = 1000;
const MS_POR_VELA = { '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };

// ============================================================
// DESCARGA DE VELAS
// ============================================================
async function fetchKlinesRaw(interval, limit, endTime){
  let lastError = null;
  for(const host of HOSTS){
    try{
      let url = `${host}/api/v3/klines?symbol=${encodeURIComponent(SYMBOL)}&interval=${interval}&limit=${limit}`;
      if(endTime) url += `&endTime=${endTime}`;
      const resp = await fetch(url);
      if(!resp.ok){ lastError = new Error(`HTTP ${resp.status}`); continue; }
      const data = await resp.json();
      if(!Array.isArray(data) || data.length === 0){ lastError = new Error('Respuesta vacía'); continue; }
      return data;
    }catch(err){ lastError = err; continue; }
  }
  throw lastError || new Error('No se pudo contactar Binance');
}

function empaquetar(klines){
  const map = new Map();
  klines.forEach(k => map.set(k[0], k));
  const sorted = Array.from(map.values()).sort((a,b) => a[0]-b[0]);
  return {
    times: sorted.map(k => k[0]),
    opens: sorted.map(k => parseFloat(k[1])),
    highs: sorted.map(k => parseFloat(k[2])),
    lows: sorted.map(k => parseFloat(k[3])),
    closes: sorted.map(k => parseFloat(k[4])),
    volumes: sorted.map(k => parseFloat(k[5]))
  };
}

// Descarga hacia atrás hasta cubrir 'meses' meses más un margen de calentamiento
// (velas extra para que los indicadores lentos ya estén formados en la primera
// vela del periodo analizado, no solo al final).
async function fetchCandlesForMonths(interval, meses, warmupVelas){
  const msPorVela = MS_POR_VELA[interval];
  const objetivo = Math.ceil((meses*30*86400000)/msPorVela) + warmupVelas;
  let all = await fetchKlinesRaw(interval, SIGNAL_LIMIT);
  let paginas = 1;
  while(all.length < objetivo && paginas < 400){
    let pagina;
    try{ pagina = await fetchKlinesRaw(interval, SIGNAL_LIMIT, all[0][0]-1); }
    catch(e){ break; }
    if(!pagina || pagina.length === 0) break;
    all = pagina.concat(all);
    paginas++;
    if(pagina.length < SIGNAL_LIMIT) break;
  }
  const datos = empaquetar(all);
  const n = datos.times.length;
  const desde = Math.max(0, n - objetivo);
  return {
    times: datos.times.slice(desde), opens: datos.opens.slice(desde), highs: datos.highs.slice(desde),
    lows: datos.lows.slice(desde), closes: datos.closes.slice(desde), volumes: datos.volumes.slice(desde)
  };
}

// Descarga hacia atrás hasta que la vela más antigua sea ANTERIOR a 'desdeMs'
// (menos el calentamiento). Esto es lo que garantiza que la serie de 1H cubra
// todo el rango de la serie de 15M — el fallo que invalidaba BE→BJ.
async function fetchCandlesQueCubran(interval, desdeMs, warmupVelas){
  const msPorVela = MS_POR_VELA[interval];
  const objetivoMs = desdeMs - warmupVelas*msPorVela;
  let all = await fetchKlinesRaw(interval, SIGNAL_LIMIT);
  let paginas = 1;
  while(all[0][0] > objetivoMs && paginas < 400){
    let pagina;
    try{ pagina = await fetchKlinesRaw(interval, SIGNAL_LIMIT, all[0][0]-1); }
    catch(e){ break; }
    if(!pagina || pagina.length === 0) break;
    const nuevas = pagina.filter(k => k[0] < all[0][0]);
    if(nuevas.length === 0) break;
    all = nuevas.concat(all);
    paginas++;
    if(pagina.length < SIGNAL_LIMIT) break;
  }
  return empaquetar(all);
}

// Descarga TODO el histórico disponible de un intervalo, paginando hasta que
// la API deja de devolver velas más antiguas. Distingue "fin real del histórico"
// de "corte técnico" (error de red / HTTP), porque un corte técnico haría creer
// que el techo de datos es menor de lo que es.
async function descargarHistoricoCompleto(interval, maxPaginas){
  const primera = await fetchKlinesRaw(interval, SIGNAL_LIMIT);
  let all = primera;
  let masAntiguo = primera[0][0];
  let paginas = 1;
  let motivoParada = 'límite de páginas del script alcanzado (' + maxPaginas + ')';
  let finDeHistorico = false;
  while(paginas < maxPaginas){
    let pagina;
    try{ pagina = await fetchKlinesRaw(interval, SIGNAL_LIMIT, masAntiguo-1); }
    catch(e){
      if(/Respuesta vacía/.test(e.message)){ motivoParada = 'todos los hosts devolvieron vacío (fin del histórico)'; finDeHistorico = true; }
      else { motivoParada = 'CORTE TÉCNICO, no fin de histórico: ' + e.message; }
      break;
    }
    if(!pagina || pagina.length === 0){ motivoParada = 'la API devolvió una página vacía (fin del histórico)'; finDeHistorico = true; break; }
    const nuevas = pagina.filter(k => k[0] < masAntiguo);
    if(nuevas.length === 0){ motivoParada = 'la API dejó de devolver velas más antiguas (fin del histórico)'; finDeHistorico = true; break; }
    all = nuevas.concat(all);
    masAntiguo = nuevas[0][0];
    paginas++;
    if(paginas % 50 === 0) console.log('  ... ' + paginas + ' páginas, llegando hasta ' + new Date(masAntiguo).toISOString().slice(0,10));
    if(pagina.length < SIGNAL_LIMIT){ motivoParada = 'la API devolvió una página incompleta (fin del histórico)'; finDeHistorico = true; break; }
  }
  return Object.assign(empaquetar(all), { paginas, motivoParada, finDeHistorico });
}

// ============================================================
// MOTOR DE INDICADORES
// (mismas fórmulas que bitman-backtest.js; se omiten ML RSI, LaRSI y Trend
//  Speed porque esta señal no los usa y sobre cientos de miles de velas
//  costarían minutos para nada)
// ============================================================
function safeDiv(a,b){
  if(b===0||b==null||a==null||isNaN(a)||isNaN(b)) return 0;
  const r = a/b; return isFinite(r) ? r : 0;
}
function sma(values, period){
  const out = new Array(values.length).fill(NaN);
  let sum=0, count=0;
  for(let i=0;i<values.length;i++){
    const v = values[i];
    if(v!=null && !isNaN(v)){ sum+=v; count++; }
    if(i>=period){
      const old = values[i-period];
      if(old!=null && !isNaN(old)){ sum-=old; count--; }
    }
    if(i>=period-1 && count===period) out[i]=sum/period;
  }
  return out;
}
function ema(values, period){
  const out = new Array(values.length).fill(NaN);
  const k = 2/(period+1); let seeded=false, prev=NaN;
  for(let i=0;i<values.length;i++){
    if(values[i]==null||isNaN(values[i])){ out[i]=prev; continue; }
    if(!seeded){ prev=values[i]; out[i]=prev; seeded=true; }
    else { prev=values[i]*k+prev*(1-k); out[i]=prev; }
  }
  return out;
}
// Desviación típica poblacional de ventana móvil. Mismo resultado que la
// versión con slice() de bitman-backtest.js, escrita sin crear un array por
// vela para que no se atragante con cientos de miles de velas.
function stdevPop(values, period){
  const n = values.length;
  const out = new Array(n).fill(NaN);
  for(let i=period-1;i<n;i++){
    let sum=0;
    for(let k=i-period+1;k<=i;k++) sum += values[k];
    const mean = sum/period;
    let varr=0;
    for(let k=i-period+1;k<=i;k++){ const d = values[k]-mean; varr += d*d; }
    out[i] = Math.sqrt(Math.max(varr/period, 0));
  }
  return out;
}
function highestPeriod(values, period){
  const n = values.length;
  const out = new Array(n).fill(NaN);
  for(let i=period-1;i<n;i++){
    let max = -Infinity;
    for(let k=i-period+1;k<=i;k++) if(values[k] > max) max = values[k];
    out[i] = max;
  }
  return out;
}
function lowestPeriod(values, period){
  const n = values.length;
  const out = new Array(n).fill(NaN);
  for(let i=period-1;i<n;i++){
    let min = Infinity;
    for(let k=i-period+1;k<=i;k++) if(values[k] < min) min = values[k];
    out[i] = min;
  }
  return out;
}
function rsiWilder(values, period){
  const out = new Array(values.length).fill(NaN);
  let avgGain=0, avgLoss=0;
  for(let i=1;i<values.length;i++){
    const change = values[i]-values[i-1];
    const gain = change>0?change:0, loss = change<0?-change:0;
    if(i<=period){
      avgGain+=gain; avgLoss+=loss;
      if(i===period){
        avgGain/=period; avgLoss/=period;
        const rs = safeDiv(avgGain,avgLoss);
        out[i] = avgLoss===0 ? 100 : (100-safeDiv(100,(1+rs)));
      }
    } else {
      avgGain = (avgGain*(period-1)+gain)/period;
      avgLoss = (avgLoss*(period-1)+loss)/period;
      const rs = safeDiv(avgGain,avgLoss);
      out[i] = avgLoss===0 ? 100 : (100-safeDiv(100,(1+rs)));
    }
  }
  return out;
}
function mfiTypical(highs, lows, closes, volumes, period, typicalArr){
  const n = closes.length;
  const typical = typicalArr || highs.map((h,i)=>(h+lows[i]+closes[i])/3);
  const rawFlow = typical.map((tp,i)=>tp*volumes[i]);
  const out = new Array(n).fill(NaN);
  for(let i=period;i<n;i++){
    let pos=0, neg=0;
    for(let j=i-period+1;j<=i;j++){
      if(j===0) continue;
      if(typical[j]>typical[j-1]) pos += rawFlow[j];
      else if(typical[j]<typical[j-1]) neg += rawFlow[j];
    }
    if(neg===0) out[i]=100;
    else { const mr = safeDiv(pos,neg); out[i] = 100-safeDiv(100,(1+mr)); }
  }
  return out;
}
function stochasticSmoothed(source, highs, lows, period, smoothPeriod){
  const n = source.length;
  const hh = highestPeriod(highs, period), ll = lowestPeriod(lows, period);
  const k = new Array(n).fill(NaN);
  for(let i=0;i<n;i++){
    if(!isNaN(hh[i]) && !isNaN(ll[i])) k[i] = safeDiv((source[i]-ll[i])*100, (hh[i]-ll[i]));
  }
  return sma(k, smoothPeriod);
}
function awesomeOscillator(highs, lows){
  const n = highs.length;
  const median = highs.map((h,i)=>(h+lows[i])/2);
  const fast = sma(median,5), slow = sma(median,34);
  const out = new Array(n).fill(NaN);
  for(let i=0;i<n;i++) if(!isNaN(fast[i]) && !isNaN(slow[i])) out[i] = fast[i]-slow[i];
  return out;
}
function adxWilder(highs, lows, closes, period){
  const n = closes.length;
  const tr = new Array(n).fill(0), plusDM = new Array(n).fill(0), minusDM = new Array(n).fill(0);
  for(let i=1;i<n;i++){
    const hd = highs[i]-highs[i-1], ld = lows[i-1]-lows[i];
    plusDM[i] = (hd>ld && hd>0) ? hd : 0;
    minusDM[i] = (ld>hd && ld>0) ? ld : 0;
    tr[i] = Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
  }
  const smTR = new Array(n).fill(NaN), smP = new Array(n).fill(NaN), smM = new Array(n).fill(NaN);
  const plusDI = new Array(n).fill(NaN), minusDI = new Array(n).fill(NaN), dx = new Array(n).fill(NaN), adx = new Array(n).fill(NaN);
  let trSum=0, pSum=0, mSum=0;
  for(let i=1;i<=period && i<n;i++){ trSum+=tr[i]; pSum+=plusDM[i]; mSum+=minusDM[i]; }
  if(period<n){ smTR[period]=trSum; smP[period]=pSum; smM[period]=mSum; }
  for(let i=period+1;i<n;i++){
    smTR[i] = smTR[i-1]-safeDiv(smTR[i-1],period)+tr[i];
    smP[i] = smP[i-1]-safeDiv(smP[i-1],period)+plusDM[i];
    smM[i] = smM[i-1]-safeDiv(smM[i-1],period)+minusDM[i];
  }
  for(let i=period;i<n;i++){
    plusDI[i] = safeDiv(smP[i]*100, smTR[i]);
    minusDI[i] = safeDiv(smM[i]*100, smTR[i]);
    dx[i] = safeDiv(Math.abs(plusDI[i]-minusDI[i])*100, (plusDI[i]+minusDI[i]));
  }
  let firstAdxIndex = period+period, dxSum=0, count=0;
  for(let i=period;i<n;i++){
    if(!isNaN(dx[i])){
      dxSum += dx[i]; count++;
      if(count===period){ adx[i] = dxSum/period; firstAdxIndex = i; break; }
    }
  }
  for(let i=firstAdxIndex+1;i<n;i++){
    if(isNaN(dx[i]) || isNaN(adx[i-1])) continue;
    adx[i] = (adx[i-1]*(period-1)+dx[i])/period;
  }
  return { adx, plusDI, minusDI };
}
function bbwpSeries(closes, bandPeriod, lookback){
  const n = closes.length;
  const base = sma(closes, bandPeriod), dev = stdevPop(closes, bandPeriod);
  const width = new Array(n).fill(NaN);
  for(let i=0;i<n;i++) if(!isNaN(base[i]) && !isNaN(dev[i])) width[i] = safeDiv(2*dev[i], base[i]);
  const out = new Array(n).fill(NaN);
  for(let i=0;i<n;i++){
    if(isNaN(width[i])) continue;
    const start = Math.max(0, i-lookback+1);
    let count=0, total=0;
    for(let j=start;j<=i;j++){
      if(isNaN(width[j])) continue;
      total++; if(width[j] <= width[i]) count++;
    }
    out[i] = total>0 ? (count/total)*100 : NaN;
  }
  return out;
}
// Koncorde Plus (fórmula exacta Bitman)
function koncordePlus(opens, highs, lows, closes, volumes){
  const n = closes.length;
  const tprice = opens.map((o,i)=>(o+highs[i]+lows[i]+closes[i])/4);
  const hlc3 = highs.map((h,i)=>(h+lows[i]+closes[i])/3);

  const pvi = new Array(n).fill(1000), nvi = new Array(n).fill(1000);
  for(let i=1;i<n;i++){
    const deltaPct = safeDiv(closes[i]-closes[i-1], closes[i-1]);
    if(volumes[i]>volumes[i-1]){ pvi[i]=pvi[i-1]+deltaPct*pvi[i-1]; nvi[i]=nvi[i-1]; }
    else if(volumes[i]<volumes[i-1]){ nvi[i]=nvi[i-1]+deltaPct*nvi[i-1]; pvi[i]=pvi[i-1]; }
    else { pvi[i]=pvi[i-1]; nvi[i]=nvi[i-1]; }
  }
  const pvim = ema(pvi,15), nvim = ema(nvi,15);
  const hiPvim = highestPeriod(pvim,90), loPvim = lowestPeriod(pvim,90);
  const hiNvim = highestPeriod(nvim,90), loNvim = lowestPeriod(nvim,90);
  const oscp = new Array(n).fill(NaN), azul = new Array(n).fill(NaN);
  for(let i=0;i<n;i++){
    oscp[i] = safeDiv((pvi[i]-pvim[i])*100, (hiPvim[i]-loPvim[i]));
    azul[i] = safeDiv((nvi[i]-nvim[i])*100, (hiNvim[i]-loNvim[i]));
  }

  const basisBB = sma(tprice,25), devBB = stdevPop(tprice,25);
  const oscBB = new Array(n).fill(NaN);
  for(let i=0;i<n;i++) oscBB[i] = safeDiv((tprice[i]-basisBB[i])*100, (4*devBB[i]));

  const xrsi = rsiWilder(tprice,14);
  const xmf = mfiTypical(highs,lows,closes,volumes,14,hlc3);
  const stoc = stochasticSmoothed(tprice,highs,lows,21,3);

  const tendencia = new Array(n).fill(NaN);
  const pececillos = new Array(n).fill(NaN);
  for(let i=0;i<n;i++){
    const parts = [xrsi[i], xmf[i], oscBB[i], isNaN(stoc[i])?NaN:stoc[i]/3];
    if(parts.some(p => p==null || isNaN(p))) continue;
    tendencia[i] = (xrsi[i]+xmf[i]+oscBB[i]+stoc[i]/3)/2;
    pececillos[i] = tendencia[i] + (isNaN(oscp[i])?0:oscp[i]);
  }
  const maTrend = ema(tendencia,15);
  const konVal = new Array(n).fill(NaN);
  for(let i=0;i<n;i++){
    if(isNaN(tendencia[i]) || isNaN(pececillos[i])) continue;
    const mx = Math.max(pececillos[i], tendencia[i]);
    konVal[i] = mx<0 ? Math.min(pececillos[i], tendencia[i]) : mx;
  }
  return { tprice, hlc3, oscp, azul, oscBB, tendencia, pececillos, maTrend, konVal };
}

function computeSeries(ohlcv){
  const { opens, highs, lows, closes, volumes, times } = ohlcv;
  const n = closes.length;
  const ao = awesomeOscillator(highs, lows);
  const { adx } = adxWilder(highs, lows, closes, 14);
  const bbwp = bbwpSeries(closes, 13, 252);
  const konc = koncordePlus(opens, highs, lows, closes, volumes);

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

  return {
    n, times, opens, highs, lows, closes, volumes,
    ao, adx, bbwp,
    oscp: konc.oscp, maTrend: konc.maTrend, konVal: konc.konVal,
    aoState, adxSubiendo
  };
}

// ============================================================
// CONDICIONES DE LA SEÑAL (definición vigente, la corregida en BI)
// ============================================================
// Zona amarilla ÚNICA: no está espejada. Solo existe cuando oscp>0. La misma
// zona sirve para los dos sentidos — dentro = impulso alcista construyéndose,
// saliendo por abajo = ese impulso agotándose.
function dentroZonaAmarillaUnica(s, i){
  const oscp = s.oscp[i], mt = s.maTrend[i];
  if(isNaN(oscp) || isNaN(mt)) return false;
  return oscp>0 && mt>0 && mt<oscp;
}
function entrandoZonaAmarillaUnica(s, i){
  if(i<1) return false;
  return dentroZonaAmarillaUnica(s,i) && !dentroZonaAmarillaUnica(s,i-1);
}
function saliendoZonaAmarillaHaciaAbajo(s, i){
  if(i<1) return false;
  if(!dentroZonaAmarillaUnica(s,i-1)) return false;
  const mt = s.maTrend[i];
  if(isNaN(mt)) return false;
  return mt <= 0;
}
function bbwpAcercandoseA(s, i, nivel, margen, lookback){
  if(i<lookback) return false;
  if(isNaN(s.bbwp[i]) || isNaN(s.bbwp[i-lookback])) return false;
  const enRango = s.bbwp[i] <= nivel && s.bbwp[i] >= nivel-margen;
  return enRango && s.bbwp[i] > s.bbwp[i-lookback];
}

// Para cada vela de la serie pequeña, índice de la última vela de la serie
// grande que YA había cerrado en ese momento (-1 si no hay ninguna).
function alinearIndice(serieGrande, timesPequena){
  const gTimes = serieGrande.times;
  const out = new Array(timesPequena.length).fill(-1);
  let j = 0;
  for(let i=0;i<timesPequena.length;i++){
    while(j+1<gTimes.length && gTimes[j+1] <= timesPequena[i]) j++;
    if(gTimes[j] <= timesPequena[i]) out[i] = j;
  }
  return out;
}

// Carrera hacia objetivo: desde cada disparo, ¿toca antes +target% o -stop%
// dentro de maxBars velas? resultado null = no resuelve dentro de la ventana.
// Si en la misma vela se tocan los dos, gana el stop (criterio conservador).
function carreraHaciaObjetivo(s, triggerArray, direction, targetPct, stopPct, maxBars){
  const resultados = [];
  const n = s.n;
  for(let i=0;i<n;i++){
    if(!triggerArray[i]) continue;
    if(i+1>=n) continue;
    const entryPrice = s.closes[i];
    const targetPrice = direction==='long' ? entryPrice*(1+targetPct/100) : entryPrice*(1-targetPct/100);
    const stopPrice = direction==='long' ? entryPrice*(1-stopPct/100) : entryPrice*(1+stopPct/100);
    let resultado = null, barsHasta = null;
    const limite = Math.min(i+maxBars, n-1);
    for(let k=i+1;k<=limite;k++){
      const tocaTarget = direction==='long' ? s.highs[k]>=targetPrice : s.lows[k]<=targetPrice;
      const tocaStop = direction==='long' ? s.lows[k]<=stopPrice : s.highs[k]>=stopPrice;
      if(tocaStop){ resultado=false; barsHasta=k-i; break; }
      if(tocaTarget){ resultado=true; barsHasta=k-i; break; }
    }
    resultados.push({ entryIdx:i, resultado, barsHasta });
  }
  return resultados;
}

function resumirCarrera(s, disparo, direction){
  const resultados = carreraHaciaObjetivo(s, disparo, direction, TARGET_PCT, STOP_PCT, MAX_BARS);
  const resueltos = resultados.filter(r => r.resultado !== null);
  const ganadas = resueltos.filter(r => r.resultado === true).length;
  return {
    disparos: resultados.length,
    resueltos: resueltos.length,
    ganadas,
    winRate: resueltos.length ? ganadas/resueltos.length*100 : NaN,
    resultados
  };
}

// ============================================================
// FORMATO
// ============================================================
function pad(str, len){ str=String(str); return str.length>=len ? str : str + ' '.repeat(len-str.length); }
function padL(str, len){ str=String(str); return str.length>=len ? str : ' '.repeat(len-str.length) + str; }
function pct(x, dec){ return isNaN(x) ? '—' : x.toFixed(dec==null?1:dec) + '%'; }
function isoDia(ms){ return new Date(ms).toISOString().slice(0,10); }
function titulo(t){
  console.log('\n\n========================================');
  console.log(t);
  console.log('========================================');
}

// ============================================================
// PROGRAMA
// ============================================================
async function main(){
  console.log('============================================================');
  console.log('DIAGNÓSTICO DE LA SEÑAL DE 15M — ' + SYMBOL);
  console.log('============================================================');
  console.log('Pregunta única: ¿hay forma de conseguir muestra suficiente (mínimo ' + UMBRAL_MUESTRA + ' operaciones');
  console.log('resueltas) con este concepto? No se mide rentabilidad: con la muestra actual no sería');
  console.log('interpretable, y darle un número sería peor que no darlo.');
  console.log('\nParámetros: meses de 15M=' + MESES_15M + ' · ventana de confirmación 1H=' + VENTANA_1H + 'h · ' +
    'carrera ±' + TARGET_PCT + '% en ' + MAX_BARS + ' velas');

  // ---------- Descarga ----------
  console.log('\nDescargando ' + MESES_15M + ' meses de velas de 15M...');
  const ohlcv15M = await fetchCandlesForMonths('15m', MESES_15M, 300);
  console.log('Velas de 15M: ' + ohlcv15M.times.length + ' (' + isoDia(ohlcv15M.times[0]) + ' → ' + isoDia(ohlcv15M.times[ohlcv15M.times.length-1]) + ')');

  console.log('Descargando velas de 1H que cubran TODO ese rango (esto es lo que faltaba en BE→BJ)...');
  const ohlcv1H = await fetchCandlesQueCubran('1h', ohlcv15M.times[0], 300);
  console.log('Velas de 1H: ' + ohlcv1H.times.length + ' (' + isoDia(ohlcv1H.times[0]) + ' → ' + isoDia(ohlcv1H.times[ohlcv1H.times.length-1]) + ')');

  console.log('\nCalculando indicadores...');
  const s15M = computeSeries(ohlcv15M);
  const s1H = computeSeries(ohlcv1H);
  const idx1H = alinearIndice(s1H, s15M.times);

  // ============================================================
  // A) AUDITORÍA DE COBERTURA — antes de cualquier conclusión
  // ============================================================
  titulo('A) COBERTURA DE DATOS — ¿puede siquiera evaluarse la confirmación de 1H?');
  const velasCon1H = idx1H.reduce((acc,j) => acc + (j>=0?1:0), 0);
  const pctCobertura = s15M.n>0 ? velasCon1H/s15M.n*100 : NaN;
  const mesesSerie = (s15M.times[s15M.n-1]-s15M.times[0])/(30*86400000);

  console.log('\nSerie 15M : ' + s15M.n + ' velas · ' + isoDia(s15M.times[0]) + ' → ' + isoDia(s15M.times[s15M.n-1]) + ' (' + mesesSerie.toFixed(1) + ' meses)');
  console.log('Serie 1H  : ' + s1H.n + ' velas · ' + isoDia(s1H.times[0]) + ' → ' + isoDia(s1H.times[s1H.n-1]));
  console.log('Velas de 15M con una vela de 1H disponible para confirmar: ' + velasCon1H + ' de ' + s15M.n + ' (' + pct(pctCobertura) + ')');

  const coberturaOk = pctCobertura >= 99;
  if(coberturaOk){
    console.log('→ COBERTURA CORRECTA. La confirmación de 1H se puede evaluar en prácticamente todas las velas,');
    console.log('  así que lo que corte el filtro de 1H a partir de aquí es criterio de mercado, no falta de datos.');
  } else {
    console.log('→ COBERTURA INSUFICIENTE. Parte de las velas de 15M no tiene 1H con la que confirmar: para esas,');
    console.log('  la señal es imposible por construcción. Las conclusiones de abajo NO son fiables hasta arreglarlo.');
  }

  // ============================================================
  // B) EMBUDO DE ATRICIÓN — dónde se pierde la muestra
  // ============================================================
  titulo('B) EMBUDO DE ATRICIÓN — qué condición concreta se lleva por delante la muestra');
  console.log('Se cuenta, sobre TODAS las velas de 15M, cuántas pasan cada condición POR SEPARADO y cuántas');
  console.log('sobreviven ACUMULADAS aplicándolas en orden. La condición con peor retención es la que decide.');
  console.log('Se usa la ventana de 1H más laxa ya probada (' + VENTANA_1H + 'h): el mejor caso posible, no el peor.');

  function confirmacion1H(i, direction){
    const j = idx1H[i];
    if(j<0) return false;
    const desde = Math.max(0, j-VENTANA_1H);
    for(let k=desde;k<=j;k++){
      const koncordeOk = direction==='long' ? entrandoZonaAmarillaUnica(s1H,k) : saliendoZonaAmarillaHaciaAbajo(s1H,k);
      if(koncordeOk && bbwpAcercandoseA(s1H,k,50,15,3)) return true;
    }
    return false;
  }

  const condiciones = {
    long: [
      { nombre: 'Koncorde 15M: dentro zona amarilla', test: i => dentroZonaAmarillaUnica(s15M,i) },
      { nombre: 'AO 15M: estado Alcista',             test: i => s15M.aoState[i]==='Alcista' },
      { nombre: 'ADX 15M: subiendo',                  test: i => s15M.adxSubiendo[i] },
      { nombre: 'BBWP 15M: > 50',                     test: i => s15M.bbwp[i] > 50 },
      { nombre: 'Existe vela de 1H en esa fecha',     test: i => idx1H[i] >= 0 },
      { nombre: 'Confirmación 1H (' + VENTANA_1H + 'h)', test: i => confirmacion1H(i,'long') }
    ],
    short: [
      { nombre: 'Koncorde 15M: saliendo zona abajo',  test: i => saliendoZonaAmarillaHaciaAbajo(s15M,i) },
      { nombre: 'AO 15M: estado Bajista',             test: i => s15M.aoState[i]==='Bajista' },
      { nombre: 'ADX 15M: subiendo',                  test: i => s15M.adxSubiendo[i] },
      { nombre: 'BBWP 15M: > 50',                     test: i => s15M.bbwp[i] > 50 },
      { nombre: 'Existe vela de 1H en esa fecha',     test: i => idx1H[i] >= 0 },
      { nombre: 'Confirmación 1H (' + VENTANA_1H + 'h)', test: i => confirmacion1H(i,'short') }
    ]
  };
  const IDX_ULTIMA_COND_15M = 3; // 'BBWP 15M: > 50' — último escalón que no depende del 1H

  function embudo(direction){
    const conds = condiciones[direction];
    const nTot = s15M.n;

    // Precalcular cada condición una sola vez: se reutiliza en el embudo y en
    // el análisis de "quitar una condición" de más abajo.
    const mascaras = conds.map(cond => {
      const m = new Uint8Array(nTot);
      for(let i=0;i<nTot;i++) if(cond.test(i)) m[i]=1;
      return m;
    });
    const sueltas = mascaras.map(m => { let c=0; for(let i=0;i<m.length;i++) c+=m[i]; return c; });

    let vivos = new Array(nTot).fill(true);
    const acumuladas = [];
    let vivosTras15M = null;
    conds.forEach((cond, c) => {
      const siguiente = new Array(nTot).fill(false);
      let cuenta = 0;
      for(let i=0;i<nTot;i++) if(vivos[i] && mascaras[c][i]){ siguiente[i]=true; cuenta++; }
      vivos = siguiente;
      acumuladas.push(cuenta);
      if(c === IDX_ULTIMA_COND_15M) vivosTras15M = vivos.slice();
    });

    const carrera = resumirCarrera(s15M, vivos, direction);
    const carreraSin1H = resumirCarrera(s15M, vivosTras15M, direction);

    return {
      direction, conds, mascaras, sueltas, acumuladas,
      disparos: carrera.disparos, resueltos: carrera.resueltos, ganadas: carrera.ganadas,
      winRate: carrera.winRate, resultados: carrera.resultados,
      disparosSin1H: carreraSin1H.disparos, resueltosSin1H: carreraSin1H.resueltos
    };
  }

  function imprimirEmbudo(res){
    const nTot = s15M.n;
    console.log('\n--- Embudo ' + (res.direction==='long'?'LARGO':'CORTO') + ' (total de velas de 15M: ' + nTot + ') ---');
    console.log(pad('Condición',38) + padL('Pasan',10) + padL('% total',10) + padL('Superviv.',11) + padL('% del ant.',12));
    let anterior = nTot;
    res.conds.forEach((cond,c) => {
      const sup = res.acumuladas[c];
      const pctTotal = nTot>0 ? res.sueltas[c]/nTot*100 : NaN;
      const pctAnterior = anterior>0 ? sup/anterior*100 : NaN;
      console.log(pad(cond.nombre,38) + padL(res.sueltas[c],10) + padL(pct(pctTotal,2),10) + padL(sup,11) + padL(pct(pctAnterior),12));
      anterior = sup;
    });
    const pctResueltas = res.disparos>0 ? res.resueltos/res.disparos*100 : NaN;
    console.log(pad('Carrera ±'+TARGET_PCT+'% resuelta en '+MAX_BARS+' velas',38) + padL('—',10) + padL('—',10) + padL(res.resueltos,11) + padL(pct(pctResueltas),12));
    console.log('Referencia sin el filtro de 1H: ' + res.disparosSin1H + ' disparos → ' + res.resueltosSin1H + ' resueltas.');
  }

  function peorEscalon(res){
    const nTot = s15M.n;
    let anterior = nTot, peor = null;
    res.conds.forEach((cond,c) => {
      const sup = res.acumuladas[c];
      const ratio = anterior>0 ? sup/anterior : 1;
      if(peor===null || ratio<peor.ratio) peor = { nombre: cond.nombre, ratio, sup, anterior };
      anterior = sup;
    });
    const ratioResolucion = res.disparos>0 ? res.resueltos/res.disparos : 1;
    if(res.disparos>0 && ratioResolucion<peor.ratio){
      peor = { nombre: 'Carrera ±'+TARGET_PCT+'% resuelta en '+MAX_BARS+' velas', ratio: ratioResolucion, sup: res.resueltos, anterior: res.disparos };
    }
    return peor;
  }

  const embudoLargo = embudo('long');
  const embudoCorto = embudo('short');
  imprimirEmbudo(embudoLargo);
  imprimirEmbudo(embudoCorto);

  // --- Desglose por año ---
  function porAnio(res){
    const m = new Map();
    for(let i=0;i<s15M.n;i++){
      const anio = new Date(s15M.times[i]).getUTCFullYear();
      if(!m.has(anio)) m.set(anio, { velas:0, con1H:0, disparos:0, resueltos:0, ganadas:0 });
      const e = m.get(anio);
      e.velas++;
      if(idx1H[i]>=0) e.con1H++;
    }
    res.resultados.forEach(r => {
      const e = m.get(new Date(s15M.times[r.entryIdx]).getUTCFullYear());
      if(!e) return;
      e.disparos++;
      if(r.resultado!==null){ e.resueltos++; if(r.resultado===true) e.ganadas++; }
    });
    return m;
  }
  console.log('\n--- Desglose por año (largo + corto juntos) ---');
  const anioL = porAnio(embudoLargo), anioC = porAnio(embudoCorto);
  const anios = Array.from(new Set([...anioL.keys(), ...anioC.keys()])).sort((a,b)=>a-b);
  console.log(pad('Año',8) + padL('Velas 15M',11) + padL('Con 1H',10) + padL('% con 1H',10) + padL('Disparos',10) + padL('Resueltas',11) + padL('% acierto',11));
  anios.forEach(anio => {
    const a = anioL.get(anio) || { velas:0, con1H:0, disparos:0, resueltos:0, ganadas:0 };
    const b = anioC.get(anio) || { velas:0, con1H:0, disparos:0, resueltos:0, ganadas:0 };
    const disparos = a.disparos+b.disparos, resueltos = a.resueltos+b.resueltos, ganadas = a.ganadas+b.ganadas;
    console.log(pad(anio,8) + padL(a.velas,11) + padL(a.con1H,10) + padL(pct(a.velas>0?a.con1H/a.velas*100:NaN,0),10) +
      padL(disparos,10) + padL(resueltos,11) + padL(pct(resueltos>0?ganadas/resueltos*100:NaN),11));
  });

  const resueltosTotal = embudoLargo.resueltos + embudoCorto.resueltos;
  const resueltosSin1H = embudoLargo.resueltosSin1H + embudoCorto.resueltosSin1H;
  const peorL = peorEscalon(embudoLargo), peorC = peorEscalon(embudoCorto);

  console.log('\n--- Conclusión automática (B) ---');
  console.log('TAMAÑO DE MUESTRA PRIMERO: ' + resueltosTotal + ' operaciones resueltas (largo+corto) sobre ' + s15M.n + ' velas de 15M.');
  console.log(resueltosTotal < UMBRAL_MUESTRA
    ? '→ MUESTRA INSUFICIENTE (mínimo del proyecto: ' + UMBRAL_MUESTRA + '). No se interpreta ningún resultado de rendimiento.'
    : '→ MUESTRA SUFICIENTE (mínimo del proyecto: ' + UMBRAL_MUESTRA + '). El rendimiento sí sería interpretable.');
  console.log('Escalón que más corta en LARGO: "' + peorL.nombre + '" → deja pasar el ' + pct(peorL.ratio*100) + ' (' + peorL.anterior + ' → ' + peorL.sup + ').');
  console.log('Escalón que más corta en CORTO: "' + peorC.nombre + '" → deja pasar el ' + pct(peorC.ratio*100) + ' (' + peorC.anterior + ' → ' + peorC.sup + ').');
  console.log('Techo si el filtro de 1H no cortara absolutamente nada: ' + resueltosSin1H + ' operaciones resueltas.');
  console.log(resueltosSin1H < UMBRAL_MUESTRA
    ? '→ El 1H NO es el cuello de botella: ni eliminándolo del todo se llega a ' + UMBRAL_MUESTRA + '. El problema está en el 15M.'
    : '→ El 1H SÍ es el cuello de botella: sin él la muestra pasa de ' + resueltosTotal + ' a ' + resueltosSin1H + '. Debería modular tamaño, no cortar entradas.');
  if(!coberturaOk){
    console.log('AVISO: con solo ' + pct(pctCobertura) + ' de cobertura de 1H, parte de esta atrición es falta de datos, no criterio.');
  }

  // ============================================================
  // C) QUITAR UNA CONDICIÓN — cuál conviene relajar primero
  // ============================================================
  titulo('C) QUITAR UNA CONDICIÓN — cuánta muestra recupera cada relajación por separado');
  console.log('Para cada condición, se recalcula la muestra quitando ESA sola y dejando el resto intactas.');
  console.log('Sirve para saber qué relajar primero si hay que relajar algo — y para ver si alguna relajación');
  console.log('sola bastaría para llegar al mínimo de ' + UMBRAL_MUESTRA + ' operaciones resueltas.');

  function quitandoUna(res, indiceQuitado){
    const nTot = s15M.n;
    const disparo = new Array(nTot).fill(false);
    for(let i=0;i<nTot;i++){
      let ok = true;
      for(let c=0;c<res.mascaras.length;c++){
        if(c===indiceQuitado) continue;
        if(!res.mascaras[c][i]){ ok=false; break; }
      }
      disparo[i] = ok;
    }
    return resumirCarrera(s15M, disparo, res.direction);
  }

  console.log('\n' + pad('Condición eliminada',38) + padL('Disparos',10) + padL('Resueltas',11) + padL('vs. actual',12) + padL('% acierto',11));
  const filasQuitar = [];
  embudoLargo.conds.forEach((cond, c) => {
    const rl = quitandoUna(embudoLargo, c);
    const rc = quitandoUna(embudoCorto, c);
    const resueltos = rl.resueltos + rc.resueltos;
    const disparos = rl.disparos + rc.disparos;
    const ganadas = rl.ganadas + rc.ganadas;
    const wr = resueltos>0 ? ganadas/resueltos*100 : NaN;
    const delta = resueltos - resueltosTotal;
    filasQuitar.push({ nombre: cond.nombre, resueltos, disparos, wr, delta });
    console.log(pad(cond.nombre,38) + padL(disparos,10) + padL(resueltos,11) + padL((delta>=0?'+':'')+delta,12) + padL(pct(wr),11));
  });
  const wrCompleta = resueltosTotal>0 ? (embudoLargo.ganadas+embudoCorto.ganadas)/resueltosTotal*100 : NaN;
  console.log(pad('(ninguna: señal completa actual)',38) + padL(embudoLargo.disparos+embudoCorto.disparos,10) +
    padL(resueltosTotal,11) + padL('—',12) + padL(pct(wrCompleta),11));

  const mejorRelajacion = filasQuitar.reduce((a,b) => b.resueltos>a.resueltos ? b : a, filasQuitar[0]);
  const bastanUna = filasQuitar.filter(f => f.resueltos >= UMBRAL_MUESTRA);
  console.log('\n--- Conclusión automática (C) ---');
  console.log('La relajación que más muestra recupera es quitar "' + mejorRelajacion.nombre + '": ' +
    mejorRelajacion.resueltos + ' operaciones resueltas (' + (mejorRelajacion.delta>=0?'+':'') + mejorRelajacion.delta + ' respecto a la señal completa).');
  console.log(bastanUna.length===0
    ? '→ NINGUNA relajación individual llega al mínimo de ' + UMBRAL_MUESTRA + '. Quitar una sola condición no arregla la muestra.'
    : '→ Relajaciones individuales que ya alcanzan el mínimo: ' + bastanUna.map(f => '"'+f.nombre+'" ('+f.resueltos+')').join(', ') + '.');
  console.log('AVISO: quitar condiciones cambia la señal. Estos números dicen cuánta MUESTRA se recupera, no que');
  console.log('la señal relajada sea buena. Cualquier % de acierto de esta tabla sigue sin ser interpretable si');
  console.log('la muestra queda por debajo de ' + UMBRAL_MUESTRA + '.');

  // ============================================================
  // D) TECHO DE HISTÓRICO — cuánta muestra es alcanzable como máximo
  // ============================================================
  titulo('D) TECHO DE HISTÓRICO — máximo de muestra alcanzable con todo el histórico y sin filtro de 1H');
  if(SALTAR_TECHO){
    console.log('SALTADO (SALTAR_TECHO=1). Sin este dato NO se puede decidir si se archiva el concepto de 15M:');
    console.log('B y C solo dicen dónde se pierde la muestra, no cuánta hay disponible como máximo.');
  } else {
    console.log('Se descarga todo el histórico de 15M que la API entregue y se cuenta la muestra que dan las');
    console.log('cuatro condiciones de 15M SIN ningún filtro de 1H. Ese número es el techo absoluto del concepto:');
    console.log('cualquier filtro que se añada después solo puede bajarlo.');
    try{
      console.log('\nDescargando histórico completo de 15M (tarda varios minutos)...');
      const t0 = Date.now();
      const ohlcvMax = await descargarHistoricoCompleto('15m', MAX_PAGINAS_TECHO);
      const nMax = ohlcvMax.times.length;
      const primera = ohlcvMax.times[0], ultima = ohlcvMax.times[nMax-1];
      const esperadas = Math.round((ultima-primera)/900000)+1;
      const huecos = esperadas-nMax;
      const aniosMax = (ultima-primera)/(365.25*86400000);

      console.log('\n--- Lo que la API entrega realmente (símbolo ' + SYMBOL + ') ---');
      console.log('Velas de 15M descargadas  : ' + nMax + ' (en ' + ohlcvMax.paginas + ' páginas, ' + ((Date.now()-t0)/1000).toFixed(0) + 's)');
      console.log('Desde                     : ' + new Date(primera).toISOString());
      console.log('Hasta                     : ' + new Date(ultima).toISOString());
      console.log('Periodo cubierto          : ' + aniosMax.toFixed(2) + ' años');
      console.log('Velas esperadas sin huecos: ' + esperadas + ' → huecos: ' + huecos + ' (' + pct(esperadas>0 ? huecos/esperadas*100 : 0, 2) + ')');
      console.log('Motivo de parada          : ' + ohlcvMax.motivoParada);
      const topeReal = ohlcvMax.finDeHistorico;
      console.log(topeReal
        ? '→ Se agotó el histórico de la API: este es el TECHO REAL de datos.'
        : '→ NO se llegó al techo real: la descarga se cortó antes. La cifra de abajo es un SUELO, no el máximo.');

      console.log('\nCalculando indicadores sobre el histórico completo...');
      const t1 = Date.now();
      const sMax = computeSeries(ohlcvMax);
      console.log('Indicadores calculados en ' + ((Date.now()-t1)/1000).toFixed(0) + 's sobre ' + sMax.n + ' velas.');

      function disparo15MPuro(s, i, direction){
        const koncordeOk = direction==='long' ? dentroZonaAmarillaUnica(s,i) : saliendoZonaAmarillaHaciaAbajo(s,i);
        return koncordeOk
          && (direction==='long' ? s.aoState[i]==='Alcista' : s.aoState[i]==='Bajista')
          && s.adxSubiendo[i]
          && s.bbwp[i] > 50;
      }

      const resumenMax = ['long','short'].map(direction => {
        const disparo = new Array(sMax.n).fill(false);
        for(let i=0;i<sMax.n;i++) if(disparo15MPuro(sMax,i,direction)) disparo[i]=true;
        const r = resumirCarrera(sMax, disparo, direction);
        return Object.assign({ direction }, r);
      });

      console.log('\n--- Máximo alcanzable: 4 condiciones de 15M, sin filtro de 1H, sobre todo el histórico ---');
      console.log(pad('Dirección',12) + padL('Disparos',10) + padL('Resueltas',11) + padL('Sin resolver',14) + padL('% acierto',11));
      resumenMax.forEach(r => {
        console.log(pad(r.direction==='long'?'Largo':'Corto',12) + padL(r.disparos,10) + padL(r.resueltos,11) +
          padL(r.disparos-r.resueltos,14) + padL(pct(r.winRate),11));
      });
      const disparosMax = resumenMax.reduce((a,r)=>a+r.disparos,0);
      const resueltosMax = resumenMax.reduce((a,r)=>a+r.resueltos,0);
      const ganadasMax = resumenMax.reduce((a,r)=>a+r.ganadas,0);
      console.log(pad('TOTAL',12) + padL(disparosMax,10) + padL(resueltosMax,11) + padL(disparosMax-resueltosMax,14) +
        padL(pct(resueltosMax>0 ? ganadasMax/resueltosMax*100 : NaN),11));

      // ¿Está la muestra repartida en el tiempo o concentrada en unos pocos años?
      const porAnioMax = new Map();
      for(let i=0;i<sMax.n;i++){
        const anio = new Date(sMax.times[i]).getUTCFullYear();
        if(!porAnioMax.has(anio)) porAnioMax.set(anio, { velas:0, disparos:0, resueltos:0, ganadas:0 });
        porAnioMax.get(anio).velas++;
      }
      resumenMax.forEach(r => r.resultados.forEach(x => {
        const e = porAnioMax.get(new Date(sMax.times[x.entryIdx]).getUTCFullYear());
        if(!e) return;
        e.disparos++;
        if(x.resultado!==null){ e.resueltos++; if(x.resultado===true) e.ganadas++; }
      }));
      console.log('\n--- Reparto por año (¿muestra repartida o concentrada?) ---');
      console.log(pad('Año',8) + padL('Velas 15M',11) + padL('Disparos',10) + padL('Resueltas',11) + padL('% acierto',11));
      const aniosMaxOrden = Array.from(porAnioMax.keys()).sort((a,b)=>a-b);
      let aniosConMuestra = 0;
      aniosMaxOrden.forEach(anio => {
        const e = porAnioMax.get(anio);
        if(e.resueltos>0) aniosConMuestra++;
        console.log(pad(anio,8) + padL(e.velas,11) + padL(e.disparos,10) + padL(e.resueltos,11) +
          padL(pct(e.resueltos>0 ? e.ganadas/e.resueltos*100 : NaN),11));
      });

      console.log('\n--- Conclusión automática (D) ---');
      console.log('TAMAÑO DE MUESTRA PRIMERO: ' + resueltosMax + ' operaciones resueltas con el histórico máximo (' +
        aniosMax.toFixed(2) + ' años) y SIN filtro de 1H.');
      if(resueltosMax < UMBRAL_MUESTRA){
        console.log('→ MUESTRA INSUFICIENTE. Ni con todo el histórico posible ni quitando el 1H se alcanzan ' + UMBRAL_MUESTRA + '.');
        console.log('→ DECISIÓN: ARCHIVAR el concepto de 15M tal como está definido. No hay forma de conseguir muestra');
        console.log('  sin cambiar la señal, así que no procede seguir afinando parámetros. Volver al 4H, que sí funciona.');
        if(!topeReal){
          console.log('  MATIZ QUE INVALIDA LA DECISIÓN: la descarga NO llegó al fin del histórico (' + ohlcvMax.motivoParada + ').');
          console.log('  No se archiva nada con este dato. Repetir subiendo MAX_PAGINAS_TECHO o cuando la API responda bien.');
        }
      } else {
        console.log('→ MUESTRA SUFICIENTE en el techo. El concepto NO se archiva: hay margen para seguir.');
        console.log('  Margen sobre el mínimo: ×' + (resueltosMax/UMBRAL_MUESTRA).toFixed(2) + '. Un filtro que corte más del ' +
          ((1-UMBRAL_MUESTRA/resueltosMax)*100).toFixed(0) + '% de las entradas deja el análisis sin muestra.');
        console.log('  Años con al menos una operación resuelta: ' + aniosConMuestra + ' de ' + aniosMaxOrden.length + ' → ' +
          (aniosConMuestra >= aniosMaxOrden.length-1 ? 'muestra REPARTIDA en el tiempo.' : 'muestra CONCENTRADA: no dar el resultado por bueno sin mirar en qué años.'));
      }
      console.log('\nComparación B vs D: con la señal completa hay ' + resueltosTotal + ' operaciones resueltas sobre ' + s15M.n +
        ' velas; el techo es ' + resueltosMax + ' con ' + sMax.n + ' velas y sin 1H.');
      console.log('La diferencia entre esas dos cifras es todo lo que hay que ganar optimizando. El resto no existe.');
    }catch(err){
      console.log('\nANÁLISIS D NO COMPLETADO — fallo al descargar o procesar el histórico: ' + err.message);
      console.log('No se emite decisión: sin el techo de histórico, B y C por sí solos no deciden si se archiva el 15M.');
    }
  }

  console.log('\n\n=== Fin del diagnóstico de 15M ===');
}

main().catch(err => {
  console.error('Error en el diagnóstico:', err);
  process.exit(1);
});

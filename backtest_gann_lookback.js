/**
 * Backtest: comparación de pivotLookback (10/20/30/50/100) para el indicador
 * de ángulos de Gann, sobre BTC/USDT en Diario (1D) y Semanal (1W).
 *
 * Incluye un control aleatorio: por cada combinación, genera cruces al azar
 * del mismo tamaño de muestra y calcula su win rate, para poder comparar
 * si el Gann realmente aporta un "edge" por encima del puro azar.
 *
 * Uso:
 *   node backtest_gann_lookback.js
 *
 * Requisitos: Node 18+ (usa fetch nativo). Sin dependencias externas.
 *
 * -----------------------------------------------------------------------
 * NOTA IMPORTANTE SOBRE UN BUG DEL INDICADOR ORIGINAL DE TRADINGVIEW
 * -----------------------------------------------------------------------
 * En el .pine, `gannUnit` se recalculaba en cada barra usando el close
 * actual, lo que hace que `line1x1Price` sea matemáticamente IGUAL al
 * close en todo momento (pivotPrice + (close-pivotPrice) = close).
 * Es decir, el cruce con la 1x1 nunca podía detectarse de forma
 * significativa en el propio indicador — el "cruce" solo tenía sentido
 * visualmente porque el abanico se congelaba en la última barra.
 *
 * Este backtest corrige ese problema: la unidad Gann se "congela" en el
 * momento en que se detecta un nuevo pivote, y la línea 1x1 se proyecta
 * hacia adelante con esa unidad fija hasta que aparece un pivote nuevo.
 * Así los cruces de precio contra la línea proyectada sí son eventos reales.
 * -----------------------------------------------------------------------
 */

const SYMBOL = 'BTCUSDT';
const TIMEFRAMES = ['1d', '1w'];
const LOOKBACKS = [10, 20, 30, 50, 100];
const FORWARD_BARS_BY_TF = { '1d': 10, '1w': 4 }; // ~10 días / ~4 semanas hacia adelante
const BARS_TO_FETCH_BY_TF = { '1d': 3000, '1w': 450 }; // 1D: ~8 años. 1W: todo el histórico disponible

// ---------------------------------------------------------------------
// 1. Descarga de datos históricos de Binance (paginado, sin API key)
// ---------------------------------------------------------------------
async function fetchKlines(symbol, interval, totalBars) {
  const limit = 1000;
  let allKlines = [];
  let endTime = Date.now();

  while (allKlines.length < totalBars) {
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}&endTime=${endTime}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Error Binance API: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    if (!data.length) break;

    allKlines = data.concat(allKlines);
    endTime = data[0][0] - 1; // retroceder antes de la primera vela recibida

    // Respeta rate limits de Binance
    await new Promise((r) => setTimeout(r, 300));
  }

  // Ordenar por tiempo ascendente y recortar al tamaño pedido
  allKlines.sort((a, b) => a[0] - b[0]);
  const trimmed = allKlines.slice(-totalBars);

  return trimmed.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
  }));
}

// ---------------------------------------------------------------------
// 2. Detección de pivote "auto" (igual que el indicador): el extremo
//    (máximo o mínimo) más reciente dentro de la ventana lookback
// ---------------------------------------------------------------------
function detectPivot(candles, currentIndex, lookback) {
  const start = Math.max(0, currentIndex - lookback);
  let lowestVal = Infinity;
  let lowestIdx = -1;
  let highestVal = -Infinity;
  let highestIdx = -1;

  for (let i = start; i <= currentIndex; i++) {
    if (candles[i].low < lowestVal) {
      lowestVal = candles[i].low;
      lowestIdx = i;
    }
    if (candles[i].high > highestVal) {
      highestVal = candles[i].high;
      highestIdx = i;
    }
  }

  // Auto: el más reciente de los dos extremos
  const isLow = (currentIndex - lowestIdx) <= (currentIndex - highestIdx);

  return isLow
    ? { price: lowestVal, index: lowestIdx, isLow: true }
    : { price: highestVal, index: highestIdx, isLow: false };
}

// ---------------------------------------------------------------------
// 3. Simulación walk-forward: recalcula pivote cada barra, pero solo
//    "congela" una nueva unidad Gann cuando el pivote cambia de índice.
//    Detecta cruces de close contra la línea 1x1 proyectada.
// ---------------------------------------------------------------------
function simulateCrosses(candles, lookback) {
  const crosses = [];
  let currentPivot = null;
  let gannUnit = 0;
  let wasAboveLine = null;

  for (let i = 1; i < candles.length; i++) {
    const pivot = detectPivot(candles, i, lookback);

    const pivotChanged = !currentPivot || currentPivot.index !== pivot.index || currentPivot.isLow !== pivot.isLow;

    if (pivotChanged) {
      currentPivot = pivot;
      const timeElapsed = i - pivot.index;
      if (timeElapsed > 0) {
        const priceRange = pivot.isLow
          ? candles[i].close - pivot.price
          : pivot.price - candles[i].close;
        gannUnit = priceRange / timeElapsed;
      } else {
        gannUnit = 0;
      }
      wasAboveLine = null; // reset tras cambio de pivote
    }

    if (!currentPivot || i <= currentPivot.index) continue;

    const t = i - currentPivot.index;
    const line1x1 = currentPivot.isLow
      ? currentPivot.price + gannUnit * t
      : currentPivot.price - gannUnit * t;

    const isAbove = candles[i].close > line1x1;

    if (wasAboveLine !== null && isAbove !== wasAboveLine) {
      crosses.push({
        index: i,
        time: candles[i].time,
        direction: isAbove ? 'ALCISTA' : 'BAJISTA',
        priceAtCross: candles[i].close,
      });
    }

    wasAboveLine = isAbove;
  }

  return crosses;
}

// ---------------------------------------------------------------------
// 4. Evaluación: ¿el precio se movió en la dirección esperada N barras
//    después del cruce?
// ---------------------------------------------------------------------
function evaluateCrosses(candles, crosses, forwardBars) {
  let wins = 0;
  let losses = 0;
  const results = [];

  for (const cross of crosses) {
    const futureIndex = cross.index + forwardBars;
    if (futureIndex >= candles.length) continue; // sin datos suficientes hacia adelante

    const futurePrice = candles[futureIndex].close;
    const priceChange = futurePrice - cross.priceAtCross;
    const isWin = cross.direction === 'ALCISTA' ? priceChange > 0 : priceChange < 0;

    if (isWin) wins++;
    else losses++;

    results.push({ ...cross, futurePrice, priceChange, isWin });
  }

  const total = wins + losses;
  const winRate = total > 0 ? (wins / total) * 100 : null;

  return { wins, losses, total, winRate, results };
}

// ---------------------------------------------------------------------
// 4b. Control aleatorio: genera N "cruces" en índices e direcciones al
//    azar (mismo tamaño de muestra que los cruces reales) y calcula su
//    win rate. Sirve para saber si el resultado de Gann supera al azar.
// ---------------------------------------------------------------------
function randomControlWinRate(candles, sampleSize, forwardBars, iterations = 500) {
  const minIndex = 1;
  const maxIndex = candles.length - forwardBars - 1;
  if (maxIndex <= minIndex || sampleSize <= 0) return null;

  const rates = [];

  for (let iter = 0; iter < iterations; iter++) {
    let wins = 0;
    for (let n = 0; n < sampleSize; n++) {
      const idx = minIndex + Math.floor(Math.random() * (maxIndex - minIndex));
      const direction = Math.random() < 0.5 ? 'ALCISTA' : 'BAJISTA';
      const priceChange = candles[idx + forwardBars].close - candles[idx].close;
      const isWin = direction === 'ALCISTA' ? priceChange > 0 : priceChange < 0;
      if (isWin) wins++;
    }
    rates.push((wins / sampleSize) * 100);
  }

  const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
  return avg;
}

// ---------------------------------------------------------------------
// 5. Main
// ---------------------------------------------------------------------
async function main() {
  const summary = [];

  for (const timeframe of TIMEFRAMES) {
    const barsToFetch = BARS_TO_FETCH_BY_TF[timeframe];
    const forwardBars = FORWARD_BARS_BY_TF[timeframe];

    console.log(`\n📊 Descargando datos ${SYMBOL} ${timeframe}...`);
    const candles = await fetchKlines(SYMBOL, timeframe, barsToFetch);
    console.log(`   ${candles.length} velas descargadas (${new Date(candles[0].time).toISOString()} → ${new Date(candles[candles.length - 1].time).toISOString()})`);

    for (const lookback of LOOKBACKS) {
      const crosses = simulateCrosses(candles, lookback);
      const evalResult = evaluateCrosses(candles, crosses, forwardBars);
      const controlWinRate = randomControlWinRate(candles, evalResult.total, forwardBars);
      const edge = evalResult.winRate !== null && controlWinRate !== null
        ? evalResult.winRate - controlWinRate
        : null;

      summary.push({
        timeframe,
        lookback,
        totalCruces: evalResult.total,
        aciertos: evalResult.wins,
        fallos: evalResult.losses,
        winRate: evalResult.winRate,
        controlWinRate,
        edge,
      });

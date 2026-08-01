/**
 * Backtest: comparación de pivotLookback (20 / 50 / 100) para el indicador
 * de ángulos de Gann, sobre BTC/USDT en 1H, 4H y 1D.
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
const TIMEFRAMES = ['1h', '4h', '1d'];
const LOOKBACKS = [20, 50, 100];
const FORWARD_BARS = 10; // barras hacia adelante para evaluar si el cruce "acertó"
const BARS_TO_FETCH = 3000; // barras históricas a descargar por timeframe

// ---------------------------------------------------------------------
// 1. Descarga de datos históricos de Binance (paginado, sin API key)
// ---------------------------------------------------------------------
async function fetchKlines(symbol, interval, totalBars) {
  const limit = 1000;
  let allKlines = [];
  let endTime = Date.now();

  while (allKlines.length < totalBars) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}&endTime=${endTime}`;
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
// 5. Main
// ---------------------------------------------------------------------
async function main() {
  const summary = [];

  for (const timeframe of TIMEFRAMES) {
    console.log(`\n📊 Descargando datos ${SYMBOL} ${timeframe}...`);
    const candles = await fetchKlines(SYMBOL, timeframe, BARS_TO_FETCH);
    console.log(`   ${candles.length} velas descargadas (${new Date(candles[0].time).toISOString()} → ${new Date(candles[candles.length - 1].time).toISOString()})`);

    for (const lookback of LOOKBACKS) {
      const crosses = simulateCrosses(candles, lookback);
      const evalResult = evaluateCrosses(candles, crosses, FORWARD_BARS);

      summary.push({
        timeframe,
        lookback,
        totalCruces: evalResult.total,
        aciertos: evalResult.wins,
        fallos: evalResult.losses,
        winRate: evalResult.winRate,
      });

      console.log(`   Lookback ${lookback}: ${evalResult.total} cruces evaluables | Win rate: ${evalResult.winRate?.toFixed(2)}%`);
    }
  }

  console.log('\n\n========== RESUMEN FINAL ==========\n');
  console.table(summary.map((s) => ({
    Timeframe: s.timeframe,
    Lookback: s.lookback,
    'Cruces evaluados': s.totalCruces,
    Aciertos: s.aciertos,
    Fallos: s.fallos,
    'Win Rate %': s.winRate !== null ? s.winRate.toFixed(2) : 'N/A',
  })));

  // Mejor combinación por timeframe
  console.log('\n🏆 Mejor lookback por timeframe (según win rate):\n');
  for (const timeframe of TIMEFRAMES) {
    const options = summary.filter((s) => s.timeframe === timeframe && s.winRate !== null);
    if (!options.length) continue;
    const best = options.reduce((a, b) => (b.winRate > a.winRate ? b : a));
    console.log(`   ${timeframe}: lookback=${best.lookback} (win rate ${best.winRate.toFixed(2)}%, ${best.totalCruces} cruces)`);
  }
}

main().catch((err) => {
  console.error('Error ejecutando el backtest:', err);
  process.exit(1);
});

// ============================================================
// 🦊 El Cauto Temerario · Bot de alertas EN VIVO
// ------------------------------------------------------------
// Estrategia validada en el backtest (simulateConfluenciaTPParcial
// de bitman-backtest.js), actualizada el 30 de julio de 2026 tras
// comprobar que la señal en 1H no sobrevivía a comisiones reales
// de Bitget:
//   - Entrada en 4H (no en 1H): el propio 4H tiene que dar su
//     señal completa (AO + ADX subiendo + Koncorde), confirmada
//     por el Diario (AO + Koncorde en la misma dirección).
//   - SIN stop loss: la posición se cierra por Take Profit parcial,
//     por cierre forzado de Koncorde (solo largos) o porque el
//     veredicto deja de confirmar esa dirección.
//   - Al tocar el TP cierra el 50% y deja correr el resto.
//   - Recomendación de gestión (se recuerda en cada aviso, pero el
//     bot NO opera ni mueve dinero): 12% del capital por operación,
//     5x de apalancamiento — validado con comisiones reales y con
//     los últimos 12 meses reservados como fuera de muestra
//     (ver ESTRATEGIA-confluencia-sin-sl.md).
//
// Toda la lógica vive en bitman-motor.js, compartida con
// El Zorro Salvaje. Este archivo solo declara en qué se diferencian:
// la fracción que se cierra al tocar el TP (50% aquí, 20% allí).
// ============================================================

const path = require('path');
const { ejecutarBot } = require('./bitman-motor');

const LEVERAGE = 5;

// El TP se define como % de beneficio sobre la POSICIÓN APALANCADA
// (lo que ves en la cuenta), no como % de movimiento de precio.
// Con 5x, pedir un 15% sobre la posición implica que el precio solo
// tiene que moverse 15/5 = 3%.
const TP_EQUITY_PCT = 15;

ejecutarBot({
  nombre: 'El Cauto Temerario',
  emoji: '🦊',
  symbol: process.env.SYMBOL || 'BTCUSDT',
  stateFile: path.join(__dirname, 'state-cauto-temerario.json'),

  leverage: LEVERAGE,
  tpEquityPct: TP_EQUITY_PCT,
  tpPct: TP_EQUITY_PCT / LEVERAGE,   // % de movimiento de PRECIO necesario
  riskPct: 12,                        // solo informativo (validado 12-20%)

  // ÚNICA diferencia funcional con El Zorro Salvaje:
  fraccionTpParcial: 0.50,

  modoPrueba: true, // mantiene el aviso de prueba mientras se observa en vivo

  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatIds: (process.env.TELEGRAM_CHAT_ID || '')
    .split(',').map(id => id.trim()).filter(id => id.length > 0)
}).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

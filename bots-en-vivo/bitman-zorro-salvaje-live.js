// ============================================================
// 🐺 El Zorro Salvaje · Bot de alertas EN VIVO
// ------------------------------------------------------------
// Hermano de "El Cauto Temerario": mismo motor de señal (4H
// confirmado por el Diario, sin stop loss), pero con un reparto
// del TP parcial más arriesgado — cierra solo el 20% al llegar al
// TP y deja correr el 80% restante sin ninguna protección.
// Validado el 2 de agosto de 2026 (BTC 10/10 años positivos,
// ETH 9/10) como el mejor punto de drawdown con el 5x real
// (ver la Sección -5 de ESTRATEGIA-confluencia-sin-sl.md).
//
// Toda la lógica vive en bitman-motor.js, compartida con
// El Cauto Temerario. Este archivo solo declara en qué se
// diferencian: la fracción que se cierra al tocar el TP.
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
  nombre: 'El Zorro Salvaje',
  emoji: '🐺',
  symbol: process.env.SYMBOL || 'BTCUSDT',
  stateFile: path.join(__dirname, 'state-zorro-salvaje.json'),

  leverage: LEVERAGE,
  tpEquityPct: TP_EQUITY_PCT,
  tpPct: TP_EQUITY_PCT / LEVERAGE,   // % de movimiento de PRECIO necesario
  riskPct: 12,                        // solo informativo

  // ÚNICA diferencia funcional con El Cauto Temerario:
  fraccionTpParcial: 0.20,

  modoPrueba: true, // mantiene el aviso de prueba mientras se observa en vivo

  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatIds: (process.env.TELEGRAM_CHAT_ID || '')
    .split(',').map(id => id.trim()).filter(id => id.length > 0)
}).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

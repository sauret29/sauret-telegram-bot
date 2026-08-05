// ============================================================
// Pruebas del motor compartido — sin red, con series construidas
// a mano para que cada caso aísle un fallo concreto.
// Ejecutar con:  node bots-en-vivo/bitman-motor.test.js
// ============================================================

const { replay } = require('./bitman-motor');

const CFG = {
  fraccionTpParcial: 0.50,
  tpPct: 3,
  tpEquityPct: 15,
  leverage: 5,
  riskPct: 12,
  modoPrueba: false
};

let pasadas = 0, falladas = 0;
function comprobar(nombre, condicion, detalle){
  if(condicion){ pasadas++; console.log('  ✓ ' + nombre); }
  else { falladas++; console.log('  ✗ ' + nombre + (detalle ? '\n      → ' + detalle : '')); }
}

const H = 4*60*60*1000;

// Construye una serie de 4H con los campos que usa el motor.
// Por defecto: todo plano, veredicto ESPERAR, Koncorde por encima de su media.
function serie4H(n, mods){
  const s = {
    n,
    times: Array.from({length:n}, (_,i)=> i*H),
    opens:  new Array(n).fill(100),
    highs:  new Array(n).fill(100),
    lows:   new Array(n).fill(100),
    closes: new Array(n).fill(100),
    aoState: new Array(n).fill('Retroceso alcista'),
    adxSubiendo: new Array(n).fill(false),
    koBull: new Array(n).fill(false),
    koBear: new Array(n).fill(false),
    konVal: new Array(n).fill(10),
    maTrend: new Array(n).fill(5)
  };
  if(mods) mods(s);
  return s;
}
function serieDiaria(n, mods){
  const s = {
    n,
    times: Array.from({length:n}, (_,i)=> i*24*60*60*1000),
    aoState: new Array(n).fill('Retroceso alcista'),
    koBull: new Array(n).fill(false),
    koBear: new Array(n).fill(false)
  };
  if(mods) mods(s);
  return s;
}
function recorta(s, hasta){
  const out = { n: hasta+1 };
  for(const k of Object.keys(s)){
    if(k==='n') continue;
    out[k] = s[k].slice(0, hasta+1);
  }
  return out;
}
const planoInicial = t => ({ position:null, entryPrice:null, tpPrice:null, entryTime:null, tpParcialHecho:false, lastProcessedTime:t });

// ------------------------------------------------------------
console.log('\n1) FALLO 1 — el cierre forzado NO debe abrir cortos');
// ------------------------------------------------------------
{
  // Sin posición, veredicto ESPERAR, y Koncorde POR DEBAJO de su media.
  // El bot antiguo reescribía el veredicto a 'VENDER' y abría un corto.
  const s4h = serie4H(6, s => { s.konVal.fill(-10); s.maTrend.fill(5); });
  const sD  = serieDiaria(3);
  const r = replay(s4h, sD, planoInicial(s4h.times[0]), CFG);

  comprobar('sin posición y Koncorde bajo su media → no se abre nada',
    r.messages.length === 0 && r.newState.position === null,
    'mensajes=' + r.messages.length + ' posición=' + r.newState.position);
}

// ------------------------------------------------------------
console.log('\n2) FALLO 1 — el cierre forzado SÍ debe cerrar largos');
// ------------------------------------------------------------
{
  const s4h = serie4H(4, s => { s.konVal.fill(-10); s.maTrend.fill(5); });
  const sD  = serieDiaria(3);
  const estado = { position:'long', entryPrice:100, tpPrice:103, entryTime:0, tpParcialHecho:false, lastProcessedTime:s4h.times[0] };
  const r = replay(s4h, sD, estado, CFG);

  comprobar('largo abierto + Koncorde bajo su media → se cierra',
    r.newState.position === null && /Cierre forzado/.test(r.messages.join('')),
    'posición=' + r.newState.position);
}

// ------------------------------------------------------------
console.log('\n3) FALLO 1 — un corto debe cerrarse al perder el veredicto');
// ------------------------------------------------------------
{
  // Veredicto ESPERAR y Koncorde por debajo de su media.
  // El bot antiguo forzaba verdict='VENDER', con lo que stillValid seguía
  // siendo verdadero y el corto NO se cerraba nunca.
  const s4h = serie4H(4, s => { s.konVal.fill(-10); s.maTrend.fill(5); });
  const sD  = serieDiaria(3);
  const estado = { position:'short', entryPrice:100, tpPrice:97, entryTime:0, tpParcialHecho:false, lastProcessedTime:s4h.times[0] };
  const r = replay(s4h, sD, estado, CFG);

  comprobar('corto abierto + veredicto ESPERAR → se cierra',
    r.newState.position === null,
    'posición=' + r.newState.position + ' mensajes=' + r.messages.length);
}

// ------------------------------------------------------------
console.log('\n4) FALLO 3 — un TP en una vela intermedia no se pierde');
// ------------------------------------------------------------
{
  // Entrada en la vela 2, el TP se toca en la vela 4, y el bot no
  // se ejecuta hasta la vela 6. El bot antiguo solo miraba la última
  // vela, así que ese TP desaparecía para siempre.
  const construir = () => {
    const s4h = serie4H(7, s => {
      // Velas 2 a 5: señal de COMPRA completa y sostenida en 4H.
      for(let i=2;i<=5;i++){ s.aoState[i]='Alcista'; s.adxSubiendo[i]=true; s.koBull[i]=true; }
      // Vela 4: mecha que toca el TP (100 × 1.03 = 103).
      s.highs[4]=105;
      // Vela 6: el veredicto deja de confirmar → cierra el resto.
      s.aoState[6]='Retroceso alcista';
    });
    const sD = serieDiaria(2, s => { s.aoState.fill('Alcista'); s.koBull.fill(true); });
    return { s4h, sD };
  };

  // (a) el bot se ejecuta en CADA vela
  const a = construir();
  let estadoA = planoInicial(a.s4h.times[1]);
  const mensajesA = [];
  for(let i=2;i<a.s4h.n;i++){
    const r = replay(recorta(a.s4h, i), a.sD, estadoA, CFG);
    mensajesA.push(...r.messages);
    estadoA = r.newState;
  }

  // (b) el bot se cae y solo se ejecuta al final
  const b = construir();
  const rB = replay(b.s4h, b.sD, planoInicial(b.s4h.times[1]), CFG);

  const soloTitulares = ms => ms.map(m => m.split('\n')[0]);

  comprobar('se detecta el TP parcial aunque el bot no corriera esa vela',
    /TP parcial alcanzado/.test(rB.messages.join('')),
    'mensajes=' + JSON.stringify(soloTitulares(rB.messages)));

  comprobar('ejecutarse en cada vela y ejecutarse una vez dan lo mismo',
    JSON.stringify(soloTitulares(mensajesA)) === JSON.stringify(soloTitulares(rB.messages)),
    'cada vela: ' + JSON.stringify(soloTitulares(mensajesA)) +
    '\n      una vez : ' + JSON.stringify(soloTitulares(rB.messages)));

  comprobar('el estado final coincide en ambos caminos',
    JSON.stringify(estadoA) === JSON.stringify(rB.newState),
    'cada vela: ' + JSON.stringify(estadoA) + '\n      una vez : ' + JSON.stringify(rB.newState));
}

// ------------------------------------------------------------
console.log('\n5) Orden de decisiones idéntico al backtest');
// ------------------------------------------------------------
{
  // Con TP y pérdida de veredicto en la MISMA vela, el backtest cobra
  // el TP parcial (rama hitTP) y no cierra: el resto sigue corriendo.
  const s4h = serie4H(3, s => { s.highs[2]=105; });
  const sD  = serieDiaria(2);
  const estado = { position:'long', entryPrice:100, tpPrice:103, entryTime:0, tpParcialHecho:false, lastProcessedTime:s4h.times[1] };
  const r = replay(s4h, sD, estado, CFG);

  comprobar('TP y pérdida de veredicto a la vez → manda el TP parcial',
    r.newState.tpParcialHecho === true && r.newState.position === 'long',
    'tpParcialHecho=' + r.newState.tpParcialHecho + ' posición=' + r.newState.position);
}

// ------------------------------------------------------------
console.log('\n6) La primera ejecución no inunda de avisos');
// ------------------------------------------------------------
{
  // Estado sin lastProcessedTime (formato antiguo): solo debe mirar
  // la última vela cerrada, no reconstruir 400 velas de historia.
  const s4h = serie4H(50, s => {
    for(let i=0;i<50;i++){ s.aoState[i]='Alcista'; s.adxSubiendo[i]=true; s.koBull[i]=true; }
  });
  const sD = serieDiaria(9, s => { s.aoState.fill('Alcista'); s.koBull.fill(true); });
  const r = replay(s4h, sD, planoInicial(null), CFG);

  comprobar('migración desde el formato antiguo → una sola vela procesada',
    r.procesadas === 1,
    'procesadas=' + r.procesadas);
}

console.log('\n' + '='.repeat(50));
console.log(pasadas + ' pruebas pasadas, ' + falladas + ' falladas');
console.log('='.repeat(50) + '\n');
process.exit(falladas ? 1 : 0);

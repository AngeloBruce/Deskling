// Pruebas de las rachas: días libres, récord, corte del día y el flujo del vaso.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Streaks, WaterFlow } = require('../src/streaks');

/** Un reloj de mentira: `at('2026-11-03')` lo pone al mediodía de ese día. */
function clock() {
  let now = 0;
  const at = (date, time = '12:00') => { now = new Date(`${date}T${time}:00`).getTime(); };
  return { at, now: () => now };
}

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rachas-')), 'streaks.json');
}

/** Marca foco cumplido en cada fecha. */
function focusOn(s, c, dates) {
  for (const d of dates) { c.at(d); s.pomodoro(); }
}

const focus = (s, rest) => s.status(rest).find((x) => x.id === 'focus');

test('días seguidos suman y hoy sin cumplir todavía no corta', () => {
  const c = clock();
  const s = new Streaks(null, { now: c.now });
  focusOn(s, c, ['2026-11-01', '2026-11-02', '2026-11-03']);
  assert.equal(focus(s, 0).current, 3);
  c.at('2026-11-04');
  assert.equal(focus(s, 0).current, 3);
  assert.equal(focus(s, 0).doneToday, false);
});

test('sin días libres, un día sin cumplir corta la racha pero no el récord', () => {
  const c = clock();
  const s = new Streaks(null, { now: c.now });
  focusOn(s, c, ['2026-11-01', '2026-11-02', '2026-11-04']);
  assert.deepEqual([focus(s, 0).current, focus(s, 0).best], [1, 2]);
});

test('un día libre no corta ni suma', () => {
  const c = clock();
  const s = new Streaks(null, { now: c.now });
  focusOn(s, c, ['2026-11-01', '2026-11-02', '2026-11-04']);
  assert.equal(focus(s, 1).current, 3);
});

test('los días libres se limitan por semana y se recuperan después', () => {
  const c = clock();
  const s = new Streaks(null, { now: c.now });
  // falta el 3 (libre) y el 5: dos en la misma semana, con margen de uno, corta
  focusOn(s, c, ['2026-11-01', '2026-11-02', '2026-11-04', '2026-11-06']);
  assert.equal(focus(s, 1).current, 1);

  const c2 = clock();
  const s2 = new Streaks(null, { now: c2.now });
  // faltas separadas por más de una semana: las dos entran en el margen
  const dates = [];
  for (let d = 1; d <= 20; d++) if (d !== 3 && d !== 12) dates.push(`2026-11-${String(d).padStart(2, '0')}`);
  focusOn(s2, c2, dates);
  assert.equal(focus(s2, 1).current, 18);
});

test('el récord no baja aunque cambien los días libres', () => {
  const c = clock();
  const s = new Streaks(null, { now: c.now });
  focusOn(s, c, ['2026-11-01', '2026-11-02', '2026-11-04']);
  assert.equal(focus(s, 1).best, 3);
  assert.equal(focus(s, 0).best, 3); // con menos margen, el historial daría 2
});

test('trasnochar sigue siendo el mismo día hasta las 4', () => {
  const c = clock();
  const s = new Streaks(null, { now: c.now });
  c.at('2026-11-03', '23:50');
  s.pomodoro();
  c.at('2026-11-04', '01:30');
  s.pomodoro();
  assert.equal(focus(s, 0).current, 1);
  assert.equal(s.data.days['2026-11-03'].pomodoros, 2);
  c.at('2026-11-04', '04:10');
  s.pomodoro();
  assert.equal(focus(s, 0).current, 2);
});

test('sin distracción se cuenta recién cuando termina el día', () => {
  const c = clock();
  const s = new Streaks(null, { now: c.now });
  const calm = () => s.status(0).find((x) => x.id === 'calm').current;
  c.at('2026-11-03');
  s.addActive(1200, false);
  assert.equal(calm(), 0);
  c.at('2026-11-04');
  assert.equal(calm(), 1);
  s.addActive(1200, false);
  s.addActive(120, true); // más que pasar de largo
  c.at('2026-11-05');
  assert.equal(calm(), 0);
});

test('un día casi sin uso no cuenta para constancia ni sin distracción', () => {
  const c = clock();
  const s = new Streaks(null, { now: c.now });
  c.at('2026-11-03');
  s.addActive(60, false);
  c.at('2026-11-04');
  const st = s.status(0);
  assert.equal(st.find((x) => x.id === 'active').current, 0);
  assert.equal(st.find((x) => x.id === 'calm').current, 0);
});

test('la meta de agua cumplida no se reescribe si después cambia', () => {
  const c = clock();
  const s = new Streaks(null, { now: c.now });
  const water = (rest = 0) => s.status(rest).find((x) => x.id === 'water');
  c.at('2026-11-03');
  s.drink(2);
  assert.equal(s.waterReached(2), false);
  s.drink(2);
  assert.equal(s.waterReached(2), true);
  assert.equal(s.waterReached(4), true); // subir la meta no borra el día ya cumplido
  assert.equal(water().current, 1);
  c.at('2026-11-04');
  s.drink(4);
  assert.equal(s.waterReached(1), true); // bajar la meta sí lo completa
  assert.equal(water().current, 2);
});

test('una racha cortada se avisa una sola vez, y las cortitas no', () => {
  const c = clock();
  const s = new Streaks(null, { now: c.now });
  focusOn(s, c, ['2026-11-01', '2026-11-02', '2026-11-03']);
  c.at('2026-11-05');
  const broken = s.takeBroken(0);
  assert.deepEqual(broken.map((b) => [b.id, b.days, b.best]), [['focus', 3, 3]]);
  assert.deepEqual(s.takeBroken(0), []);
  c.at('2026-11-06');
  assert.deepEqual(s.takeBroken(0), []);

  const c2 = clock();
  const s2 = new Streaks(null, { now: c2.now });
  focusOn(s2, c2, ['2026-11-01', '2026-11-02']);
  c2.at('2026-11-05');
  assert.deepEqual(s2.takeBroken(0), []);
});

test('guarda y vuelve a leer', () => {
  const file = tempFile();
  const c = clock();
  const s = new Streaks(file, { now: c.now });
  focusOn(s, c, ['2026-11-01', '2026-11-02']);
  s.status(0);
  s.save();
  const again = new Streaks(file, { now: c.now });
  assert.equal(focus(again, 0).current, 2);
  assert.equal(again.data.best.focus, 2);
});

test('solo guarda fechas y cantidades', () => {
  const file = tempFile();
  const c = clock();
  const s = new Streaks(file, { now: c.now });
  c.at('2026-11-03');
  s.addActive(600, true);
  s.drink(4);
  s.save();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(saved.days), ['2026-11-03']);
  for (const v of Object.values(saved.days['2026-11-03'])) assert.ok(['number', 'boolean'].includes(typeof v));
});

test('un archivo roto queda con copia y no tumba nada', () => {
  const file = tempFile();
  fs.writeFileSync(file, '{ roto');
  const errors = [];
  const c = clock();
  c.at('2026-11-03');
  const s = new Streaks(file, { now: c.now, onError: (m) => errors.push(m) });
  assert.equal(errors.length, 1);
  assert.equal(focus(s, 0).current, 0);
  const copies = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.bak-'));
  assert.equal(fs.readFileSync(path.join(path.dirname(file), copies[0]), 'utf8'), '{ roto');
});

test('si no se puede leer, no se escribe', () => {
  const file = tempFile();
  fs.mkdirSync(file); // una carpeta en lugar del archivo
  fs.writeFileSync(path.join(file, 'testigo.txt'), 'intacto');
  const c = clock();
  c.at('2026-11-03');
  const s = new Streaks(file, { now: c.now });
  s.pomodoro();
  s.save();
  assert.equal(fs.readFileSync(path.join(file, 'testigo.txt'), 'utf8'), 'intacto');
});

test('valores escritos a mano se ignoran', () => {
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({
    days: {
      '2026-11-02': { pomodoros: 1, water: -3, activeSec: 'mucho' },
      '2026-13-45': { pomodoros: 1 },
      constructor: { pomodoros: 1 },
      '2026-11-01': 5,
    },
    best: { focus: 'mil', water: 7, otra: 3 },
    brokenSeen: { focus: 'ayer' },
  }));
  const c = clock();
  c.at('2026-11-02');
  const s = new Streaks(file, { now: c.now });
  assert.deepEqual(Object.keys(s.data.days), ['2026-11-02']);
  assert.equal(s.data.days['2026-11-02'].water, 0);
  assert.equal(s.data.days['2026-11-02'].activeSec, 0);
  assert.equal(focus(s, 0).current, 1);
  assert.equal(s.data.best.water, 7);
  assert.equal(s.data.brokenSeen.focus, '');
  assert.ok(!Object.hasOwn(s.data.best, 'otra'));
});

test('el vaso: ofrece, pregunta a los 2 avisos y vuelve a ofrecer', () => {
  const w = new WaterFlow();
  w.tick();
  assert.equal(w.due(false), 'offer');
  assert.ok(w.start(2));
  w.tick();
  assert.equal(w.due(false), null);
  w.tick();
  assert.equal(w.due(false), 'ask');
  assert.ok(w.finish(2));
  assert.equal(w.due(false), null);
  w.tick();
  w.tick();
  assert.equal(w.due(false), 'offer');
});

test('el vaso: "todavía no" pregunta al próximo aviso', () => {
  const w = new WaterFlow();
  w.start(2);
  assert.ok(w.later());
  w.tick();
  assert.equal(w.due(false), 'ask');
});

test('el vaso: sin contestar se repite después del mismo tiempo', () => {
  const w = new WaterFlow();
  w.tick();
  assert.equal(w.due(false), 'offer');
  w.shown(2);
  w.tick();
  assert.equal(w.due(false), null);
  w.tick();
  assert.equal(w.due(false), 'offer');
});

test('el vaso: un doble clic no suma dos', () => {
  const w = new WaterFlow();
  w.start(2);
  assert.ok(w.finish(2));
  assert.equal(w.finish(2), false);
  assert.equal(w.later(), false);
  assert.ok(w.start(2));
  assert.equal(w.start(2), false);
});

test('el vaso: con la meta cumplida no ofrece, pero sí pregunta por el que tenés', () => {
  const w = new WaterFlow();
  w.tick();
  assert.equal(w.due(true), null);
  w.start(1);
  w.tick();
  assert.equal(w.due(true), 'ask');
});

test('el vaso: una pregunta que no se pudo hacer queda pendiente', () => {
  const w = new WaterFlow();
  w.start(1);
  w.tick();
  w.tick(); // no se pudo mostrar (foco, pausa…): no se pierde
  assert.equal(w.due(false), 'ask');
});

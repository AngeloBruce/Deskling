// Pruebas del pomodoro con un reloj falso (no hay que esperar 25 minutos de verdad).
const { test } = require('node:test');
const assert = require('node:assert');
const { Pomodoro } = require('../src/focus');

const MIN = 60 * 1000;

function make() {
  const phases = [];
  const p = new Pomodoro({
    workMinutes: 25, breakMinutes: 5, longBreakMinutes: 15, cyclesBeforeLongBreak: 4,
    onPhase: (info) => phases.push(info.phase),
  });
  return { p, phases };
}

test('foco → descanso → foco', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { p, phases } = make();
  p.start();
  assert.equal(p.working, true);
  t.mock.timers.tick(25 * MIN);
  assert.equal(p.phase, 'break');
  t.mock.timers.tick(5 * MIN);
  assert.equal(p.phase, 'work');
  assert.deepEqual(phases, ['work', 'break', 'work']);
  p.stop();
});

test('cada 4 focos toca descanso largo', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { p, phases } = make();
  p.start();
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(25 * MIN); t.mock.timers.tick(5 * MIN); } // 3 focos + 3 descansos cortos
  t.mock.timers.tick(25 * MIN); // 4º foco
  assert.equal(p.phase, 'longBreak');
  assert.equal(p.cycle, 4);
  assert.equal(phases.filter((f) => f === 'break').length, 3);
  p.stop();
});

test('terminar foco lo apaga y no sigue contando', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { p, phases } = make();
  p.start();
  t.mock.timers.tick(10 * MIN);
  p.stop();
  assert.equal(p.active, false);
  for (let i = 0; i < 6; i++) t.mock.timers.tick(10 * MIN);
  assert.deepEqual(phases, ['work', 'off']);
});

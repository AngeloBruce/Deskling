// Pruebas del contador del día (sin guardar a disco: DayStats(null)).
const test = require('node:test');
const assert = require('node:assert');
const { DayStats, fmt, prettyApp, clock } = require('../src/stats');

test('formato de tiempo', () => {
  assert.equal(fmt(20), '<1 min');
  assert.equal(fmt(45 * 60), '45 min');
  assert.equal(fmt(2 * 3600 + 10 * 60), '2 h 10 min');
  assert.equal(fmt(3 * 3600), '3 h');
});

test('nombres de apps', () => {
  assert.equal(prettyApp('Code'), 'VS Code');
  assert.equal(prettyApp('WindowsTerminal'), 'Terminal');
  assert.equal(prettyApp('obsidian'), 'Obsidian');
});

test('resumen con un día típico', () => {
  const s = new DayStats(null);
  s.addApp('Code', 2 * 3600);
  s.addApp('brave', 3600);
  s.addApp('claude', 1800);
  s.addApp('explorer', 60);
  s.pomodoro(); s.pomodoro();
  s.claude();
  s.song('C418'); s.song('C418'); s.song('dkj');
  s.data.since = new Date(2026, 9, 30, 9, 5).getTime();
  const lines = s.lines();
  assert.equal(lines[0], '📊 Tu día (desde las 09:05): 3 h 31 min en la compu');
  assert.equal(lines[1], '💻 VS Code 2 h · Brave 1 h · Claude 30 min'); // solo el top 3
  assert.equal(lines[2], '🍅 2 pomodoros · ✅ Claude terminó 1 vez');
  assert.equal(lines[3], '🎵 3 canciones, más C418');
});

test('día vacío no inventa nada', () => {
  const s = new DayStats(null);
  assert.deepEqual(s.lines(), ['📊 Tu día: <1 min en la compu']);
});

test('no cuenta partes de Windows (menú Inicio, búsqueda…)', () => {
  const s = new DayStats(null);
  s.addApp('SearchHost', 10);
  s.addApp('ShellExperienceHost', 10);
  assert.equal(s.totalSec(), 0);
  assert.equal(s.data.since, 0);
  s.addApp('Code', 60);
  assert.equal(s.totalSec(), 60);
  assert.ok(s.data.since > 0);
});

test('hora del "desde las"', () => {
  assert.equal(clock(new Date(2026, 9, 30, 23, 6).getTime()), '23:06');
});

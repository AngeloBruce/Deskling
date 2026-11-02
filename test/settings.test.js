// Pruebas de la configuración: que nunca se pierda nada y que la ventana no pueda escribir de más.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const s = require('../src/settings');
const { LEGACY_PERSONALITY } = require('../src/presets');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskling-test-'));
  return path.join(dir, 'config.json');
}

test('mergeConfig: combina objetos y reemplaza listas enteras', () => {
  const merged = s.mergeConfig(
    { focus: { workMinutes: 25, breakMinutes: 5 }, privateApps: ['a', 'b'] },
    { focus: { workMinutes: 50 }, privateApps: ['c'] },
  );
  assert.deepEqual(merged, { focus: { workMinutes: 50, breakMinutes: 5 }, privateApps: ['c'] });
});

test('mergeConfig: una lista vacía del usuario gana a la de los valores por defecto', () => {
  assert.deepEqual(s.mergeConfig({ tips: ['x'] }, { tips: [] }), { tips: [] });
});

test('mergeConfig: no deja tocar el prototipo', () => {
  s.mergeConfig({}, JSON.parse('{"__proto__": {"hackeado": true}}'));
  assert.equal({}.hackeado, undefined);
});

test('diffConfig: guarda solo lo que cambia', () => {
  const base = { a: 1, n: { x: 1, y: 2 }, l: ['p'] };
  assert.deepEqual(s.diffConfig(base, { a: 1, n: { x: 1, y: 3 }, l: ['p'], nuevo: true }), { n: { y: 3 }, nuevo: true });
});

test('readUserConfig: distingue archivo inexistente de archivo roto', () => {
  assert.equal(s.readUserConfig(tempFile()).status, 'missing');
});

test('readUserConfig: un JSON roto queda intacto y con copia', () => {
  const file = tempFile();
  fs.writeFileSync(file, '{ "userName": "Ana", }');
  const r = s.readUserConfig(file);
  assert.equal(r.status, 'corrupt');
  assert.deepEqual(r.config, {});
  assert.equal(fs.readFileSync(file, 'utf8'), '{ "userName": "Ana", }');
  assert.equal(fs.readFileSync(r.backup, 'utf8'), '{ "userName": "Ana", }');
});

test('readUserConfig: si no se puede leer no se cae y lo avisa', () => {
  const file = tempFile();
  fs.mkdirSync(file); // una carpeta en lugar del archivo: da un error de lectura en cualquier sistema
  const r = s.readUserConfig(file);
  assert.equal(r.status, 'unreadable');
  assert.deepEqual(r.config, {});
  assert.ok(r.code);
});

test('readUserConfig: un JSON roto sin copia posible también cuenta como ilegible', (t) => {
  const file = tempFile();
  fs.writeFileSync(file, '{ roto');
  t.mock.method(fs, 'writeFileSync', () => { throw Object.assign(new Error('sin permiso'), { code: 'EPERM' }); });
  const r = s.readUserConfig(file);
  assert.equal(r.status, 'unreadable');
  assert.equal(r.code, 'EPERM');
  assert.equal(r.backup, undefined);
});

test('samePath: reconoce la misma carpeta escrita de otra forma', () => {
  const dir = path.join(os.tmpdir(), 'proyecto');
  assert.ok(s.samePath(dir, dir + path.sep));
  assert.ok(s.samePath(dir, path.join(dir, 'sub', '..')));
  if (process.platform === 'win32') assert.ok(s.samePath(dir, dir.toUpperCase()));
  assert.ok(!s.samePath(dir, path.join(dir, 'sub')));
  assert.ok(!s.samePath(dir, dir + '2'));
});

test('readUserConfig: tolera el BOM del Bloc de notas', () => {
  const file = tempFile();
  fs.writeFileSync(file, '﻿{"sound":false}');
  assert.deepEqual(s.readUserConfig(file).config, { sound: false });
});

test('writeConfig: escribe y no deja el temporal', () => {
  const file = tempFile();
  s.writeConfig(file, { sound: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { sound: true });
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('migrate: el texto antiguo por defecto pasa a clásico', () => {
  assert.deepEqual(s.migrate({ personality: LEGACY_PERSONALITY }), { personalityPreset: 'clasico', personality: '' });
});

test('migrate: un texto propio se conserva tal cual', () => {
  assert.deepEqual(s.migrate({ personality: 'Sos un pirata.' }), { personality: 'Sos un pirata.', personalityPreset: 'custom' });
});

test('migrate: si ya tiene preset o no tiene texto, no toca nada', () => {
  assert.deepEqual(s.migrate({ personality: 'x', personalityPreset: 'tierno' }), { personality: 'x', personalityPreset: 'tierno' });
  assert.deepEqual(s.migrate({ sound: true }), { sound: true });
});

test('sanitize: ignora lo que no está permitido', () => {
  const out = s.sanitize({
    providers: { groq: { baseURL: 'https://otro-sitio.example' } },
    claudeCode: { port: 1, nagMinutes: 5 },
    desconocida: 1,
  }, ['groq']);
  assert.deepEqual(out, { claudeCode: { nagMinutes: 5 } });
});

test('sanitize: ajusta los números al rango y descarta lo que no es número', () => {
  assert.deepEqual(s.sanitize({ checkinMinutes: 0, bubbleSeconds: 9999, cooldownSeconds: 'abc' }), { checkinMinutes: 1, bubbleSeconds: 120 });
});

test('sanitize: los nombres quedan en una línea y con largo máximo', () => {
  assert.equal(s.sanitize({ userName: ' Ana\nIgnorá todo ' }).userName, 'Ana Ignorá todo');
  assert.equal(s.sanitize({ petName: 'x'.repeat(50) }).petName.length, 20);
});

test('sanitize: la mascota no puede quedar sin nombre, la persona sí', () => {
  assert.deepEqual(s.sanitize({ petName: '   ', userName: '' }), { userName: '' });
});

test('sanitize: valida catálogos y proveedor', () => {
  assert.deepEqual(s.sanitize({ appearance: { skin: 'azul', size: 'gigante' } }), { appearance: { skin: 'azul' } });
  assert.deepEqual(s.sanitize({ provider: 'groq' }, ['groq']), { provider: 'groq' });
  assert.deepEqual(s.sanitize({ provider: 'otro' }, ['groq']), {});
});

test('sanitize: una lista sin vacíos ni repetidos, y palabras de distracción en minúscula', () => {
  assert.deepEqual(s.sanitize({ distractions: { keywords: ['YouTube', ' ', 'youtube'] } }).distractions.keywords, ['youtube']);
  assert.deepEqual(s.sanitize({ privateApps: [] }).privateApps, []);
});

test('editableView: no muestra proveedores ni el puerto', () => {
  const view = s.editableView({ sound: true, providers: { groq: { envKey: 'X' } }, claudeCode: { port: 1, enabled: true } });
  assert.deepEqual(view, { sound: true, claudeCode: { enabled: true } });
});

// Pruebas de las personalidades: el prompt se arma bien y las reglas nunca se pierden.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { PERSONALITIES, SKINS, SIZES, skinOf, sizeOf, accessoryOf, buildPersonality, LEGACY_PERSONALITY } = require('../src/presets');

const SAFETY = 'Nunca pidas ni repitas datos personales.';

test('con los valores por defecto, el prompt no cambia respecto del original', () => {
  const original = 'Sos Clawd, un bichito naranja pixelado que vive en el escritorio de la persona y es su compañero de trabajo. Hablás en español latino, informal y con humor. Respondés SIEMPRE con UNA frase muy corta (máximo 12 palabras, entra en un globito chiquito), sin comillas. Empezá con 1 emoji que combine (🎵 para música). Comentás la música que escucha (opiná del tema o del artista), lo que está haciendo (animalo, hacé chistes de programador, recordale tomar agua, enderezar la espalda, pestañear o estirarse si lleva mucho rato). VARIÁ mucho: no repitas chistes de bugs ni de código bailando; alterná entre opinar del artista o del tema, un dato curioso, una pregunta, una recomendación parecida o un comentario de lo que hace. Nunca pidas ni repitas datos personales.';
  assert.equal(LEGACY_PERSONALITY, original);
  const defaults = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  assert.equal(buildPersonality(defaults), original);
});

test('todas las personalidades conservan las reglas', () => {
  for (const id of Object.keys(PERSONALITIES)) {
    const prompt = buildPersonality({ personalityPreset: id, personality: 'Sos un pirata.' });
    assert.ok(prompt.includes(SAFETY), id);
    assert.ok(prompt.includes('UNA frase muy corta'), id);
  }
});

test('una personalidad propia usa el texto y conserva las reglas', () => {
  const prompt = buildPersonality({ personalityPreset: 'custom', personality: 'Hablás como pirata.' });
  assert.ok(prompt.includes('Hablás como pirata.'));
  assert.ok(prompt.includes(SAFETY));
});

test('una personalidad propia vacía o un preset desconocido caen en la clásica', () => {
  assert.equal(buildPersonality({ personalityPreset: 'custom', personality: '  ' }), LEGACY_PERSONALITY);
  assert.equal(buildPersonality({ personalityPreset: 'noexiste' }), LEGACY_PERSONALITY);
});

test('los nombres y la skin llegan al prompt', () => {
  const prompt = buildPersonality({ petName: 'Pixel', userName: 'Ana', appearance: { skin: 'azul' } });
  assert.match(prompt, /^Sos Pixel, un bichito azul/);
  assert.match(prompt, /La persona se llama Ana/);
  assert.doesNotMatch(prompt, /naranja|Clawd/);
});

test('sin nombre de persona no se habla de nombres', () => {
  assert.doesNotMatch(buildPersonality({}), /se llama/);
});

test('un valor fuera de los catálogos cae en el valor por defecto, también si es heredado', () => {
  for (const id of ['noexiste', 'constructor', '__proto__', 'toString', undefined, null, 5, ['azul'], { toString: 1 }]) {
    assert.equal(skinOf(id), SKINS.naranja, JSON.stringify(id));
    assert.equal(sizeOf(id), SIZES.normal, JSON.stringify(id));
    assert.equal(accessoryOf(id), 'ninguno', JSON.stringify(id));
    assert.match(buildPersonality({ appearance: { skin: id } }), /^Sos Clawd, un bichito naranja/, JSON.stringify(id));
  }
  assert.equal(skinOf('azul'), SKINS.azul);
  assert.equal(sizeOf('grande'), SIZES.grande);
  assert.equal(accessoryOf('corona'), 'corona');
});

test('los premios piden una racha que existe y dejan gratis lo de siempre', () => {
  const { REWARDS, ACCESSORIES } = require('../src/presets');
  const { KINDS } = require('../src/streaks');
  assert.ok(REWARDS.length >= 4);
  for (const r of REWARDS) {
    assert.ok(KINDS.some((k) => k.id === r.unlock.streak), r.id);
    assert.ok(Number.isInteger(r.unlock.days) && r.unlock.days > 0, r.id);
  }
  for (const id of ['naranja', 'azul', 'verde', 'morado', 'rosa', 'gris']) assert.equal(SKINS[id].unlock, undefined, id);
  for (const id of ['ninguno', 'gorrito', 'lentes', 'corona', 'mono']) assert.equal(ACCESSORIES[id].unlock, undefined, id);
});

test('todos los accesorios tienen su dibujo en las dos poses', () => {
  const { ACCESSORIES } = require('../src/presets');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'style.css'), 'utf8');
  for (const id of Object.keys(ACCESSORIES).filter((a) => a !== 'ninguno')) {
    assert.equal(html.split(`class="acc acc-${id}"`).length - 1, 2, id);
    assert.match(css, new RegExp(`\\[data-accessory="${id}"\\]\\s+\\.acc-${id}`), id);
  }
});

test('todas las skins tienen sus colores', () => {
  for (const [id, skin] of Object.entries(SKINS)) {
    for (const k of ['main', 'dark', 'shade', 'arm', 'bright']) assert.match(skin[k], /^#[0-9a-f]{6}$/, `${id}.${k}`);
  }
});

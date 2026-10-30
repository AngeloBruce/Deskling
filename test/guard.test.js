const test = require('node:test');
const assert = require('node:assert');
const { scan, luhn } = require('../src/guard');

test('código de verificación se tacha', () => {
  const r = scan('Tu código de verificación es 482913');
  assert.ok(r.sensitive);
  assert.ok(!r.clean.includes('482913'));
});

test('OTP en inglés', () => {
  const r = scan('Your verification code is 123-456');
  assert.ok(r.sensitive);
  assert.ok(!r.clean.includes('123-456'));
});

test('contraseña sin acento se detecta', () => {
  assert.ok(scan('Cambiar contrasena - Google').sensitive);
  assert.ok(scan('Restablecer tu Contraseña').sensitive);
});

test('tarjeta válida se tacha, inválida no', () => {
  assert.ok(luhn('4111111111111111'));
  const ok = scan('pagá con 4111 1111 1111 1111');
  assert.ok(ok.reasons.includes('tarjeta'));
  assert.ok(!ok.clean.includes('4111'));
  const bad = scan('pedido 1234 5678 9012 3456');
  assert.ok(!bad.reasons.includes('tarjeta'));
});

test('API keys se tachan', () => {
  for (const k of ['gsk_abcdefghijklmnop1234', 'nvapi-abcdefghijklmnopqrst', 'ghp_abcdefghijklmnopqrstuvwx', 'sk-ant-api03-abcdefghijklmnop']) {
    const r = scan(`mi key ${k} ok`);
    assert.ok(r.sensitive, k);
    assert.ok(!r.clean.includes(k), k);
  }
});

test('email y teléfono se ocultan', () => {
  const r = scan('escribime a juan@mail.com o al +54 11 5555-1234');
  assert.ok(!r.clean.includes('juan@mail.com'));
  assert.ok(!r.clean.includes('5555-1234'));
});

test('texto normal pasa intacto', () => {
  for (const t of ['main.py - VS Code', 'Bad Bunny - Monaco', 'Juan: ¿vamos al cine a las 2030?', 'YouTube - Google Chrome', 'Spinning up the opinion engine']) {
    const r = scan(t);
    assert.strictEqual(r.sensitive, false, t);
    assert.strictEqual(r.clean, t, t);
  }
});

test('números sin palabra clave no se tachan', () => {
  assert.strictEqual(scan('Pedido 482913 enviado').clean, 'Pedido 482913 enviado');
});

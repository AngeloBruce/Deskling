// Pruebas del cerebro sin internet: fetch falso que devuelve una respuesta fija.
const test = require('node:test');
const assert = require('node:assert');
const { Brain } = require('../src/brain');

function brainSaying(reply, opts = {}) {
  const b = new Brain({ baseURL: 'http://falso', apiKey: 'x', model: 'm', personality: 'Sos Clawd.', ...opts });
  const sent = [];
  global.fetch = async (_url, req) => {
    sent.push(JSON.parse(req.body));
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: reply } }] }) };
  };
  return { b, sent };
}

test('avoidEmojis: los cambia por ✨ y se lo pide al modelo', async () => {
  const { b, sent } = brainSaying('Suena divino 🍕 y 👨‍🍳', { avoidEmojis: ['🍕', '👨‍🍳'] });
  assert.equal(await b.comment('hola'), 'Suena divino ✨ y ✨');
  assert.match(sent[0].messages[0].content, /No uses nunca estos emojis: 🍕 👨‍🍳/);
});

test('sin avoidEmojis no toca nada', async () => {
  const { b, sent } = brainSaying('Suena divino 🍕');
  assert.equal(await b.comment('hola'), 'Suena divino 🍕');
  assert.equal(sent[0].messages[0].content, 'Sos Clawd.');
});

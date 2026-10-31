#!/usr/bin/env node
// =============================================================================
// clawd-hook.js — Hook de Claude Code → Clawd.
//
// Claude Code lo ejecuta en los eventos "Stop" (terminó de responder) y
// "Notification" (necesita permiso o está esperando que escribas). Claude Code
// le pasa por stdin un JSON con info del evento; nosotros se lo reenviamos a
// Clawd, que escucha en http://127.0.0.1:<puerto>/claude (ver src/main.js).
//
// Reglas importantes de un hook:
//   - Tiene que ser RÁPIDO y NUNCA trabar a Claude: si Clawd está cerrado o
//     tarda, nos rendimos al segundo y salimos igual.
//   - No imprime nada (la salida de un hook la puede leer Claude Code).
//   - Siempre sale con código 0 (un error acá no debe frenar a Claude).
// =============================================================================
const http = require('http');

const PORT = Number(process.env.CLAWD_PORT) || 47823;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', send);
setTimeout(() => process.exit(0), 1500); // cinturón de seguridad: nunca más de 1.5 s

function send() {
  let evt = {};
  try { evt = JSON.parse(input); } catch {}
  // Solo mandamos lo necesario: qué pasó, el mensaje y en qué carpeta.
  const body = JSON.stringify({
    event: evt.hook_event_name || process.argv[2] || 'Stop',
    message: evt.message || '',
    cwd: evt.cwd || '',
  });
  const req = http.request({
    host: '127.0.0.1', port: PORT, path: '/claude', method: 'POST', timeout: 1000,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, (res) => { res.resume(); res.on('end', () => process.exit(0)); });
  req.on('error', () => process.exit(0));   // Clawd cerrado → no pasa nada
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.end(body);
}

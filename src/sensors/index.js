// =============================================================================
// sensors/index.js — Puente entre Node y los scripts de PowerShell.
//
// ¿Por qué PowerShell? Las APIs de Windows para leer notificaciones, la música
// y la ventana activa son fáciles de usar desde PowerShell y así no hace falta
// compilar módulos nativos de Node.
//
//   startSensors() → arranca win-sensors.ps1 (queda corriendo) y emite eventos:
//       'window'       { process, title }               cambió la ventana activa
//       'media'        { artist, title, playing, source } cambió la música
//       'notification' { app, title, body }               llegó una notificación
//       'status'       { notifications: 'Allowed' | … }  permiso de notificaciones
//       'error'        { message }
//   startMediaControl() → play/pausa, siguiente y anterior (media-control.ps1).
//   ocr(ruta)      → corre ocr.ps1 sobre una imagen y devuelve el texto (o null).
// =============================================================================
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');
const readline = require('readline');

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'];

function startSensors() {
  const events = new EventEmitter();
  let child = null;
  let stopped = false;

  // Arranca el script. Cada línea que imprime es un JSON = un evento.
  // Si el script se cae, lo reiniciamos a los 3 segundos.
  const start = () => {
    child = spawn('powershell.exe', [...PS_ARGS, path.join(__dirname, 'win-sensors.ps1')], { windowsHide: true });
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        const evt = JSON.parse(line);
        events.emit(evt.type, evt);
      } catch { /* línea que no es JSON: ignorar */ }
    });
    child.stderr.on('data', (d) => events.emit('error', { message: d.toString() }));
    child.on('exit', () => { if (!stopped) setTimeout(start, 3000); });
  };
  start();

  events.stop = () => { stopped = true; child?.kill(); };
  return events;
}

/**
 * Control de la música: deja abierto media-control.ps1 y le manda órdenes.
 *   const media = startMediaControl();
 *   media.send('toggle' | 'next' | 'prev');
 *   media.on('result', ({ cmd, ok }) => …)
 * Queda abierto para que responda al toque (abrir PowerShell tarda ~1 s).
 */
function startMediaControl() {
  const events = new EventEmitter();
  let child = null;
  let stopped = false;
  const start = () => {
    child = spawn('powershell.exe', [...PS_ARGS, path.join(__dirname, 'media-control.ps1')], { windowsHide: true });
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      try { events.emit('result', JSON.parse(line)); } catch { /* ignorar */ }
    });
    child.stderr.on('data', (d) => events.emit('error', { message: d.toString() }));
    child.on('exit', () => { if (!stopped) setTimeout(start, 3000); });
  };
  start();
  events.send = (cmd) => { if (child?.stdin.writable) child.stdin.write(cmd + '\n'); };
  events.stop = () => { stopped = true; child?.kill(); };
  return events;
}

function ocr(pngPath) {
  return new Promise((resolve) => {
    execFile('powershell.exe', [...PS_ARGS, path.join(__dirname, 'ocr.ps1'), pngPath],
      { windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout));
  });
}

module.exports = { startSensors, startMediaControl, ocr };

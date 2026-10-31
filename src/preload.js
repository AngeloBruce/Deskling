// =============================================================================
// preload.js — Puente seguro entre la ventana (renderer) y el proceso principal.
// La ventana no tiene acceso a Node; solo puede usar estas funciones.
// =============================================================================
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clawd', {
  // main → ventana: mostrar un globito de texto
  onSay: (cb) => ipcRenderer.on('say', (_e, msg) => cb(msg)),
  // main → ventana: cambiar la animación (idle, thinking, talking, excited, sleeping)
  onMood: (cb) => ipcRenderer.on('mood', (_e, mood) => cb(mood)),
  // ventana → main: abrir el menú (clic derecho sobre Clawd)
  openMenu: () => ipcRenderer.send('menu'),
  // main → ventana: abrir/cerrar el menú propio (con el estado: pausado, captura)
  onMenuOpen: (cb) => ipcRenderer.on('menu-open', (_e, st) => cb(st)),
  onMenuClose: (cb) => ipcRenderer.on('menu-close', () => cb()),
  // ventana → main: eligió una opción del menú ('pause', 'capture', 'poke', 'guardlog', 'config', 'quit')
  menuAction: (name) => ipcRenderer.send('menu-action', name),
  // ventana → main: rueda del mouse sobre Clawd (1 = siguiente canción, -1 = anterior)
  musicWheel: (dir) => ipcRenderer.send('music-wheel', dir),
  // main → ventana: cambió la fase del modo foco { phase: 'work'|'break'|'longBreak'|'off', endsAt }
  onFocus: (cb) => ipcRenderer.on('focus', (_e, info) => cb(info)),
  // ventana → main: true = el mouse está sobre algo clickeable (Clawd, globito, menú);
  // false = dejá pasar los clics a la app de abajo
  setMouseCapture: (on) => ipcRenderer.send('mouse-capture', on),
  // main → ventana: la app se va a cerrar, toca despedirse
  onGoodbye: (cb) => ipcRenderer.on('goodbye', () => cb()),
  // ventana → main: "hablá ahora" (doble clic sobre Clawd)
  poke: () => ipcRenderer.send('poke'),
  // ventana → main: arrastrar la ventana (start = agarró, move = cuánto se movió el mouse)
  dragStart: () => ipcRenderer.send('drag-start'),
  dragMove: (dx, dy) => ipcRenderer.send('drag-move', dx, dy),
  dragEnd: () => ipcRenderer.send('drag-end'),
  // main → ventana: de qué lado está Clawd ('left' o 'right'), para acomodar el globito
  onSide: (cb) => ipcRenderer.on('side', (_e, side) => cb(side)),
  // main → ventana: ¿está sonando Spotify? (para que baile de vez en cuando)
  onMusic: (cb) => ipcRenderer.on('music', (_e, info) => cb(info)),
});

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
  // ventana → main: "hablá ahora" (doble clic sobre Clawd)
  poke: () => ipcRenderer.send('poke'),
});

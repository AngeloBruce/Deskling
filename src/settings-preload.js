// =============================================================================
// settings-preload.js — Puente de la ventana de ajustes. Es aparte del de Clawd
// para que esta ventana solo pueda hacer lo suyo: leer y guardar ajustes.
// =============================================================================
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ajustes', {
  // pide los valores actuales y los catálogos (personalidades, skins, tamaños…)
  get: () => ipcRenderer.invoke('settings-get'),
  // prueba una apariencia sobre Clawd sin guardarla
  preview: (look) => ipcRenderer.send('settings-preview', look),
  // guarda solo lo que cambió; main lo valida y devuelve los valores limpios
  save: (patch) => ipcRenderer.invoke('settings-save', patch),
  openJson: () => ipcRenderer.send('settings-open-json'),
  close: () => ipcRenderer.send('settings-close'),
});

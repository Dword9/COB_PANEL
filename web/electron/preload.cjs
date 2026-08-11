/**
 * Preload: exposes a tiny, safe API to the renderer (UI + splash screen).
 * contextIsolation is on, nodeIntegration is off.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('luminaDesktop', {
  isDesktop: true,
  platform: process.platform,
  version: process.versions.electron,

  /** Ping the Python backend (http://localhost:8000 by default). */
  pingBackend: () => ipcRenderer.invoke('backend:ping'),
  /** Ask Windows Task Scheduler to start the LuminaDMX server task. */
  startBackend: () => ipcRenderer.invoke('backend:start'),
  /** URL the shell will load once the backend is up. */
  backendUrl: () => ipcRenderer.invoke('backend:url'),
  /** Toggle kiosk-style fullscreen (same as F11). */
  toggleFullscreen: () => ipcRenderer.invoke('window:toggle-fullscreen'),
  /** Open a localhost URL in the system browser. */
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),

  /** Реактивные проекции: дисплеи проекторов и управление окнами /visual. */
  visualDisplays: () => ipcRenderer.invoke('visual:displays'),
  visualSetDisplays: (keys) => ipcRenderer.invoke('visual:set-displays', keys),
  visualOpen: (mode) => ipcRenderer.invoke('visual:open', { mode }),
  visualClose: () => ipcRenderer.invoke('visual:close'),
});

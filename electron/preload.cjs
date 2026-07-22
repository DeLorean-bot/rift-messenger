const { contextBridge, ipcRenderer } = require('electron');

// Safe bridge exposed to the React app as window.riftDesktop.
contextBridge.exposeInMainWorld('riftDesktop', {
  isElectron: true,
  platform: process.platform,

  // Screen-share source picker (Discord-style, backed by desktopCapturer).
  getDesktopSources: (options) => ipcRenderer.invoke('desktop:get-sources', options),

  // rift:// deep links delivered from the main process.
  onDeepLink: (callback) => {
    const handler = (_event, url) => callback(url);
    ipcRenderer.on('rift:deep-link', handler);
    return () => ipcRenderer.removeListener('rift:deep-link', handler);
  },

  // Mandatory updater events (wired to electron-updater in the main process).
  updater: {
    onEvent: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on('rift:updater', handler);
      return () => ipcRenderer.removeListener('rift:updater', handler);
    },
    quitAndInstall: () => ipcRenderer.invoke('rift:updater-quit-and-install'),
    check: () => ipcRenderer.invoke('rift:updater-check'),
  },
});

const { app, BrowserWindow, ipcMain, desktopCapturer, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('node:path');

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
const isDev = !app.isPackaged;

/** @type {BrowserWindow | null} */
let mainWindow = null;
let pendingDeepLink = null;

function emitDeepLink(url) {
  if (!url || !url.startsWith('rift://')) return;
  if (mainWindow) {
    mainWindow.webContents.send('rift:deep-link', url);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  } else {
    pendingDeepLink = url;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 820,
    minHeight: 560,
    center: true,
    backgroundColor: '#0d1015',
    title: 'RIFT — связь без центра',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  if (isDev) {
    mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // Open external links in the system browser, keep rift:// internal.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingDeepLink) {
      emitDeepLink(pendingDeepLink);
      pendingDeepLink = null;
    }
    if (!isDev) startMandatoryUpdate();
  });
}

// Blocking mandatory updater backed by electron-updater (GitHub releases).
let updaterStarted = false;
function sendUpdater(status, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('rift:updater', { status, ...(data || {}) });
  }
}
function startMandatoryUpdate() {
  if (updaterStarted) return;
  updaterStarted = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('checking-for-update', () => sendUpdater('checking'));
  autoUpdater.on('update-available', (info) => sendUpdater('downloading', { version: info.version, percent: 0 }));
  autoUpdater.on('update-not-available', () => sendUpdater('idle'));
  autoUpdater.on('error', (err) => sendUpdater('error', { message: String((err && err.message) || err) }));
  autoUpdater.on('download-progress', (p) => sendUpdater('downloading', { percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => {
    sendUpdater('installing', { version: info.version });
    // Mandatory: install immediately once downloaded.
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 400);
  });
  autoUpdater.checkForUpdates().catch((err) => sendUpdater('error', { message: String(err) }));
}

// Single instance so rift:// links reach the running window instead of a new one.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const link = argv.find((arg) => arg.startsWith('rift://'));
    if (link) emitDeepLink(link);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('rift', process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient('rift');
  }

  app.whenReady().then(() => {
    // Deep link passed on first launch (Windows puts it in argv).
    const initialLink = process.argv.find((arg) => arg.startsWith('rift://'));
    if (initialLink) pendingDeepLink = initialLink;

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // macOS deep links.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    emitDeepLink(url);
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Discord-style screen-share picker: enumerate windows/screens with thumbnails.
ipcMain.handle('rift:updater-check', () => (isDev ? Promise.resolve(null) : autoUpdater.checkForUpdates()));
ipcMain.handle('rift:updater-quit-and-install', () => {
  autoUpdater.quitAndInstall(true, true);
});

ipcMain.handle('desktop:get-sources', async (_event, options) => {
  const sources = await desktopCapturer.getSources({
    types: options?.types || ['screen', 'window'],
    thumbnailSize: options?.thumbnailSize || { width: 320, height: 180 },
    fetchWindowIcons: true,
  });
  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    thumbnail: source.thumbnail.toDataURL(),
    appIcon: source.appIcon ? source.appIcon.toDataURL() : null,
    isScreen: source.id.startsWith('screen:'),
  }));
});

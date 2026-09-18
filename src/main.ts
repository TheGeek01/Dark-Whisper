import './appIdentity';
import { app, BrowserWindow, clipboard, globalShortcut, Menu, Tray, ipcMain, Notification, shell } from 'electron';
import path from 'path';
import * as fs from 'fs';
import registerShortcuts from './services/hotkeyService';
import { setApiConfig, BUILTIN_TIMEOUT_MS, EXTERNAL_TIMEOUT_MS } from './services/apiService';
import { DEFAULT_VAULT_PATH, getSettings, saveSettings } from './services/settingsService';
import { cleanupStaleServer, modelManager, openServerLog, startBuiltinServer, whisperServer } from './services/whisperRuntime';
import { toStatusView } from './services/serverGate';
import type { DownloadProgress } from './services/modelManager';
import {
  captureDevices,
  isSessionActive,
  onSessionBlock,
  onSessionSegment,
  onSessionStatus,
  openVault,
  pauseSession,
  resumeSession,
  revealDocument,
  SessionStatusView,
  sessionStatus,
  startSession,
  stopSession,
  toggleQuickNote,
} from './services/sessionRuntime';
import { onAudioLevel } from './services/streamRuntime';
import { parseStartRequest } from './services/quickNotes';
import { titleBarOverlay, windowBackground } from './services/windowTheme';
import { onLibraryChanged, registerLibraryIpc, stopWatching, watchVault } from './services/libraryRuntime';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let currentShortcut = 'Ctrl+Q';

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to run a second instance, show the existing window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

const openExternalLink = (url: string) => {
  if (/^https?:\/\//i.test(url)) {
    void shell.openExternal(url);
  }
};

const createWindow = () => {
  const theme = getSettings().theme;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: windowBackground(theme),
    // The page draws its own header; Windows keeps drawing the caption buttons over it.
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(theme),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../public/index.html'));

  // Documents can contain links: never navigate the app window; open web links in the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalLink(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    openExternalLink(url);
  });

  // Hide instead of close on window close
  mainWindow.on('close', (event) => {
    event.preventDefault();
    mainWindow?.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Always start in background (hidden in tray)
  // User can show window via tray menu "Show/Hide" option
};

const showSystemNotification = (title: string, body: string, autoCloseMs?: number) => {
  const notification = new Notification({
    title: title,
    body: body,
    timeoutType: 'never',
    silent: true,
  });
  notification.show();

  if (autoCloseMs !== undefined) {
    setTimeout(() => {
      notification.close();
    }, autoCloseMs);
  }

  return notification;
};

const showModelsWindow = () => {
  mainWindow?.show();
  mainWindow?.webContents.send('open-models');
};

const currentStatusView = () => {
  const settings = getSettings();
  return toStatusView(settings.serverMode, whisperServer.getStatus(), settings.apiUrl);
};

const applyApiConfig = () => {
  const settings = getSettings();
  if (settings.serverMode === 'builtin') {
    // Port 1 is never listening, so requests fail fast until the server reports ready.
    setApiConfig(whisperServer.getBaseUrl() ?? 'http://127.0.0.1:1', '', { timeoutMs: BUILTIN_TIMEOUT_MS });
  } else {
    setApiConfig(settings.apiUrl, settings.apiToken, { timeoutMs: EXTERNAL_TIMEOUT_MS });
  }
};

const RUN_TRAY_STATES: Partial<Record<SessionStatusView['state'], string>> = {
  starting: 'starting',
  recording: 'recording',
  paused: 'paused',
  error: 'error',
};

// The tray reports the active mode: a running session or quick note wins over the server status.
const updateTrayTooltip = () => {
  const status = isSessionActive() ? sessionStatus() : null;
  const state = status ? RUN_TRAY_STATES[status.state] : undefined;
  const label = status && state ? `${status.kind === 'quick-note' ? 'Quick note' : 'Session'} ${state}` : currentStatusView().text;
  tray?.setToolTip(`Dark-Whisper — ${label}`);
};

const handleServerStatus = () => {
  applyApiConfig();
  const view = currentStatusView();
  mainWindow?.webContents.send('server-status', view);
  updateTrayTooltip();
};

// The shortcut, the tray and the header button all toggle a quick note (spec §3.4). A refusal
// (a session is recording) is shown in the window, and as a notification when it is hidden.
const handleQuickNoteToggle = async () => {
  try {
    await toggleQuickNote();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    mainWindow?.webContents.send('error', { message });
    if (!mainWindow?.isVisible()) showSystemNotification('Dark-Whisper', message, 4000);
  }
};

const registerQuickNoteShortcut = (shortcut: string) => {
  globalShortcut.unregisterAll();
  registerShortcuts(() => void handleQuickNoteToggle(), shortcut);
};

const runDownload = (requestedId: string, start: () => Promise<DownloadProgress>) => {
  start()
    .then(async (result) => {
      if (result.state === 'done' && !getSettings().modelId) {
        saveSettings({ modelId: result.id });
        await startBuiltinServer();
      }
    })
    .catch((error: unknown) => {
      const progress: DownloadProgress = {
        id: requestedId,
        receivedBytes: 0,
        totalBytes: null,
        bytesPerSec: 0,
        state: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
      mainWindow?.webContents.send('download-progress', progress);
    });
};

const buildTrayMenu = () =>
  Menu.buildFromTemplate([
    {
      label: 'Show/Hide',
      click: () => {
        if (mainWindow?.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow?.show();
        }
      },
    },
    {
      label: `Quick note (${currentShortcut})`,
      click: () => void handleQuickNoteToggle(),
    },
    {
      label: 'Models…',
      click: showModelsWindow,
    },
    { type: 'separator' },
    {
      label: 'Exit',
      click: () => {
        app.quit();
      },
    },
  ]);

const createTray = () => {
  try {
    // Load custom icon - use app.getAppPath() for correct path in packaged app
    const iconPath = path.join(app.getAppPath(), 'assets/whisper.ico');
    if (!fs.existsSync(iconPath)) {
      throw new Error(`Icon file not found at ${iconPath}`);
    }
    tray = new Tray(iconPath);
  } catch (error) {
    console.error('Error creating tray:', error);
    // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
    const { nativeImage } = require('electron');
    const image = nativeImage.createEmpty();
    tray = new Tray(image);
  }

  tray.setContextMenu(buildTrayMenu());
  tray.setToolTip('Dark-Whisper');
};

app.on('ready', () => {
  if (!gotTheLock) return;
  const settings = getSettings();
  currentShortcut = settings.shortcut;

  // Enable auto-start on Windows startup (minimized to tray). Dev and smoke launches are never
  // packaged, so this never registers a login item outside a real install.
  if (process.platform === 'win32' && app.isPackaged) {
    app.setLoginItemSettings({
      openAtLogin: true,
      path: app.getPath('exe'),
      args: ['--hidden'],
    });
  }

  createWindow();
  createTray();
  registerQuickNoteShortcut(settings.shortcut);

  whisperServer.onStatus(handleServerStatus);
  onSessionStatus((view) => {
    mainWindow?.webContents.send('session-status', view);
    updateTrayTooltip();
  });
  onSessionSegment((segment) => mainWindow?.webContents.send('session-segment', segment));
  onSessionBlock((event) => mainWindow?.webContents.send('session-block', event));
  onAudioLevel((level) => mainWindow?.webContents.send('session-level', level));
  // A fresh install has no vault yet; only ever auto-create the default one, never a custom
  // path the user chose (a missing custom vault keeps showing "Vault not found").
  if (settings.vaultPath === DEFAULT_VAULT_PATH) {
    fs.mkdirSync(DEFAULT_VAULT_PATH, { recursive: true });
  }
  watchVault();
  onLibraryChanged((change) => mainWindow?.webContents.send('library-changed', change));
  modelManager.onProgress((progress) => mainWindow?.webContents.send('download-progress', progress));
  handleServerStatus();

  (async () => {
    await cleanupStaleServer();
    await modelManager.init();
    await startBuiltinServer();
    if (getSettings().serverMode === 'builtin' && whisperServer.getStatus().state === 'no-model') {
      const notification = showSystemNotification('Dark-Whisper', 'Choose a speech model to finish setup', 8000);
      notification.on('click', showModelsWindow);
    }
  })().catch((error) => console.error('Failed to start transcription server:', error));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on('before-quit', () => {
  if (mainWindow) {
    mainWindow.removeAllListeners('close');
  }
  if (isSessionActive()) {
    void stopSession();
  }
  globalShortcut.unregisterAll();
  modelManager.cancelDownload();
  whisperServer.stop();
  stopWatching();
});

ipcMain.handle('get-settings', () => {
  return getSettings();
});

ipcMain.handle('save-settings', async (_event, settings: any) => {
  const before = getSettings();
  if (typeof settings?.vaultPath === 'string' && settings.vaultPath !== before.vaultPath && isSessionActive()) {
    throw new Error('Stop recording before changing the vault.');
  }
  saveSettings(settings);
  const after = getSettings();

  if (before.theme !== after.theme && mainWindow) {
    mainWindow.setTitleBarOverlay(titleBarOverlay(after.theme));
    mainWindow.setBackgroundColor(windowBackground(after.theme));
  }

  if (before.vaultPath !== after.vaultPath) {
    watchVault();
    mainWindow?.webContents.send('library-changed', { paths: [] });
  }

  if (before.forceCpu && !after.forceCpu) {
    saveSettings({ gpuFallbackVersion: null });
  }
  if (before.serverMode !== after.serverMode || before.forceCpu !== after.forceCpu || before.refineVad !== after.refineVad) {
    await startBuiltinServer();
  }
  handleServerStatus();

  if (after.shortcut !== before.shortcut) {
    currentShortcut = after.shortcut;
    registerQuickNoteShortcut(after.shortcut);
    tray?.setContextMenu(buildTrayMenu());
  }

  return { success: true };
});

ipcMain.handle('get-server-status', () => currentStatusView());

ipcMain.handle('restart-server', async () => {
  await startBuiltinServer();
});

ipcMain.handle('open-server-log', async () => {
  await openServerLog();
});

ipcMain.handle('list-models', async () => ({
  models: modelManager.listModels(),
  activeModelId: getSettings().modelId,
  downloading: modelManager.isDownloading(),
  disk: await modelManager.getDiskInfo(),
}));

ipcMain.handle('download-model', (_event, id: string) => {
  runDownload(id, () => modelManager.startDownload(id));
});

ipcMain.handle('download-custom-model', (_event, url: string) => {
  runDownload('custom', () => modelManager.startCustomDownload(url));
});

ipcMain.handle('cancel-download', () => {
  modelManager.cancelDownload();
});

ipcMain.handle('delete-model', async (_event, id: string) => {
  if (!modelManager.isValidId(id)) {
    throw new Error('Unknown model');
  }
  if (getSettings().modelId === id) {
    whisperServer.setNoModel();
    saveSettings({ modelId: null });
  }
  await modelManager.deleteModel(id);
});

ipcMain.handle('select-model', async (_event, id: string) => {
  if (!modelManager.getModelPath(id)) {
    throw new Error('Model is not installed');
  }
  saveSettings({ modelId: id });
  await startBuiltinServer();
});

ipcMain.handle('session-start', (_event, request?: unknown) => startSession(parseStartRequest(request)));
ipcMain.handle('quick-note-toggle', () => toggleQuickNote());
ipcMain.handle('session-pause', () => pauseSession());
ipcMain.handle('session-resume', () => resumeSession());
ipcMain.handle('session-stop', () => stopSession());
ipcMain.handle('session-status', () => sessionStatus());
ipcMain.handle('list-capture-devices', () => captureDevices());
ipcMain.handle('open-vault', () => openVault());
ipcMain.handle('reveal-document', () => revealDocument());

registerLibraryIpc(() => mainWindow);

ipcMain.handle('copy-text', async (_event, text: unknown) => {
  if (typeof text !== 'string') throw new Error('text must be text');
  await clipboard.writeText(text);
});

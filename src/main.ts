import './appIdentity';
import { app, BrowserWindow, clipboard, Menu, Tray, ipcMain, Notification, shell } from 'electron';
import path from 'path';
import * as fs from 'fs';
import registerShortcuts from './services/hotkeyService';
import { recordAudio, stopRecording, cleanupOldRecordings, getAudioDevices } from './services/recordingService';
import { transcribeAudio, checkAPIHealth, setApiConfig, BUILTIN_TIMEOUT_MS, EXTERNAL_TIMEOUT_MS } from './services/apiService';
import { DEFAULT_VAULT_PATH, getSettings, saveSettings } from './services/settingsService';
import { pasteTranscriptClipboard, copyToClipboard } from './services/pasteService';
import { saveAndMuteAudio, restoreAudio } from './services/audioControlService';
import { cleanupStaleServer, modelManager, openServerLog, startBuiltinServer, whisperServer } from './services/whisperRuntime';
import { recordingGate, toStatusView } from './services/serverGate';
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
import { parseStartRequest } from './services/quickNotes';
import { onLibraryChanged, registerLibraryIpc, stopWatching, watchVault } from './services/libraryRuntime';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isRecording = false;
let currentShortcut: string = 'Ctrl+Q';
let lastTranscription: string = '';
let transcriptionNotification: Notification | null = null;

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
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#15151b',
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

  // Auto-close after specified time (default 2 seconds), or never if undefined
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

const SESSION_TRAY_LABELS: Partial<Record<SessionStatusView['state'], string>> = {
  starting: 'Session starting',
  recording: 'Session recording',
  paused: 'Session paused',
  error: 'Session error',
};

// The tray reports the active mode: a running session wins over the server status.
const updateTrayTooltip = () => {
  const sessionLabel = isSessionActive() ? SESSION_TRAY_LABELS[sessionStatus().state] : undefined;
  tray?.setToolTip(`Dark-Whisper — ${sessionLabel ?? currentStatusView().text}`);
};

const handleServerStatus = () => {
  applyApiConfig();
  const view = currentStatusView();
  mainWindow?.webContents.send('server-status', view);
  updateTrayTooltip();
};

const canStartRecording = (): boolean => {
  const gate = recordingGate(getSettings().serverMode, whisperServer.getStatus());
  if (gate.allow) return true;
  if (gate.action === 'open-models') showModelsWindow();
  showSystemNotification('Dark-Whisper', gate.message, 4000);
  return false;
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

  const contextMenu = Menu.buildFromTemplate([
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
      label: 'Models…',
      click: showModelsWindow,
    },
    {
      label: 'Recording Status',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Exit',
      click: () => {
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
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
  registerShortcuts(handleRecordingToggle, settings.shortcut);

  whisperServer.onStatus(handleServerStatus);
  onSessionStatus((view) => {
    mainWindow?.webContents.send('session-status', view);
    updateTrayTooltip();
  });
  onSessionSegment((segment) => mainWindow?.webContents.send('session-segment', segment));
  onSessionBlock((event) => mainWindow?.webContents.send('session-block', event));
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
  modelManager.cancelDownload();
  whisperServer.stop();
  stopWatching();
});

const startRecordingSession = async () => {
  const settings = getSettings();
  let audioMuted = false;

  try {
    cleanupOldRecordings(7 * 24);

    if (settings.serverMode === 'external') {
      const isAPIHealthy = await checkAPIHealth();
      if (!isAPIHealthy) {
        const errorMsg = `Whisper API is not running at ${settings.apiUrl}. Please start the API before recording.`;
        mainWindow?.webContents.send('error', { message: errorMsg });
        isRecording = false;
        return;
      }
    }

    // Mute system audio if enabled in settings
    if (settings.autoMuteAudio) {
      try {
        await saveAndMuteAudio();
        audioMuted = true;
      } catch (error) {
        console.error('Failed to mute audio:', error);
        // Continue recording even if mute fails
      }
    }

    mainWindow?.webContents.send('recording-started');
    showSystemNotification('Dark-Whisper', 'Recording...', 2000);

    const audioPath = await recordAudio(settings.micDevice || 'default');
    mainWindow?.webContents.send('recording-stopped');

    const stats = fs.statSync(audioPath);
    if (stats.size === 0) {
      const errorMsg = 'Recording produced no audio data. Please ensure your microphone is working.';
      mainWindow?.webContents.send('error', { message: errorMsg });
      return;
    }

    transcriptionNotification = showSystemNotification('Dark-Whisper', 'Transcribing...');

    const transcription = await transcribeAudio(audioPath);
    lastTranscription = transcription;

    if (transcriptionNotification) {
      transcriptionNotification.close();
      transcriptionNotification = null;
    }

    mainWindow?.webContents.send('transcription-complete', { transcription });

    await pasteTranscriptClipboard(transcription, true);

    // Delete audio file with retry (file may be briefly locked after API upload)
    const deleteWithRetry = async (path: string, retries = 3, delay = 500) => {
      for (let i = 0; i < retries; i++) {
        try {
          fs.unlinkSync(path);
          return;
        } catch (err) {
          if (i < retries - 1) {
            await new Promise(r => setTimeout(r, delay));
          }
        }
      }
    };
    deleteWithRetry(audioPath).catch(() => {
      // Silently fail - cleanup service will handle old files
    });
  } catch (error) {
    console.error('Recording/transcription error:', error);

    // Close transcription notification on error
    if (transcriptionNotification) {
      transcriptionNotification.close();
      transcriptionNotification = null;
    }

    let errorMessage: string;
    const errorStr = String(error);

    if (errorStr.includes('ECONNREFUSED') || errorStr.includes('ENOTFOUND')) {
      errorMessage = settings.serverMode === 'builtin'
        ? 'Cannot connect to the built-in transcription server. Try Restart in the main window.'
        : `Cannot connect to Whisper API. Make sure it's running at ${settings.apiUrl}`;
    } else if (errorStr.includes('ENOENT') || errorStr.includes('not found')) {
      errorMessage = 'Audio file was not created. Check microphone connection.';
    } else if (errorStr.includes('Invalid response')) {
      errorMessage = 'API returned an unexpected response. Check your Whisper API version.';
    } else if (errorStr.includes('timeout')) {
      errorMessage = 'Request timed out. The API might be overloaded or unresponsive.';
    } else {
      errorMessage = `Error: ${errorStr.split('\n')[0].substring(0, 100)}`;
    }

    mainWindow?.webContents.send('error', { message: errorMessage });
  } finally {
    // Restore audio if it was muted
    if (audioMuted) {
      try {
        await restoreAudio();
      } catch (error) {
        console.error('Failed to restore audio:', error);
      }
    }
    isRecording = false;
  }
};

const handleRecordingToggle = async () => {
  if (isSessionActive()) {
    const paused = sessionStatus().state === 'paused';
    await (paused ? resumeSession() : pauseSession());
    return;
  }
  if (isRecording) {
    await stopRecording();
  } else if (canStartRecording()) {
    isRecording = true;
    void startRecordingSession();
  }
};

ipcMain.handle('get-status', () => {
  return { isRecording };
});

ipcMain.handle('start-recording', async () => {
  if (isSessionActive()) {
    mainWindow?.webContents.send('error', { message: 'A recording session is in progress. Stop it before using quick dictation.' });
    return;
  }

  if (isRecording) {
    mainWindow?.webContents.send('error', { message: 'Recording already in progress.' });
    return;
  }

  if (!canStartRecording()) {
    return;
  }

  isRecording = true;
  void startRecordingSession();
});

ipcMain.handle('stop-recording', async () => {
  if (!isRecording) {
    return;
  }

  await stopRecording();
});

ipcMain.handle('get-settings', () => {
  return getSettings();
});

ipcMain.handle('save-settings', async (_event, settings: any) => {
  const before = getSettings();
  if (typeof settings?.vaultPath === 'string' && settings.vaultPath !== before.vaultPath && isSessionActive()) {
    throw new Error('Stop the recording session before changing the vault.');
  }
  saveSettings(settings);
  const after = getSettings();

  if (before.vaultPath !== after.vaultPath) {
    watchVault();
    mainWindow?.webContents.send('library-changed', { paths: [] });
  }

  if (before.forceCpu && !after.forceCpu) {
    saveSettings({ gpuFallbackVersion: null });
  }
  if (before.serverMode !== after.serverMode || before.forceCpu !== after.forceCpu) {
    await startBuiltinServer();
  }
  handleServerStatus();

  if (settings.shortcut) {
    currentShortcut = settings.shortcut;
    // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
    const { globalShortcut } = require('electron');
    globalShortcut.unregisterAll();
    registerShortcuts(handleRecordingToggle, settings.shortcut);
  }

  return { success: true };
});

ipcMain.handle('copy-to-clipboard', async () => {
  if (lastTranscription) {
    await copyToClipboard(lastTranscription);
    return { success: true };
  }
  return { success: false, message: 'No transcription to copy' };
});

ipcMain.handle('get-audio-devices', async () => {
  return await getAudioDevices();
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

ipcMain.handle('session-start', async (_event, request?: unknown) => {
  if (isRecording) {
    throw new Error('Quick dictation is recording. Stop it before starting a session.');
  }
  return startSession(parseStartRequest(request));
});

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

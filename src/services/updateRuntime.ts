import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { isSessionActive } from './sessionRuntime';
import { getSettings } from './settingsService';
import { UpdateService } from './updateService';

// Releases publish latest.yml and the installer's blockmap (publish.yml), which is what
// electron-updater reads; app-update.yml in the installed app points it at the GitHub repo.
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.logger = console;

export const updates = new UpdateService({
  supported: app.isPackaged,
  currentVersion: app.getVersion(),
  check: async () => {
    await autoUpdater.checkForUpdates();
  },
  // The user asked to restart: install without the installer's pages, then start the new version.
  install: () => autoUpdater.quitAndInstall(true, true),
  isAuto: () => getSettings().autoUpdate,
  isRecording: isSessionActive,
});

autoUpdater.on('checking-for-update', () => updates.onChecking());
autoUpdater.on('update-available', (info) => updates.onAvailable(info.version));
autoUpdater.on('update-not-available', () => updates.onNotAvailable());
autoUpdater.on('download-progress', (progress) => updates.onProgress(progress.percent));
autoUpdater.on('update-downloaded', (info) => updates.onDownloaded(info.version));
autoUpdater.on('error', (error) => updates.onError(error.message));

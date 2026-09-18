import type { ServerStatusView, SettingsView } from '../shared/api.js';
import { displayShortcut } from '../shared/shortcuts.js';
import { openModels, openSettings, startModelDownload } from './dialogs.js';
import { byId } from './dom.js';
import { headerStatus, modelChipText } from './headerModel.js';
import { isSessionRunning } from './sessionModel.js';
import { getState, subscribe } from './state.js';
import { reportError, toast } from './toast.js';

const RECOMMENDED_MODEL_ID = 'ggml-large-v3-turbo-q5_0.bin';

let server: ServerStatusView | null = null;
let settings: SettingsView | null = null;

function render(): void {
  const { session, tree } = getState();
  const status = session.status;
  const running = isSessionRunning(status);
  const quick = running && status?.kind === 'quick-note';
  const noVault = tree?.exists === false;

  const line = headerStatus(server, status);
  byId('serverText').textContent = line.text;
  byId('serverDot').className = `dot ${line.tone}`;
  byId('serverStatus').title = server?.text ?? '';
  const failed = server?.mode === 'builtin' && server.state === 'error';
  byId('serverRestartBtn').hidden = !failed;
  byId('serverLogBtn').hidden = !failed;
  byId('setupBanner').hidden = !(server?.mode === 'builtin' && server.state === 'no-model');

  const quickBtn = byId<HTMLButtonElement>('quickNoteBtn');
  quickBtn.classList.toggle('active', quick);
  quickBtn.disabled = (running && !quick) || noVault;
  quickBtn.title = (quick ? 'Stop the quick note' : "Start a quick note in today's file") + keys(settings?.shortcut);
  byId('quickNoteLabel').textContent = quick ? 'Stop quick note' : 'Quick Notes';

  const record = byId<HTMLButtonElement>('recordBtn');
  record.disabled = running || noVault;
  record.classList.toggle('recording', running && !quick);
  byId('recordLabel').textContent = running && !quick ? 'Recording' : 'Record';
  const folder = getState().selectedFolder;
  record.title = `Start a session in ${folder || 'the vault root'}${keys(settings?.recordShortcut)}`;

  const paused = status?.state === 'paused';
  const pause = byId<HTMLButtonElement>('pauseBtn');
  pause.disabled = !running || status?.state === 'error' || status?.state === 'starting';
  byId('pauseLabel').textContent = paused ? 'Resume' : 'Pause';
  pause.title = (paused ? 'Resume' : 'Pause') + keys(settings?.pauseShortcut);
  byId('pauseIcon').className = `i ${paused ? 'i-play' : 'i-pause'}`;
  const stop = byId<HTMLButtonElement>('stopBtn');
  stop.disabled = !running;
  stop.title = `Stop${keys(settings?.stopShortcut)}`;

  byId('modelChipText').textContent = settings ? modelChipText(settings) : '…';
}

// " (Ctrl+Alt+P)" for a button's tooltip, or nothing when the action has no shortcut.
function keys(shortcut: string | undefined): string {
  return shortcut ? ` (${displayShortcut(shortcut)})` : '';
}

export function setSettings(value: SettingsView): void {
  settings = value;
  render();
}

function refreshSettings(): void {
  window.api.getSettings().then(setSettings, reportError);
}

export function initHeader(): void {
  window.api.onServerStatus((view) => {
    server = view;
    // A model change restarts the server: the chip follows.
    refreshSettings();
    render();
  });
  window.api.getServerStatus().then((view) => {
    server = view;
    render();
  }, reportError);
  window.api.onError(({ message }) => toast(message, 'error'));
  refreshSettings();

  byId('serverRestartBtn').addEventListener('click', () => window.api.restartServer().catch(reportError));
  byId('serverLogBtn').addEventListener('click', () => window.api.openServerLog().catch(reportError));
  byId('setupDownloadBtn').addEventListener('click', () => {
    openModels();
    startModelDownload(RECOMMENDED_MODEL_ID);
  });
  byId('quickNoteBtn').addEventListener('click', () => window.api.toggleQuickNote().catch(reportError));
  byId('recordBtn').addEventListener('click', () => {
    window.api.startSession({ kind: 'session', folder: getState().selectedFolder }).catch(reportError);
  });
  byId('pauseBtn').addEventListener('click', () => {
    const paused = getState().session.status?.state === 'paused';
    (paused ? window.api.resumeSession() : window.api.pauseSession()).catch(reportError);
  });
  byId('stopBtn').addEventListener('click', () => window.api.stopSession().catch(reportError));
  byId('modelChip').addEventListener('click', openModels);
  byId('settingsBtn').addEventListener('click', () => openSettings().catch(reportError));

  subscribe((_state, changed) => {
    if (changed.has('session') || changed.has('tree') || changed.has('selectedFolder')) render();
  });
  render();
}

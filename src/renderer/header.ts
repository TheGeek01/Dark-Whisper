import type { ServerStatusView } from '../shared/api.js';
import { openModels, openSettings, startModelDownload } from './dialogs.js';
import { byId } from './dom.js';
import { isSessionRunning } from './sessionModel.js';
import { getState, subscribe } from './state.js';
import { reportError, toast } from './toast.js';

const RECOMMENDED_MODEL_ID = 'ggml-large-v3-turbo-q5_0.bin';

// Main reports quick dictation as started → stopped → complete (or an error at any point).
type DictationState = 'idle' | 'recording' | 'transcribing';
let dictation: DictationState = 'idle';
let shortcut = 'Ctrl+Q';

function renderServer(view: ServerStatusView): void {
  byId('serverText').textContent = view.text;
  byId('serverDot').className = `dot ${view.mode === 'external' ? 'external' : view.state}`;
  const failed = view.mode === 'builtin' && view.state === 'error';
  byId('serverRestartBtn').hidden = !failed;
  byId('serverLogBtn').hidden = !failed;
  byId('setupBanner').hidden = !(view.mode === 'builtin' && view.state === 'no-model');
}

function renderControls(): void {
  const { session, tree } = getState();
  const status = session.status;
  const running = isSessionRunning(status);

  const dictate = byId<HTMLButtonElement>('dictateBtn');
  dictate.textContent = dictation === 'recording' ? '■ Stop dictation' : '🎤 Dictate';
  dictate.disabled = running || dictation === 'transcribing';
  byId('dictateState').textContent =
    dictation === 'recording' ? 'Recording…' : dictation === 'transcribing' ? 'Transcribing…' : shortcut;

  const start = byId<HTMLButtonElement>('sessionStartBtn');
  start.hidden = running;
  start.disabled = dictation !== 'idle' || tree?.exists === false;
  const pause = byId<HTMLButtonElement>('sessionPauseBtn');
  pause.hidden = !running || status?.state === 'error';
  pause.textContent = status?.state === 'paused' ? '▶ Resume' : '⏸ Pause';
  byId('sessionStopBtn').hidden = !running;
}

export function setShortcut(value: string): void {
  shortcut = value;
  renderControls();
}

export function initHeader(): void {
  window.api.onServerStatus(renderServer);
  window.api.getServerStatus().then(renderServer, reportError);
  byId('serverRestartBtn').addEventListener('click', () => window.api.restartServer().catch(reportError));
  byId('serverLogBtn').addEventListener('click', () => window.api.openServerLog().catch(reportError));
  byId('setupDownloadBtn').addEventListener('click', () => {
    openModels();
    startModelDownload(RECOMMENDED_MODEL_ID);
  });

  window.api.onRecordingStarted(() => {
    dictation = 'recording';
    renderControls();
  });
  window.api.onRecordingStopped(() => {
    dictation = 'transcribing';
    renderControls();
  });
  window.api.onTranscriptionComplete(({ transcription }) => {
    dictation = 'idle';
    const last = byId('lastText');
    last.textContent = transcription;
    last.title = transcription;
    byId<HTMLButtonElement>('copyLastBtn').disabled = false;
    renderControls();
  });
  window.api.onError(({ message }) => {
    dictation = 'idle';
    toast(message, 'error');
    renderControls();
  });
  window.api.getStatus(({ isRecording }) => {
    dictation = isRecording ? 'recording' : 'idle';
    renderControls();
  });
  window.api.getSettings().then((settings) => setShortcut(settings.shortcut), reportError);

  byId('dictateBtn').addEventListener('click', () => {
    const action = dictation === 'recording' ? window.api.stopRecording() : window.api.startRecording();
    action.catch(reportError);
  });
  byId('copyLastBtn').addEventListener('click', async () => {
    const result = await window.api.copyToClipboard();
    if (result.success) toast('Copied');
    else toast(result.message ?? 'Could not copy', 'error');
  });
  byId('sessionStartBtn').addEventListener('click', () => {
    window.api.startSession({ kind: 'session', folder: getState().selectedFolder }).catch(reportError);
  });
  byId('sessionPauseBtn').addEventListener('click', () => {
    const paused = getState().session.status?.state === 'paused';
    (paused ? window.api.resumeSession() : window.api.pauseSession()).catch(reportError);
  });
  byId('sessionStopBtn').addEventListener('click', () => window.api.stopSession().catch(reportError));
  byId('modelsBtn').addEventListener('click', openModels);
  byId('settingsBtn').addEventListener('click', () => openSettings().catch(reportError));

  subscribe((_state, changed) => {
    if (changed.has('session') || changed.has('tree')) renderControls();
  });
  renderControls();
}

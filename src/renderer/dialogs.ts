import type { DownloadProgressView, ModelEntryView, ModelListView, RefineMode, SettingsView } from '../shared/api.js';
import { byId, el } from './dom.js';
import { formatBytes } from './format.js';
import { reportError, toast } from './toast.js';

// ---- Ask / confirm: Electron does not implement window.prompt.

export interface AskOptions {
  title: string;
  message?: string;
  value?: string;
  choices?: { value: string; label: string }[];
  confirmLabel?: string;
  danger?: boolean;
}

export function ask(options: AskOptions): Promise<string | null> {
  const dialog = byId<HTMLDialogElement>('askDialog');
  const input = byId<HTMLInputElement>('askInput');
  const select = byId<HTMLSelectElement>('askSelect');
  const ok = byId<HTMLButtonElement>('askOkBtn');
  const wantsText = options.value !== undefined;
  const wantsChoice = options.choices !== undefined;

  byId('askTitle').textContent = options.title;
  byId('askMessage').textContent = options.message ?? '';
  byId('askMessage').hidden = !options.message;
  ok.textContent = options.confirmLabel ?? 'OK';
  ok.classList.toggle('danger', options.danger === true);
  input.hidden = !wantsText;
  input.value = options.value ?? '';
  select.hidden = !wantsChoice;
  select.replaceChildren(...(options.choices ?? []).map((choice) => new Option(choice.label, choice.value)));

  return new Promise((resolve) => {
    dialog.returnValue = '';
    dialog.addEventListener(
      'close',
      () => {
        if (dialog.returnValue !== 'ok') resolve(null);
        else if (wantsText) resolve(input.value);
        else if (wantsChoice) resolve(select.value);
        else resolve('ok');
      },
      { once: true },
    );
    dialog.showModal();
    if (wantsText) {
      input.focus();
      input.select();
    } else if (wantsChoice) {
      select.focus();
    } else {
      ok.focus();
    }
  });
}

export async function confirmAction(title: string, message: string, confirmLabel: string): Promise<boolean> {
  return (await ask({ title, message, confirmLabel, danger: true })) !== null;
}

// ---- Settings

let onSettingsSaved: (settings: SettingsView) => void = () => undefined;

function settingsFields() {
  return {
    shortcut: byId<HTMLInputElement>('shortcutInput'),
    micDevice: byId<HTMLSelectElement>('micDeviceInput'),
    autoMute: byId<HTMLInputElement>('autoMuteInput'),
    builtin: byId<HTMLInputElement>('serverModeBuiltin'),
    external: byId<HTMLInputElement>('serverModeExternal'),
    forceCpu: byId<HTMLInputElement>('forceCpuInput'),
    apiUrl: byId<HTMLInputElement>('apiUrlInput'),
    apiToken: byId<HTMLInputElement>('apiTokenInput'),
    refineExternal: byId<HTMLInputElement>('refineExternalInput'),
    vaultPath: byId<HTMLInputElement>('vaultPathInput'),
    captureDevice: byId<HTMLSelectElement>('captureDeviceInput'),
    liveModel: byId<HTMLInputElement>('liveModelInput'),
    language: byId<HTMLInputElement>('languageInput'),
    blockMinutes: byId<HTMLInputElement>('blockMinutesInput'),
    refineMode: byId<HTMLSelectElement>('refineModeInput'),
    timestampHeadings: byId<HTMLInputElement>('timestampHeadingsInput'),
    keepAudio: byId<HTMLInputElement>('keepAudioInput'),
  };
}

function syncServerMode(): void {
  const external = byId<HTMLInputElement>('serverModeExternal').checked;
  byId('externalOptions').hidden = !external;
  byId('builtinOptions').hidden = external;
}

async function fillMicDevices(selected: string): Promise<void> {
  const select = byId<HTMLSelectElement>('micDeviceInput');
  try {
    const devices = await window.api.getAudioDevices();
    select.replaceChildren(...devices.map((device) => new Option(device.name, device.id)));
  } catch (error) {
    console.error('Failed to load audio devices:', error);
    select.replaceChildren(new Option('System Default Microphone', 'default'));
  }
  select.value = selected || 'default';
}

// Session microphones come from the live engine; keep a saved name even when it is not listed.
async function fillCaptureDevices(selected: string): Promise<void> {
  const select = byId<HTMLSelectElement>('captureDeviceInput');
  const names = (await window.api.listCaptureDevices().catch(() => [])).map((device) => device.name);
  if (selected && !names.includes(selected)) names.push(selected);
  select.replaceChildren(new Option('System default', ''), ...names.map((name) => new Option(name, name)));
  select.value = selected;
}

export async function openSettings(): Promise<void> {
  const f = settingsFields();
  const settings = await window.api.getSettings();
  f.shortcut.value = settings.shortcut;
  f.autoMute.checked = settings.autoMuteAudio !== false;
  f.builtin.checked = settings.serverMode !== 'external';
  f.external.checked = settings.serverMode === 'external';
  f.forceCpu.checked = settings.forceCpu;
  f.apiUrl.value = settings.apiUrl;
  f.apiToken.value = settings.apiToken;
  f.refineExternal.checked = settings.refineWithExternalApi;
  f.vaultPath.value = settings.vaultPath;
  f.liveModel.value = settings.liveModelId;
  f.language.value = settings.language;
  f.blockMinutes.value = String(settings.blockMinutes);
  f.refineMode.value = settings.refineDuringRecording;
  f.timestampHeadings.checked = settings.timestampHeadings;
  f.keepAudio.checked = settings.keepSessionAudio;
  syncServerMode();
  byId<HTMLDialogElement>('settingsDialog').showModal();
  const saveBtn = byId<HTMLButtonElement>('settingsSaveBtn');
  saveBtn.disabled = true;
  try {
    await Promise.all([fillMicDevices(settings.micDevice), fillCaptureDevices(settings.captureDeviceName)]);
  } finally {
    saveBtn.disabled = false;
  }
}

async function saveSettingsFromDialog(): Promise<void> {
  const f = settingsFields();
  try {
    await window.api.saveSettings({
      shortcut: f.shortcut.value.trim() || 'Ctrl+Q',
      micDevice: f.micDevice.value || 'default',
      autoMuteAudio: f.autoMute.checked,
      serverMode: f.external.checked ? 'external' : 'builtin',
      forceCpu: f.forceCpu.checked,
      apiUrl: f.apiUrl.value.trim() || 'http://127.0.0.1:4444',
      apiToken: f.apiToken.value,
      refineWithExternalApi: f.refineExternal.checked,
      vaultPath: f.vaultPath.value || undefined,
      captureDeviceName: f.captureDevice.value,
      liveModelId: f.liveModel.value.trim() || 'ggml-base.en.bin',
      language: f.language.value.trim() || 'en',
      blockMinutes: Math.max(1, Math.min(30, Number(f.blockMinutes.value) || 2)),
      refineDuringRecording: f.refineMode.value as RefineMode,
      timestampHeadings: f.timestampHeadings.checked,
      keepSessionAudio: f.keepAudio.checked,
    });
    byId<HTMLDialogElement>('settingsDialog').close();
    toast('Settings saved. Shortcut changes apply after a restart.');
    onSettingsSaved(await window.api.getSettings());
  } catch (error) {
    reportError(error);
  }
}

// ---- Models

let modelsState: ModelListView = { models: [], activeModelId: null, downloading: false, disk: { usedBytes: 0, freeBytes: 0 } };
const progressById = new Map<string, DownloadProgressView>();
const errorById = new Map<string, string>();

function actionButton(text: string, className: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const button = el('button', `btn ${className}`, text);
  button.type = 'button';
  button.disabled = disabled;
  button.addEventListener('click', onClick);
  return button;
}

function progressText(progress: DownloadProgressView): string {
  if (progress.state === 'verifying') return 'Verifying…';
  if (!progress.totalBytes) return formatBytes(progress.receivedBytes);
  const percent = Math.floor((progress.receivedBytes / progress.totalBytes) * 100);
  return `${percent}% · ${formatBytes(progress.bytesPerSec)}/s`;
}

function renderModelRow(model: ModelEntryView): HTMLElement {
  const row = el('div', 'model-row');
  const info = el('div', 'model-info');
  const meta = [formatBytes(model.sizeBytes), model.label].filter(Boolean).join(' · ');
  info.append(el('div', 'model-name', model.name), el('div', 'model-meta', meta));
  const error = errorById.get(model.id);
  if (error) info.append(el('div', 'model-error', error));

  const actions = el('div', 'model-actions');
  const progress = progressById.get(model.id);
  if (progress) {
    const bar = el('div', 'progress');
    const fill = el('div', 'progress-bar');
    fill.style.width = progress.totalBytes ? `${Math.floor((progress.receivedBytes / progress.totalBytes) * 100)}%` : '0%';
    bar.append(fill);
    actions.append(
      bar,
      el('span', 'model-meta', progressText(progress)),
      actionButton('Cancel', '', () => void window.api.cancelDownload()),
    );
  } else if (model.installed) {
    if (model.id === modelsState.activeModelId) {
      actions.append(el('span', 'badge-active', 'Active'));
    } else {
      actions.append(actionButton('Use', 'primary', () => void selectModel(model.id)));
    }
    actions.append(actionButton('Delete', 'danger', () => void deleteModel(model)));
  } else {
    actions.append(
      actionButton(error ? 'Retry' : 'Download', 'primary', () => startModelDownload(model.id), modelsState.downloading),
    );
  }
  row.append(info, actions);
  return row;
}

function renderModels(): void {
  const disk = modelsState.disk;
  byId('diskInfo').textContent = `Disk: ${formatBytes(disk.usedBytes)} used · ${formatBytes(disk.freeBytes)} free`;
  byId('modelList').replaceChildren(...modelsState.models.map(renderModelRow));
  byId<HTMLButtonElement>('customModelBtn').disabled = modelsState.downloading;
}

async function refreshModels(): Promise<void> {
  try {
    modelsState = await window.api.listModels();
    renderModels();
  } catch (error) {
    reportError(error);
  }
}

export function openModels(): void {
  const dialog = byId<HTMLDialogElement>('modelsDialog');
  if (!dialog.open) dialog.showModal();
  void refreshModels();
}

export function startModelDownload(id: string): void {
  errorById.delete(id);
  progressById.set(id, { id, receivedBytes: 0, totalBytes: null, bytesPerSec: 0, state: 'downloading' });
  modelsState.downloading = true;
  renderModels();
  window.api.downloadModel(id).catch(reportError);
}

async function selectModel(id: string): Promise<void> {
  try {
    await window.api.selectModel(id);
  } catch (error) {
    reportError(error);
  }
  await refreshModels();
}

async function deleteModel(model: ModelEntryView): Promise<void> {
  if (!(await confirmAction('Delete model', `Delete ${model.name}?`, 'Delete'))) return;
  try {
    await window.api.deleteModel(model.id);
  } catch (error) {
    reportError(error);
  }
  await refreshModels();
}

function onDownloadProgress(progress: DownloadProgressView): void {
  const active = progress.state === 'downloading' || progress.state === 'verifying';
  if (progress.id.startsWith('custom')) {
    const status = byId('customModelStatus');
    byId('customCancelBtn').hidden = !active;
    status.className = progress.state === 'error' ? 'model-error' : 'muted';
    const labels: Record<string, string> = { done: 'Downloaded', cancelled: 'Cancelled', error: progress.error ?? 'Failed' };
    status.textContent = active ? progressText(progress) : labels[progress.state] ?? '';
  } else if (active) {
    progressById.set(progress.id, progress);
  } else {
    progressById.delete(progress.id);
    if (progress.state === 'error') errorById.set(progress.id, progress.error ?? 'Download failed');
  }
  modelsState.downloading = active;
  if (active) renderModels();
  else void refreshModels();
}

// ---- Wiring

export function initDialogs(hooks: { onSettingsSaved(settings: SettingsView): void }): void {
  onSettingsSaved = hooks.onSettingsSaved;

  byId('serverModeBuiltin').addEventListener('change', syncServerMode);
  byId('serverModeExternal').addEventListener('change', syncServerMode);
  byId('settingsSaveBtn').addEventListener('click', () => void saveSettingsFromDialog());
  byId('chooseVaultBtn').addEventListener('click', async () => {
    try {
      const chosen = await window.api.chooseVault();
      if (chosen) byId<HTMLInputElement>('vaultPathInput').value = chosen;
    } catch (error) {
      reportError(error);
    }
  });

  byId('customModelBtn').addEventListener('click', () => {
    const url = byId<HTMLInputElement>('customModelUrl').value.trim();
    if (!url) return;
    const status = byId('customModelStatus');
    status.className = 'muted';
    status.textContent = 'Starting…';
    modelsState.downloading = true;
    renderModels();
    window.api.downloadCustomModel(url).catch(reportError);
  });
  byId('customCancelBtn').addEventListener('click', () => void window.api.cancelDownload());
  window.api.onDownloadProgress(onDownloadProgress);
  window.api.onOpenModels(openModels);
}

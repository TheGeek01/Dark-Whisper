import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import Store from 'electron-store';
import type { RefineMode } from './blockRefiner';
import { initialServerMode, ServerMode } from './settingsMigration';

export interface Settings {
  shortcut: string;
  apiUrl: string;
  apiToken: string;
  autoMuteAudio: boolean;
  micDevice: string;
  serverMode: ServerMode;
  modelId: string | null;
  forceCpu: boolean;
  gpuFallbackVersion: string | null;
  liveModelId: string;
  language: string;
  vaultPath: string;
  refineDuringRecording: RefineMode;
  refineWithExternalApi: boolean;
  blockMinutes: number;
  keepSessionAudio: boolean;
  timestampHeadings: boolean;
  captureDeviceName: string;
}

export const DEFAULT_VAULT_PATH = path.join(app.getPath('documents'), 'Dark-Whisper');
const defaultVaultPath = DEFAULT_VAULT_PATH;

// Must be checked before the store is created, because creating it writes the defaults to disk.
const configFileExisted = fs.existsSync(path.join(app.getPath('userData'), 'config.json'));

const store = new Store({
  name: 'config',
  defaults: {
    shortcut: 'Ctrl+Q',
    apiUrl: 'http://127.0.0.1:4444',
    apiToken: '',
    autoMuteAudio: true,
    micDevice: 'default',
    modelId: null,
    forceCpu: false,
    gpuFallbackVersion: null,
    liveModelId: 'ggml-base.en.bin',
    language: 'en',
    vaultPath: defaultVaultPath,
    refineDuringRecording: 'auto',
    refineWithExternalApi: false,
    blockMinutes: 2,
    keepSessionAudio: false,
    timestampHeadings: false,
    captureDeviceName: '',
  },
}) as unknown as Store<Settings>;

const storeAny = store as any;

if (!storeAny.has('serverMode')) {
  storeAny.set('serverMode', initialServerMode(configFileExisted));
}

export function getSettings(): Settings {
  return {
    shortcut: storeAny.get('shortcut', 'Ctrl+Q'),
    apiUrl: storeAny.get('apiUrl', 'http://127.0.0.1:4444'),
    apiToken: storeAny.get('apiToken', ''),
    autoMuteAudio: storeAny.get('autoMuteAudio', true),
    micDevice: storeAny.get('micDevice', 'default'),
    serverMode: storeAny.get('serverMode', 'builtin'),
    modelId: storeAny.get('modelId', null),
    forceCpu: storeAny.get('forceCpu', false),
    gpuFallbackVersion: storeAny.get('gpuFallbackVersion', null),
    liveModelId: storeAny.get('liveModelId', 'ggml-base.en.bin'),
    language: storeAny.get('language', 'en'),
    vaultPath: storeAny.get('vaultPath', defaultVaultPath),
    refineDuringRecording: storeAny.get('refineDuringRecording', 'auto'),
    refineWithExternalApi: storeAny.get('refineWithExternalApi', false),
    blockMinutes: storeAny.get('blockMinutes', 2),
    keepSessionAudio: storeAny.get('keepSessionAudio', false),
    timestampHeadings: storeAny.get('timestampHeadings', false),
    captureDeviceName: storeAny.get('captureDeviceName', ''),
  };
}

export function saveSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  storeAny.set(key, value);
}

export function saveSettings(settings: Partial<Settings>): void {
  Object.entries(settings).forEach(([key, value]) => {
    if (value !== undefined) {
      storeAny.set(key, value);
    }
  });
}

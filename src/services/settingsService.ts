import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import Store from 'electron-store';
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
}

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

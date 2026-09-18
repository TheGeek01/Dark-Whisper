import { displayName } from './modelCatalog';
import type { ServerMode } from './settingsMigration';
import type { ServerStatus } from './whisperServer';

export type GateResult = { allow: true } | { allow: false; action: 'open-models' | 'notify'; message: string };

export interface ServerStatusView extends ServerStatus {
  mode: ServerMode;
  text: string;
}

export function recordingGate(mode: ServerMode, status: ServerStatus): GateResult {
  if (mode === 'external') return { allow: true };
  switch (status.state) {
    case 'ready':
      return { allow: true };
    case 'no-model':
      return { allow: false, action: 'open-models', message: 'Choose a speech model to finish setup' };
    case 'starting':
      return { allow: false, action: 'notify', message: 'Model is still loading' };
    case 'error':
      return { allow: false, action: 'notify', message: status.message ?? 'Transcription server error' };
    case 'stopped':
      return { allow: false, action: 'notify', message: 'Transcription server is not running' };
  }
}

function statusText(mode: ServerMode, status: ServerStatus, apiUrl: string): string {
  if (mode === 'external') return `External API — ${apiUrl}`;
  switch (status.state) {
    case 'no-model':
      return 'No model installed';
    case 'starting':
      return status.message ?? 'Loading model…';
    case 'ready': {
      const name = status.modelId ? displayName(status.modelId) : 'unknown model';
      return `Ready — ${name} (${status.gpu ? 'GPU' : 'CPU'}${status.vad ? ', VAD' : ''})`;
    }
    case 'error':
      return `Server error: ${status.message ?? 'unknown error'}`;
    case 'stopped':
      return 'Server stopped';
  }
}

export function toStatusView(mode: ServerMode, status: ServerStatus, apiUrl: string): ServerStatusView {
  return { ...status, mode, text: statusText(mode, status, apiUrl) };
}

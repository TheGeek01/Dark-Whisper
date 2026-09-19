import type { ServerStatusView, SessionStatusView, SettingsView, UpdateStatusView } from '../shared/api.js';

export type HeaderTone = 'ok' | 'busy' | 'rec' | 'error' | 'idle' | 'external';

// 'ggml-large-v3-turbo-q5_0.bin' → 'large-v3-turbo'
export function shortModelName(id: string | null | undefined): string {
  if (!id) return 'none';
  return id
    .replace(/^ggml-/, '')
    .replace(/\.bin$/, '')
    .replace(/-q\d+(_\d+)?$/, '');
}

export function modelChipText(settings: Pick<SettingsView, 'liveModelId' | 'modelId' | 'serverMode'>): string {
  const refine = settings.serverMode === 'external' ? 'External API' : shortModelName(settings.modelId);
  return `${shortModelName(settings.liveModelId)} → ${refine}`;
}

// The header's one status line: what is recording wins over the server.
export function headerStatus(
  server: ServerStatusView | null,
  session: SessionStatusView | null,
): { text: string; tone: HeaderTone } {
  if (session) {
    if (session.state === 'error') return { text: session.message ?? 'Recording error', tone: 'error' };
    if (session.state === 'starting') return { text: 'Starting…', tone: 'busy' };
    if (session.state === 'recording') return { text: session.kind === 'quick-note' ? 'Quick note' : 'Recording', tone: 'rec' };
    if (session.state === 'paused') return { text: 'Paused', tone: 'busy' };
    if (session.refining > 0) return { text: `Refining ${session.refining}`, tone: 'busy' };
  }
  if (!server) return { text: 'Checking…', tone: 'idle' };
  if (server.mode === 'external') return { text: server.text, tone: 'external' };
  if (server.state === 'ready') return { text: 'Ready', tone: 'ok' };
  if (server.state === 'error') return { text: server.text, tone: 'error' };
  if (server.state === 'starting') return { text: server.text, tone: 'busy' };
  return { text: server.text, tone: 'idle' };
}

// The line under Check for updates in Settings.
export function updateStatusText(status: UpdateStatusView): string {
  switch (status.state) {
    case 'unsupported':
      return 'Updates work in the installed app only';
    case 'idle':
      return '';
    case 'checking':
      return 'Checking…';
    case 'up-to-date':
      return 'Up to date';
    case 'downloading':
      return `Downloading ${status.version ?? 'the update'}… ${status.percent ?? 0}%`;
    case 'ready':
      return `${status.version ?? 'The update'} is ready: restart to install it`;
    case 'error':
      return `Could not update: ${status.message ?? 'unknown error'}`;
  }
}

// The header offers the restart only once an update has downloaded.
export function updateButtonText(status: UpdateStatusView | null): string | null {
  return status?.state === 'ready' ? `Update ${status.version ?? ''} — Restart` : null;
}

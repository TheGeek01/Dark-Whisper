import type { ServerStatusView, SessionStatusView } from '../shared/api';
import { headerStatus, modelChipText, shortModelName } from '../renderer/headerModel';

const server = (overrides: Partial<ServerStatusView> = {}): ServerStatusView => ({
  state: 'ready',
  mode: 'builtin',
  text: 'Ready — large-v3-turbo-q5_0 (GPU)',
  modelId: 'ggml-large-v3-turbo-q5_0.bin',
  gpu: true,
  vad: false,
  ...overrides,
});

const session = (overrides: Partial<SessionStatusView> = {}): SessionStatusView => ({
  sessionId: 's1',
  kind: 'session',
  state: 'recording',
  documentPath: 'C:/v/a.md',
  documentFile: 'a.md',
  folder: '',
  blockIndex: 1,
  durationSec: 0,
  refining: 0,
  muted: false,
  microphone: 'Mic',
  liveModel: 'base',
  refineModel: 'turbo',
  messages: [],
  blocks: [],
  ...overrides,
});

describe('headerModel', () => {
  it('shortens model file names', () => {
    expect(shortModelName('ggml-large-v3-turbo-q5_0.bin')).toBe('large-v3-turbo');
    expect(shortModelName('ggml-base.en.bin')).toBe('base.en');
    expect(shortModelName('ggml-medium-q8_0.bin')).toBe('medium');
    expect(shortModelName(null)).toBe('none');
  });

  it('shows the live and refine models on the chip', () => {
    expect(modelChipText({ liveModelId: 'ggml-base.en.bin', modelId: 'ggml-large-v3-turbo-q5_0.bin', serverMode: 'builtin' })).toBe(
      'base.en → large-v3-turbo',
    );
    expect(modelChipText({ liveModelId: 'ggml-base.en.bin', modelId: null, serverMode: 'external' })).toBe('base.en → External API');
  });

  it('prefers what is recording over the server state', () => {
    expect(headerStatus(server(), session())).toEqual({ text: 'Recording', tone: 'rec' });
    expect(headerStatus(server(), session({ kind: 'quick-note' }))).toEqual({ text: 'Quick note', tone: 'rec' });
    expect(headerStatus(server(), session({ state: 'paused' }))).toEqual({ text: 'Paused', tone: 'busy' });
    expect(headerStatus(server(), session({ state: 'starting' }))).toEqual({ text: 'Starting…', tone: 'busy' });
    expect(headerStatus(server(), session({ state: 'error', message: 'Mic gone' }))).toEqual({ text: 'Mic gone', tone: 'error' });
    expect(headerStatus(server(), session({ state: 'stopped', refining: 2 }))).toEqual({ text: 'Refining 2', tone: 'busy' });
  });

  it('falls back to the server state', () => {
    expect(headerStatus(server(), session({ state: 'stopped' }))).toEqual({ text: 'Ready', tone: 'ok' });
    expect(headerStatus(server(), null)).toEqual({ text: 'Ready', tone: 'ok' });
    expect(headerStatus(null, null)).toEqual({ text: 'Checking…', tone: 'idle' });
    expect(headerStatus(server({ state: 'starting', text: 'Loading model…' }), null)).toEqual({ text: 'Loading model…', tone: 'busy' });
    expect(headerStatus(server({ state: 'error', text: 'Server crashed' }), null)).toEqual({ text: 'Server crashed', tone: 'error' });
    expect(headerStatus(server({ state: 'no-model', text: 'No model' }), null)).toEqual({ text: 'No model', tone: 'idle' });
    expect(headerStatus(server({ mode: 'external', text: 'External API' }), null)).toEqual({ text: 'External API', tone: 'external' });
  });
});

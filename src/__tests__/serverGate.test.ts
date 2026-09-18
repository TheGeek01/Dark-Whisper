import { recordingGate, toStatusView } from '../services/serverGate';
import type { ServerStatus } from '../services/whisperServer';

const base: ServerStatus = { state: 'ready', modelId: 'ggml-large-v3-turbo-q5_0.bin', backend: 'vulkan', gpu: true, vad: false, port: 5000 };

describe('recordingGate', () => {
  it('always allows external mode', () => {
    expect(recordingGate('external', { ...base, state: 'no-model' })).toEqual({ allow: true });
  });

  it.each([
    ['ready', undefined, { allow: true }],
    ['no-model', undefined, { allow: false, action: 'open-models', message: 'Choose a speech model to finish setup' }],
    ['starting', undefined, { allow: false, action: 'notify', message: 'Model is still loading' }],
    ['error', 'Model failed to load — try re-downloading it', { allow: false, action: 'notify', message: 'Model failed to load — try re-downloading it' }],
    ['stopped', undefined, { allow: false, action: 'notify', message: 'Transcription server is not running' }],
  ] as const)('built-in %s', (state, message, expected) => {
    expect(recordingGate('builtin', { ...base, state, message })).toEqual(expected);
  });
});

describe('toStatusView', () => {
  it.each([
    ['external', base, 'External API — http://127.0.0.1:4444'],
    ['builtin', { ...base, state: 'no-model' }, 'No model installed'],
    ['builtin', { ...base, state: 'starting' }, 'Loading model…'],
    ['builtin', { ...base, state: 'starting', message: 'Server crashed, restarting in 5s' }, 'Server crashed, restarting in 5s'],
    ['builtin', base, 'Ready — large-v3-turbo-q5_0 (GPU)'],
    ['builtin', { ...base, gpu: false }, 'Ready — large-v3-turbo-q5_0 (CPU)'],
    ['builtin', { ...base, vad: true }, 'Ready — large-v3-turbo-q5_0 (GPU, VAD)'],
    ['builtin', { ...base, gpu: false, vad: true }, 'Ready — large-v3-turbo-q5_0 (CPU, VAD)'],
    ['builtin', { ...base, state: 'error', message: 'boom' }, 'Server error: boom'],
    ['builtin', { ...base, state: 'stopped' }, 'Server stopped'],
  ] as const)('%s %o', (mode, status, text) => {
    expect(toStatusView(mode, status as ServerStatus, 'http://127.0.0.1:4444')).toEqual({ ...status, mode, text });
  });
});

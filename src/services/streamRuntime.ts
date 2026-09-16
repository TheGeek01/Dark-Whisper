import { app } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getSoxPath } from './recordingService';
import { BinaryLocations, resolveStreamBinary } from './serverPaths';
import { audioFileName } from './sessionPaths';
import { getSettings } from './settingsService';
import { StreamEngine, StreamProcess } from './streamEngine';

const MAX_SOX_RESTARTS = 3;
// How long to wait for SoX to release the session audio after we ask it to stop.
const SOX_EXIT_WAIT_MS = 5000;

const userData = app.getPath('userData');
const logFile = path.join(userData, 'logs', 'stream.log');

function locations(): BinaryLocations {
  return {
    envDir: process.env.WHISPER_SERVER_DIR,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
  };
}

export function sessionsRoot(): string {
  return path.join(userData, 'sessions');
}

export function createSessionDir(sessionId: string): string {
  const dir = path.join(sessionsRoot(), sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function currentAudioFiles(sessionId: string): string[] {
  try {
    return fs.readdirSync(path.join(sessionsRoot(), sessionId));
  } catch {
    return [];
  }
}

// --- Session audio recording (SoX) ---
//
// whisper-stream's own --save-audio is not real-time: in VAD mode it rewrites the current
// 2-second buffer on every loop iteration (~10x/second), so the WAV it produces is the
// session audio duplicated ~72x and cannot be sliced by time offset. We record session audio
// ourselves with the bundled SoX (the same binary quick dictation already uses), which can
// hold the microphone at the same time whisper-stream does.
let audioManifest: { file: string; startSec: number }[] = [];
let soxChild: ReturnType<typeof spawn> | null = null;
let sessionStartedAt = 0;
let soxGeneration = 0;
let soxRestartCount = 0;
let sessionAudioActive = false;
let currentAudioIndex = 0;
let currentSessionDir = '';
let currentDeviceName = '';

export function sessionAudioManifest(): { file: string; startSec: number }[] {
  return audioManifest.map((entry) => ({ ...entry }));
}

function spawnSoxSegment(): void {
  currentAudioIndex += 1;
  const generation = ++soxGeneration;
  const file = path.join(currentSessionDir, audioFileName(currentAudioIndex));
  const device = currentDeviceName || 'default';
  const child = spawn(getSoxPath(), ['-t', 'waveaudio', device, '-r', '16000', '-c', '1', file], {
    windowsHide: true,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  soxChild = child;
  audioManifest.push({ file, startSec: (Date.now() - sessionStartedAt) / 1000 });

  child.stderr?.on('data', (chunk) => {
    console.error('sox (session audio) stderr:', chunk.toString());
  });

  let handled = false;
  const onEnded = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (handled || generation !== soxGeneration) return;
    handled = true;
    soxChild = null;
    if (!sessionAudioActive) return;
    if (soxRestartCount >= MAX_SOX_RESTARTS) {
      console.error(
        `Session audio recorder (SoX) stopped (code ${code}, signal ${signal}) and the retry budget (${MAX_SOX_RESTARTS}) is exhausted; session audio recording has stopped for the rest of this session.`
      );
      return;
    }
    soxRestartCount += 1;
    console.error(
      `Session audio recorder (SoX) stopped unexpectedly (code ${code}, signal ${signal}); restarting (attempt ${soxRestartCount}/${MAX_SOX_RESTARTS}).`
    );
    spawnSoxSegment();
  };
  child.on('exit', (code, signal) => onEnded(code, signal));
  child.on('error', (error) => {
    console.error('Failed to start the session audio recorder (SoX):', error);
    onEnded(null, null);
  });
}

export function startSessionAudio(sessionDir: string, deviceName: string): void {
  currentSessionDir = sessionDir;
  currentDeviceName = deviceName;
  currentAudioIndex = 0;
  audioManifest = [];
  soxRestartCount = 0;
  sessionAudioActive = true;
  spawnSoxSegment();
}

// Resolves once SoX has exited (or after SOX_EXIT_WAIT_MS): until then Windows will not let the
// session audio be deleted.
export function stopSessionAudio(): Promise<void> {
  sessionAudioActive = false;
  soxGeneration++;
  const child = soxChild;
  soxChild = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const exited = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, SOX_EXIT_WAIT_MS);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  try {
    child.stdin?.write('q');
  } catch {
    // sox may already be gone; nothing to do.
  }
  child.kill();
  return exited;
}

export function resolveLiveModelPath(): string | null {
  // Imported lazily to avoid a cycle: whisperRuntime owns the model manager.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { modelManager } = require('./whisperRuntime') as typeof import('./whisperRuntime');
  return modelManager.getModelPath(getSettings().liveModelId);
}

function spawnStream(binary: string, args: string[], cwd: string): StreamProcess {
  const child = spawn(binary, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    pid: child.pid,
    stdout: child.stdout!,
    stderr: child.stderr!,
    onExit: (listener) => {
      let reported = false;
      const report = (code: number | null) => {
        if (!reported) {
          reported = true;
          listener(code);
        }
      };
      child.on('exit', (code) => report(code));
      child.on('error', (error) => {
        console.error('stream.exe process error:', error);
        report(null);
      });
    },
    kill: () => {
      child.kill();
    },
  };
}

export const streamEngine = new StreamEngine({
  resolveBinary: () => {
    const settings = getSettings();
    const backend = settings.forceCpu ? 'cpu' : 'vulkan';
    return resolveStreamBinary(backend, locations(), fs.existsSync) ?? resolveStreamBinary('cpu', locations(), fs.existsSync);
  },
  spawnStream,
  writeLog: (lines) => {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(logFile, `${lines.join('\n')}\n`);
    } catch (error) {
      console.error('Failed to write the live transcription log:', error);
    }
  },
  now: Date.now,
});

export async function startLiveEngine(args: { sessionId: string; captureId: number | null; deviceName?: string }): Promise<void> {
  const settings = getSettings();
  const modelPath = resolveLiveModelPath();
  if (!modelPath) {
    throw new Error(`Live model ${settings.liveModelId} is not installed`);
  }
  const cwd = createSessionDir(args.sessionId);
  sessionStartedAt = Date.now();
  // Start our own session-audio recorder before the engine, and never stop it on an
  // engine restart: SoX must keep running across whisper-stream crashes/restarts so the
  // audio timeline (and the manifest block-refinement will slice by) stays continuous.
  startSessionAudio(cwd, args.deviceName ?? '');
  await streamEngine.start({
    modelPath,
    language: settings.language,
    captureId: args.captureId,
    forceCpu: settings.forceCpu,
    cwd,
    threads: Math.max(2, Math.min(8, os.cpus().length - 2)),
  });
}

export function stopLiveEngine(): Promise<void> {
  const audioStopped = stopSessionAudio();
  streamEngine.stop();
  return audioStopped;
}

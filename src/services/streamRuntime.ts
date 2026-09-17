import { app } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { meterLevel, pcmLevelDb, SilenceTracker } from './audioLevel';
import { PcmFileSink } from './pcmFileSink';
import { getSoxPath } from './soxPath';
import { BinaryLocations, resolveStreamBinary } from './serverPaths';
import { audioFileName } from './sessionPaths';
import { getSettings } from './settingsService';
import { StreamEngine, StreamProcess } from './streamEngine';

const MAX_SOX_RESTARTS = 3;
// How long to wait for SoX to release the session audio after we ask it to stop.
const SOX_EXIT_WAIT_MS = 5000;
// The renderer's level meter needs no more than this.
const LEVEL_INTERVAL_MS = 100;

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
// whisper-stream's own --save-audio is not real-time (in VAD mode it rewrites its 2-second
// buffer ~10x/second), so we record session audio ourselves with the bundled SoX, which can hold
// the microphone at the same time whisper-stream does. SoX sends raw 16 kHz mono PCM to stdout;
// we write the WAV and measure each chunk's level, which drives the level meter and the silence
// rule that ends a block (spec §3.1, §4.5). SoX's own -S level display is buffered until it exits
// when stderr is a pipe, so it cannot be used for this.
export interface SessionAudio {
  // One entry per SoX process; a crashed recorder is restarted into a new file.
  entries: { file: string; startSec: number }[];
  silence: SilenceTracker;
}

let soxChild: ReturnType<typeof spawn> | null = null;
let soxClosed: Promise<void> = Promise.resolve();
let sessionStartedAt = 0;
let soxGeneration = 0;
let soxRestartCount = 0;
let sessionAudioActive = false;
let currentAudioIndex = 0;
let currentSessionDir = '';
let currentDeviceName = '';
let lastLevelAt = 0;
const levelListeners = new Set<(level: number) => void>();

export function onAudioLevel(listener: (level: number) => void): () => void {
  levelListeners.add(listener);
  return () => levelListeners.delete(listener);
}

function emitLevel(db: number): void {
  const now = Date.now();
  if (now - lastLevelAt < LEVEL_INTERVAL_MS) return;
  lastLevelAt = now;
  const level = meterLevel(db);
  for (const listener of levelListeners) listener(level);
}

function spawnSoxSegment(session: SessionAudio): void {
  currentAudioIndex += 1;
  const generation = ++soxGeneration;
  const file = path.join(currentSessionDir, audioFileName(currentAudioIndex));
  const device = currentDeviceName || 'default';
  const offsetSec = (Date.now() - sessionStartedAt) / 1000;

  let sink: PcmFileSink;
  try {
    sink = new PcmFileSink(file, (startSec, durationSec, chunk) => {
      const db = pcmLevelDb(chunk);
      session.silence.add(offsetSec + startSec, durationSec, db);
      emitLevel(db);
    });
  } catch (error) {
    console.error('Could not create the session audio file:', error);
    return;
  }
  session.entries.push({ file, startSec: offsetSec });

  const child = spawn(
    getSoxPath(),
    ['-q', '-t', 'waveaudio', device, '-r', '16000', '-c', '1', '-b', '16', '-e', 'signed-integer', '-t', 'raw', '-'],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  soxChild = child;
  child.stdout?.on('data', (chunk: Buffer) => sink.write(chunk));
  child.stderr?.on('data', (chunk) => {
    console.error('sox (session audio) stderr:', chunk.toString());
  });

  let handled = false;
  let resolveClosed: () => void = () => undefined;
  soxClosed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  // 'close' fires once the process has exited and stdout is drained, so the WAV is complete.
  const onEnded = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (handled) return;
    handled = true;
    try {
      sink.close();
    } catch (error) {
      console.error('Could not finish the session audio file:', error);
    }
    resolveClosed();
    if (generation !== soxGeneration) return;
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
    spawnSoxSegment(session);
  };
  child.on('close', (code, signal) => onEnded(code, signal));
  child.on('error', (error) => {
    console.error('Failed to start the session audio recorder (SoX):', error);
    onEnded(null, null);
  });
}

export function startSessionAudio(sessionDir: string, deviceName: string): SessionAudio {
  currentSessionDir = sessionDir;
  currentDeviceName = deviceName;
  currentAudioIndex = 0;
  soxRestartCount = 0;
  sessionAudioActive = true;
  const session: SessionAudio = { entries: [], silence: new SilenceTracker() };
  spawnSoxSegment(session);
  return session;
}

// Resolves once SoX has exited and its WAV is finished (or after SOX_EXIT_WAIT_MS): until then
// Windows will not let the session audio be deleted.
export function stopSessionAudio(): Promise<void> {
  sessionAudioActive = false;
  soxGeneration++;
  const child = soxChild;
  soxChild = null;
  const closed = soxClosed;
  if (!child) return closed;
  const waited = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, SOX_EXIT_WAIT_MS);
    void closed.then(() => {
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
  return waited;
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

export async function startLiveEngine(args: { sessionId: string; captureId: number | null; deviceName?: string }): Promise<SessionAudio> {
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
  const session = startSessionAudio(cwd, args.deviceName ?? '');
  await streamEngine.start({
    modelPath,
    language: settings.language,
    captureId: args.captureId,
    forceCpu: settings.forceCpu,
    cwd,
    threads: Math.max(2, Math.min(8, os.cpus().length - 2)),
  });
  return session;
}

export function stopLiveEngine(): Promise<void> {
  const audioStopped = stopSessionAudio();
  streamEngine.stop();
  return audioStopped;
}

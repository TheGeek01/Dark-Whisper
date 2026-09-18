import { app, shell } from 'electron';
import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { promisify } from 'util';
import { ModelManager, axiosFetcher, statfsFreeSpace } from './modelManager';
import { isWhisperServerImage, parseTasklistImage } from './serverOutput';
import { BinaryLocations, resolveServerBinary, whisperResourceDir } from './serverPaths';
import { getSettings, saveSettings } from './settingsService';
import { installVadModel } from './vadModel';
import { ServerProcess, WhisperServer } from './whisperServer';

const execFileAsync = promisify(execFile);
const userData = app.getPath('userData');
const pidFile = path.join(userData, 'whisper-server.pid');
const logFile = path.join(userData, 'logs', 'whisper-server.log');

function locations(): BinaryLocations {
  return {
    envDir: process.env.WHISPER_SERVER_DIR,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
  };
}

export function bundledWhisperVersion(): string {
  try {
    return fs.readFileSync(path.join(whisperResourceDir(locations()), 'VERSION'), 'utf8').trim();
  } catch {
    return 'unknown';
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function checkHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

function spawnServer(binary: string, args: string[], cwd: string): ServerProcess {
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
      // A spawn failure (e.g. missing DLL/binary) may emit 'error' without 'exit'.
      child.on('error', (error) => {
        console.error('whisper-server process error:', error);
        report(null);
      });
    },
    kill: () => {
      child.kill();
    },
  };
}

async function killStaleProcess(): Promise<void> {
  let pid: number;
  try {
    pid = Number.parseInt(await fs.promises.readFile(pidFile, 'utf8'), 10);
  } catch {
    return;
  }
  try {
    if (process.platform === 'win32' && Number.isInteger(pid) && pid > 0) {
      const { stdout } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true });
      if (isWhisperServerImage(parseTasklistImage(stdout))) {
        await execFileAsync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true });
      }
    }
  } catch (error) {
    console.error('Failed to clean up a stale whisper-server process:', error);
  } finally {
    await fs.promises.rm(pidFile, { force: true });
  }
}

export const whisperServer = new WhisperServer({
  resolveBinary: (backend) => resolveServerBinary(backend, locations(), fs.existsSync),
  spawnServer,
  findFreePort,
  checkHealth,
  killStaleProcess,
  writePid: (pid) => {
    try {
      fs.writeFileSync(pidFile, String(pid));
    } catch (error) {
      console.error('Failed to write whisper-server pid file:', error);
    }
  },
  clearPid: () => {
    try {
      fs.rmSync(pidFile, { force: true });
    } catch (error) {
      console.error('Failed to clear whisper-server pid file:', error);
    }
  },
  writeLog: (lines) => {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(logFile, `${lines.join('\n')}\n`);
    } catch (error) {
      console.error('Failed to write whisper-server log file:', error);
    }
  },
  getGpuFallback: () => getSettings().gpuFallbackVersion === bundledWhisperVersion(),
  setGpuFallback: (value) => saveSettings({ gpuFallbackVersion: value ? bundledWhisperVersion() : null }),
  now: Date.now,
});

const modelsDir = path.join(userData, 'models');

export const modelManager = new ModelManager({
  modelsDir,
  fetcher: axiosFetcher,
  freeSpace: statfsFreeSpace,
});

// The bundled Silero model, verified and copied next to the speech models (spec §3, §4).
function vadModelForServer(): string | null {
  if (!getSettings().refineVad) return null;
  const installed = installVadModel(path.join(whisperResourceDir(locations()), 'vad'), modelsDir);
  if (installed.path === null) {
    console.warn(`Refining without VAD: ${installed.reason}`);
    return null;
  }
  return installed.path;
}

export async function startBuiltinServer(): Promise<void> {
  const settings = getSettings();
  if (settings.serverMode !== 'builtin') {
    whisperServer.stop();
    return;
  }
  const modelPath = settings.modelId ? modelManager.getModelPath(settings.modelId) : null;
  if (!settings.modelId || !modelPath) {
    whisperServer.setNoModel();
    return;
  }
  await whisperServer.start(settings.modelId, modelPath, { forceCpu: settings.forceCpu, vadModelPath: vadModelForServer() });
}

export function openServerLog(): Promise<string> {
  return shell.openPath(logFile);
}

export async function cleanupStaleServer(): Promise<void> {
  await killStaleProcess();
}

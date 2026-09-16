// Usage: npm run stream:probe -- <model path> [capture id]
// Speaks segments to stdout as you talk. Ctrl+C to stop.
// Note: this probe exercises whisper-stream.exe only. It does NOT record session audio
// (that is done by SoX via streamRuntime.startSessionAudio/stopSessionAudio, which requires
// Electron's `app` module and so cannot run in this standalone script).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StreamEngine } = require('../dist/services/streamEngine');
const { resolveStreamBinary } = require('../dist/services/serverPaths');

const modelPath = process.argv[2];
const captureId = process.argv[3] === undefined ? null : Number(process.argv[3]);
if (!modelPath || !fs.existsSync(modelPath)) {
  console.error('usage: npm run stream:probe -- <path to ggml model> [capture id]');
  process.exit(2);
}

const repo = path.join(__dirname, '..');
const locations = { resourcesPath: repo, appPath: repo, isPackaged: false };
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-probe-'));

console.error('[probe] engine-only: this probe does not record session audio (no SoX recorder here).');

const engine = new StreamEngine({
  resolveBinary: () => resolveStreamBinary('cpu', locations, fs.existsSync),
  spawnStream: (binary, args, dir) => {
    const child = spawn(binary, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    return {
      pid: child.pid,
      stdout: child.stdout,
      stderr: child.stderr,
      onExit: (l) => child.on('exit', l),
      kill: () => child.kill(),
    };
  },
  writeLog: () => {},
  now: Date.now,
});

engine.onStatus((s) => console.error(`[state] ${s.state}${s.message ? ': ' + s.message : ''}`));
engine.onSegment((s) => console.log(`${(s.atMs / 1000).toFixed(1)}s  ${s.text}`));

engine
  .start({ modelPath, language: 'en', captureId, forceCpu: true, cwd, threads: 4 })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

process.on('SIGINT', () => {
  engine.stop();
  console.error(`\nwhisper-stream's working directory (live.txt, its own non-real-time wav) left in ${cwd}`);
  process.exit(0);
});

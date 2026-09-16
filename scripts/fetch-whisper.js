// Downloads the official whisper.cpp CPU build for local development into resources/whisper/cpu.
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ZIP_SHA256 = {
  b5130: 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c',
};

const root = path.join(__dirname, '..');
const tag = fs.readFileSync(path.join(root, 'whisper.version'), 'utf8').trim();
const whisperDir = path.join(root, 'resources', 'whisper');
const outDir = path.join(whisperDir, 'cpu');
const url = `https://github.com/ggml-org/whisper.cpp/releases/download/${tag}/whisper-bin-x64.zip`;

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('whisper:fetch downloads Windows binaries and must run on Windows');
  }
  const expected = ZIP_SHA256[tag];
  if (!expected) {
    throw new Error(`No SHA256 recorded for whisper.cpp ${tag}; add it to ZIP_SHA256 in scripts/fetch-whisper.js`);
  }

  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  const zip = Buffer.from(await res.arrayBuffer());
  const actual = crypto.createHash('sha256').update(zip).digest('hex');
  if (actual !== expected) throw new Error(`Checksum mismatch for ${url}: expected ${expected}, got ${actual}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-fetch-'));
  try {
    const zipPath = path.join(tmp, 'whisper-bin-x64.zip');
    fs.writeFileSync(zipPath, zip);
    // Windows' bundled bsdtar extracts zip files; Git Bash's GNU tar does not.
    const tarExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tarExe, ['-xf', zipPath, '-C', tmp]);

    const releaseDir = path.join(tmp, 'Release');
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    for (const file of fs.readdirSync(releaseDir)) {
      const keep = file === 'whisper-server.exe' || file === 'whisper-stream.exe' || file.toLowerCase().endsWith('.dll');
      if (keep) {
        fs.copyFileSync(path.join(releaseDir, file), path.join(outDir, file));
      }
    }
    fs.writeFileSync(path.join(whisperDir, 'VERSION'), tag);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`Installed whisper.cpp ${tag} CPU server to ${path.relative(root, outDir)}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

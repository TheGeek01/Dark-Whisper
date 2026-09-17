# Silero VAD for Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the refinement model from inventing text on silent paragraphs by running the bundled `whisper-server` with Silero VAD, and remove paragraphs that turn out to contain no speech.

**Architecture:** A pinned Silero model ships with the installer, is verified and copied into the models folder at start-up, and is passed to `whisper-server` as `--vad -vm <path relative to the model's directory>`. The supervisor records whether VAD is on and relaunches without it if the server reports a VAD failure. When VAD is on, an empty refinement removes its paragraph (hash-guarded); otherwise the live text is kept.

**Tech Stack:** Electron 44, TypeScript 6, Jest 30, whisper.cpp b5130 (`whisper-server`), GitHub Actions (pwsh).

**Spec:** `docs/superpowers/specs/2026-09-17-dark-whisper-refine-vad-design.md`

## Global Constraints

- Branch `feat/quick-notes-refresh`. Commit with `git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit`, message ending with a blank line and `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- VAD model: file `ggml-silero-v6.2.0.bin`, size `885098`, SHA256 `2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987`, URL `https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin`.
- The server gets the VAD model only as a path relative to its working directory (the chosen model's directory), never an absolute path.
- whisper.cpp stays at b5130. No new npm dependencies.
- Setting `refineVad`: boolean, default `true`. UI label "Skip silence when refining (VAD)", hint "Removes paragraphs that contain no speech."
- New block state `removed`, label `removed — no speech`, rank 3.
- The b5130 failure line is `whisper_vad: failed to initialize VAD context` (probe 2026-09-17).
- Verification: `npx jest <path>`, `npm test`, `npm run build`, `npm run lint` (0 errors), `npm run smoke:workspace`.
- Before any tag, parse every pwsh `run:` block of `.github/workflows/publish.yml` with `[System.Management.Automation.Language.Parser]::ParseInput` (Task 1 Step 7 has the command).

---

### Task 1: Pin, fetch, bundle and install the VAD model

**Files:**
- Create: `whisper-vad.json`, `src/services/vadModel.ts`, `src/__tests__/vadModel.test.ts`
- Modify: `scripts/fetch-whisper.js`, `.github/workflows/publish.yml`

**Interfaces:**
- Produces (in `vadModel.ts`):
  - `interface VadModelPin { file: string; url: string; size: number; sha256: string }`
  - `VAD_MODEL: VadModelPin`
  - `fileMatchesPin(file: string, pin?: VadModelPin): boolean`
  - `installVadModel(bundledDir: string, modelsDir: string, pin?: VadModelPin): { path: string } | { path: null; reason: string }`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/vadModel.test.ts`:

```ts
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileMatchesPin, installVadModel, VAD_MODEL, VadModelPin } from '../services/vadModel';

const content = Buffer.from('pretend silero weights');
const pin: VadModelPin = {
  file: 'ggml-silero-test.bin',
  url: 'https://example.invalid/ggml-silero-test.bin',
  size: content.length,
  sha256: createHash('sha256').update(content).digest('hex'),
};

describe('vadModel', () => {
  let root: string;
  let bundled: string;
  let models: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-vad-'));
    bundled = path.join(root, 'resources', 'vad');
    models = path.join(root, 'models');
    fs.mkdirSync(bundled, { recursive: true });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('matches the pin in whisper-vad.json', () => {
    const json = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'whisper-vad.json'), 'utf8'));
    expect(json).toEqual(VAD_MODEL);
  });

  it('checks size and hash', () => {
    const file = path.join(bundled, pin.file);
    expect(fileMatchesPin(file, pin)).toBe(false);
    fs.writeFileSync(file, content);
    expect(fileMatchesPin(file, pin)).toBe(true);
    fs.writeFileSync(file, Buffer.from('pretend silero weightZ'));
    expect(fileMatchesPin(file, pin)).toBe(false);
  });

  it('copies the bundled model into the models folder', () => {
    fs.writeFileSync(path.join(bundled, pin.file), content);
    expect(installVadModel(bundled, models, pin)).toEqual({ path: path.join(models, pin.file) });
    expect(fs.readFileSync(path.join(models, pin.file))).toEqual(content);
    expect(fs.existsSync(path.join(models, `${pin.file}.part`))).toBe(false);
  });

  it('keeps a good copy, even without the bundled file', () => {
    fs.mkdirSync(models);
    fs.writeFileSync(path.join(models, pin.file), content);
    expect(installVadModel(bundled, models, pin)).toEqual({ path: path.join(models, pin.file) });
  });

  it('replaces a damaged copy', () => {
    fs.writeFileSync(path.join(bundled, pin.file), content);
    fs.mkdirSync(models);
    fs.writeFileSync(path.join(models, pin.file), 'damaged');
    expect(installVadModel(bundled, models, pin)).toEqual({ path: path.join(models, pin.file) });
    expect(fs.readFileSync(path.join(models, pin.file))).toEqual(content);
  });

  it('explains when there is nothing good to install', () => {
    const missing = installVadModel(bundled, models, pin);
    expect(missing.path).toBeNull();
    expect(missing).toMatchObject({ reason: expect.stringContaining('bundled VAD model is missing or damaged') });

    fs.writeFileSync(path.join(bundled, pin.file), 'wrong bytes');
    expect(installVadModel(bundled, models, pin).path).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/__tests__/vadModel.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `whisper-vad.json`:

```json
{
  "file": "ggml-silero-v6.2.0.bin",
  "url": "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin",
  "size": 885098,
  "sha256": "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987"
}
```

Create `src/services/vadModel.ts`:

```ts
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface VadModelPin {
  file: string;
  url: string;
  size: number;
  sha256: string;
}

// Mirrors whisper-vad.json (read by scripts/fetch-whisper.js and CI); a test keeps them equal.
export const VAD_MODEL: VadModelPin = {
  file: 'ggml-silero-v6.2.0.bin',
  url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin',
  size: 885098,
  sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987',
};

// whisper-server loads the VAD model on every request, and a bad file fails every request, so
// only a file that matches the pin is ever passed to it (spec §4).
export function fileMatchesPin(file: string, pin: VadModelPin = VAD_MODEL): boolean {
  try {
    const data = fs.readFileSync(file);
    return data.length === pin.size && createHash('sha256').update(data).digest('hex') === pin.sha256;
  } catch {
    return false;
  }
}

// The server cannot open absolute paths under non-ASCII profiles, so the model is copied into the
// models folder, next to the speech models it is used with (spec §3).
export function installVadModel(
  bundledDir: string,
  modelsDir: string,
  pin: VadModelPin = VAD_MODEL,
): { path: string } | { path: null; reason: string } {
  const target = path.join(modelsDir, pin.file);
  if (fileMatchesPin(target, pin)) return { path: target };
  const source = path.join(bundledDir, pin.file);
  if (!fileMatchesPin(source, pin)) {
    return { path: null, reason: `the bundled VAD model is missing or damaged (${source})` };
  }
  try {
    fs.mkdirSync(modelsDir, { recursive: true });
    const part = `${target}.part`;
    fs.copyFileSync(source, part);
    fs.renameSync(part, target);
  } catch (error) {
    return { path: null, reason: `could not copy the VAD model: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { path: target };
}
```

Run: `npx jest src/__tests__/vadModel.test.ts` → PASS (6 tests).

- [ ] **Step 4: Fetch it for local development**

In `scripts/fetch-whisper.js`:
1. Below `const url = …;` add:
```js
const vadPin = JSON.parse(fs.readFileSync(path.join(root, 'whisper-vad.json'), 'utf8'));
```
2. Add this function above `main`:
```js
// The Silero VAD model whisper-server uses to skip silence when refining (whisper-vad.json).
async function fetchVadModel() {
  const vadDir = path.join(whisperDir, 'vad');
  const target = path.join(vadDir, vadPin.file);
  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target);
    if (crypto.createHash('sha256').update(existing).digest('hex') === vadPin.sha256) {
      console.log(`VAD model ${vadPin.file} already present`);
      return;
    }
  }
  console.log(`Downloading ${vadPin.url}`);
  const res = await fetch(vadPin.url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${vadPin.url}`);
  const data = Buffer.from(await res.arrayBuffer());
  const hash = crypto.createHash('sha256').update(data).digest('hex');
  if (data.length !== vadPin.size || hash !== vadPin.sha256) {
    throw new Error(`Checksum mismatch for ${vadPin.url}: expected ${vadPin.sha256} (${vadPin.size} bytes), got ${hash} (${data.length} bytes)`);
  }
  fs.mkdirSync(vadDir, { recursive: true });
  fs.writeFileSync(target, data);
  console.log(`Installed ${vadPin.file} to ${path.relative(root, vadDir)}`);
}
```
3. In `main()`, add `await fetchVadModel();` as the last line (after the "Installed whisper.cpp" log).

Run: `npm run whisper:fetch`
Expected: the CPU build is reinstalled, then `Downloading https://huggingface.co/ggml-org/whisper-vad/...` and `Installed ggml-silero-v6.2.0.bin to resources\whisper\vad`. A second run prints `already present` for the VAD model.

- [ ] **Step 5: Bundle it in CI and test it there**

In `.github/workflows/publish.yml`, job `build-whisper`, insert these two steps directly after the step `Smoke test CPU server` (which leaves `ggml-tiny.en.bin` and `jfk.wav` in `$env:RUNNER_TEMP`):

```yaml
      - name: Fetch Silero VAD model
        shell: pwsh
        run: |
          $pin = Get-Content whisper-vad.json -Raw | ConvertFrom-Json
          New-Item -ItemType Directory -Force whisper-dist/vad | Out-Null
          $out = "whisper-dist/vad/$($pin.file)"
          curl.exe -sL -o $out $pin.url
          if ($LASTEXITCODE -ne 0) { throw "VAD model download failed: $($pin.url)" }
          $hash = (Get-FileHash $out -Algorithm SHA256).Hash.ToLower()
          if ($hash -ne $pin.sha256) { throw "VAD model checksum mismatch: $hash" }
          if ((Get-Item $out).Length -ne $pin.size) { throw 'VAD model size mismatch' }

      - name: Smoke test VAD
        shell: pwsh
        run: |
          $pin = Get-Content whisper-vad.json -Raw | ConvertFrom-Json
          $silence = "$env:RUNNER_TEMP/silence.wav"
          $dataBytes = 6 * 32000
          $writer = New-Object System.IO.BinaryWriter([System.IO.File]::Create($silence))
          $writer.Write([System.Text.Encoding]::ASCII.GetBytes('RIFF'))
          $writer.Write([int](36 + $dataBytes))
          $writer.Write([System.Text.Encoding]::ASCII.GetBytes('WAVEfmt '))
          $writer.Write([int]16)
          $writer.Write([int16]1)
          $writer.Write([int16]1)
          $writer.Write([int]16000)
          $writer.Write([int]32000)
          $writer.Write([int16]2)
          $writer.Write([int16]16)
          $writer.Write([System.Text.Encoding]::ASCII.GetBytes('data'))
          $writer.Write([int]$dataBytes)
          $writer.Write((New-Object byte[] $dataBytes))
          $writer.Close()

          $server = Start-Process -FilePath whisper-dist/cpu/whisper-server.exe -PassThru -NoNewWindow -ArgumentList @(
            '-m', "$env:RUNNER_TEMP/ggml-tiny.en.bin", '--host', '127.0.0.1', '--port', '18081',
            '--inference-path', '/v1/audio/transcriptions', '--vad', '-vm', "whisper-dist/vad/$($pin.file)")
          try {
            $ready = $false
            for ($i = 0; $i -lt 60; $i++) {
              try {
                if ((Invoke-WebRequest -UseBasicParsing http://127.0.0.1:18081/health).StatusCode -eq 200) { $ready = $true; break }
              } catch {}
              Start-Sleep -Seconds 1
            }
            if (-not $ready) { throw 'whisper-server with VAD did not become ready' }
            $quiet = curl.exe -s -F "file=@$silence" -F response_format=json http://127.0.0.1:18081/v1/audio/transcriptions | ConvertFrom-Json
            Write-Output "silence: '$($quiet.text)'"
            if ($quiet.text.Trim() -ne '') { throw 'VAD did not skip silence' }
            $speech = curl.exe -s -F "file=@$env:RUNNER_TEMP/jfk.wav" -F response_format=json http://127.0.0.1:18081/v1/audio/transcriptions
            Write-Output $speech
            if ($speech -notmatch 'ask not') { throw 'VAD lost the speech' }
          } finally {
            Stop-Process -Id $server.Id -Force
          }
```

(The VAD step runs on every build, cache hit or not, so the artifact always contains `vad/`. The existing `build-and-release` job downloads the artifact into `resources/whisper`, and `electron-builder.yml` already ships `resources/whisper/**` as `whisper/`.)

- [ ] **Step 6: Run the CI smoke test locally**

Run the "Smoke test VAD" script body in PowerShell from the repo root, after pointing it at local files (a throwaway check; nothing is committed):

```powershell
$env:RUNNER_TEMP = Join-Path $env:TEMP 'dw-vad-ci'
New-Item -ItemType Directory -Force $env:RUNNER_TEMP | Out-Null
Copy-Item "$env:APPDATA\Dark-Whisper\models\ggml-base.en.bin" "$env:RUNNER_TEMP\ggml-tiny.en.bin"
curl.exe -sL -o "$env:RUNNER_TEMP\jfk.wav" https://raw.githubusercontent.com/ggml-org/whisper.cpp/b5130/samples/jfk.wav
New-Item -ItemType Directory -Force whisper-dist | Out-Null
cmd /c mklink /J whisper-dist\cpu resources\whisper\cpu
cmd /c mklink /J whisper-dist\vad resources\whisper\vad
# …paste the Smoke test VAD body here…
cmd /c rmdir whisper-dist\cpu
cmd /c rmdir whisper-dist\vad
Remove-Item whisper-dist, $env:RUNNER_TEMP -Recurse -Force
```

Expected: `silence: ''`, then the JFK JSON; no exception. (`ggml-base.en.bin` stands in for tiny.en.)

- [ ] **Step 7: Parse the workflow's PowerShell**

```powershell
$yaml = Get-Content .github/workflows/publish.yml -Raw
$blocks = [regex]::Matches($yaml, '(?ms)^\s+run: \|\r?\n(.*?)(?=^\s{0,6}- (name|uses):|\z)')
$i = 0
foreach ($b in $blocks) {
  $i++
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseInput($b.Groups[1].Value, [ref]$null, [ref]$errors) | Out-Null
  "block $i errors: $($errors.Count)"
  $errors | ForEach-Object { "  $($_.Message)" }
}
```

Expected: every block reports `errors: 0` (bash blocks, if any, are not in this job; a non-zero count on a non-pwsh block can be ignored after checking it is bash).

- [ ] **Step 8: Commit**

```bash
git add whisper-vad.json src/services/vadModel.ts src/__tests__/vadModel.test.ts scripts/fetch-whisper.js .github/workflows/publish.yml
git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit -m "Pin, fetch and bundle the Silero VAD model

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Start whisper-server with VAD

**Files:**
- Modify: `src/services/whisperServer.ts`, `src/services/serverOutput.ts`, `src/services/serverGate.ts`, `src/shared/api.ts`
- Test: `src/__tests__/whisperServer.test.ts`, `src/__tests__/serverOutput.test.ts`, `src/__tests__/serverGate.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 directly (the path is passed in).
- Produces:
  - `ServerStatus.vad: boolean`; `ServerStatusView.vad: boolean` (shared API).
  - `WhisperServer.start(modelId: string, modelPath: string, opts: { forceCpu: boolean; vadModelPath?: string | null })`.
  - `ServerLineEvent` gains `'vad-failed'`.
  - Status text `Ready — <name> (GPU, VAD)` / `(CPU, VAD)` when `vad`.

- [ ] **Step 1: Write the failing tests**

In `src/__tests__/whisperServer.test.ts`:
1. Change both `toEqual({ state: 'no-model', modelId: null, backend: null, gpu: false, port: null })` to `toEqual({ state: 'no-model', modelId: null, backend: null, gpu: false, vad: false, port: null })`.
2. Append inside `describe('WhisperServer')`:

```ts
  it('adds VAD with a path relative to the model directory', async () => {
    const ctx = setup();
    await ctx.server.start('ggml-tiny.en.bin', path.join('/models', 'ggml-tiny.en.bin'), {
      forceCpu: false,
      vadModelPath: path.join('/models', 'ggml-silero-v6.2.0.bin'),
    });
    const args = ctx.deps.spawnServer.mock.calls[0][1];
    expect(args.slice(-3)).toEqual(['--vad', '-vm', 'ggml-silero-v6.2.0.bin']);
    ctx.deps.checkHealth.mockResolvedValue(true);
    await jest.advanceTimersByTimeAsync(500);
    expect(ctx.server.getStatus()).toMatchObject({ state: 'ready', vad: true });
  });

  it('reaches a VAD model above a custom model directory', async () => {
    const ctx = setup();
    await ctx.server.start('custom/owner__repo__m.bin', path.join('/models', 'custom', 'owner__repo__m.bin'), {
      forceCpu: false,
      vadModelPath: path.join('/models', 'ggml-silero-v6.2.0.bin'),
    });
    expect(ctx.deps.spawnServer.mock.calls[0][1].slice(-1)).toEqual([path.join('..', 'ggml-silero-v6.2.0.bin')]);
  });

  it('runs without VAD when no VAD model is given', async () => {
    const ctx = setup();
    await startReady(ctx);
    expect(ctx.deps.spawnServer.mock.calls[0][1]).not.toContain('--vad');
    expect(ctx.server.getStatus().vad).toBe(false);
  });

  it('relaunches without VAD when the server cannot load the VAD model, and keeps it off on restart', async () => {
    const ctx = setup();
    await ctx.server.start(...MODEL, { forceCpu: false, vadModelPath: '/models/ggml-silero-v6.2.0.bin' });
    ctx.deps.checkHealth.mockResolvedValue(true);
    await jest.advanceTimersByTimeAsync(500);
    ctx.procs[0].log('whisper_vad: failed to initialize VAD context');
    await flush();
    expect(ctx.procs[0].killed).toBe(true);
    expect(ctx.deps.spawnServer).toHaveBeenCalledTimes(2);
    expect(ctx.deps.spawnServer.mock.calls[1][1]).not.toContain('--vad');
    await jest.advanceTimersByTimeAsync(500);
    expect(ctx.server.getStatus()).toMatchObject({ state: 'ready', vad: false });

    ctx.procs[1].log('whisper_vad: failed to initialize VAD context');
    await flush();
    expect(ctx.deps.spawnServer).toHaveBeenCalledTimes(2);

    await ctx.server.restart();
    expect(ctx.deps.spawnServer.mock.calls[2][1]).not.toContain('--vad');
  });

  it('tries VAD again when started afresh', async () => {
    const ctx = setup();
    await ctx.server.start(...MODEL, { forceCpu: false, vadModelPath: '/models/ggml-silero-v6.2.0.bin' });
    ctx.procs[0].log('whisper_vad: failed to initialize VAD context');
    await flush();
    await ctx.server.start(...MODEL, { forceCpu: false, vadModelPath: '/models/ggml-silero-v6.2.0.bin' });
    const last = ctx.deps.spawnServer.mock.calls[ctx.deps.spawnServer.mock.calls.length - 1][1];
    expect(last).toContain('--vad');
  });
```

(`MODEL` in this file is `['ggml-tiny.en.bin', '/models/ggml-tiny.en.bin']`; on Windows `path.relative('/models', '/models/ggml-silero-v6.2.0.bin')` is still `ggml-silero-v6.2.0.bin`.)

In `src/__tests__/serverOutput.test.ts`, add inside the `classifyServerLine` describe (read the file first for its exact describe name):

```ts
  it('recognises a VAD model the server could not load', () => {
    expect(classifyServerLine('whisper_vad: failed to initialize VAD context')).toBe('vad-failed');
    expect(classifyServerLine('whisper_vad: VAD is enabled, processing speech segments only')).toBeNull();
  });
```

In `src/__tests__/serverGate.test.ts`:
1. Change `const base: ServerStatus = { state: 'ready', modelId: 'ggml-large-v3-turbo-q5_0.bin', backend: 'vulkan', gpu: true, port: 5000 };` to include `vad: false` after `gpu: true`.
2. Add two rows to the `toStatusView` table after the CPU row:
```ts
    ['builtin', { ...base, vad: true }, 'Ready — large-v3-turbo-q5_0 (GPU, VAD)'],
    ['builtin', { ...base, gpu: false, vad: true }, 'Ready — large-v3-turbo-q5_0 (CPU, VAD)'],
```

Run: `npx jest src/__tests__/whisperServer.test.ts src/__tests__/serverOutput.test.ts src/__tests__/serverGate.test.ts` → FAIL.

- [ ] **Step 2: Implement**

`src/services/serverOutput.ts`:
- `export type ServerLineEvent = 'model-load-failed' | 'bind-failed' | 'gpu-backend' | 'no-gpu' | 'vad-failed';`
- first line of `classifyServerLine`: `if (line.includes('failed to initialize VAD context')) return 'vad-failed';`

`src/services/whisperServer.ts`:
1. `ServerStatus`: add `vad: boolean;` after `gpu: boolean;`. Add `vad: false` after every `gpu: false` in the object literals of this file (the initial `status`, `stop()`, `setNoModel()`, and the `starting` status in `launch`).
2. Fields: add below `private forceCpu = false;`
```ts
  private vadModelPath: string | null = null;
  // Set when the server could not load the VAD model; cleared by start().
  private vadFailed = false;
  private launchedWithVad = false;
```
3. `start()`: change the signature to `async start(modelId: string, modelPath: string, opts: { forceCpu: boolean; vadModelPath?: string | null }): Promise<void>` and add after `this.forceCpu = opts.forceCpu;`:
```ts
    this.vadModelPath = opts.vadModelPath ?? null;
    this.vadFailed = false;
```
4. `restart()`: a restart after a VAD failure starts without VAD:
```ts
  async restart(): Promise<void> {
    if (this.modelId && this.modelPath) {
      await this.start(this.modelId, this.modelPath, {
        forceCpu: this.forceCpu,
        vadModelPath: this.vadFailed ? null : this.vadModelPath,
      });
    }
  }
```
5. In `launch()`, replace the `spawnServer` call with:
```ts
    this.launchedWithVad = this.vadModelPath !== null && !this.vadFailed;
    // Like the model, the VAD model is passed relative to the working directory (non-ASCII paths).
    const vadArgs = this.launchedWithVad
      ? ['--vad', '-vm', path.relative(path.dirname(modelPath), this.vadModelPath as string)]
      : [];
    const proc = this.deps.spawnServer(binary, [
      '-m', path.basename(modelPath), '--host', '127.0.0.1', '--port', String(port), '--inference-path', INFERENCE_PATH,
      ...vadArgs,
    ], path.dirname(modelPath));
```
6. In `launch()`'s `onData`, handle the VAD failure:
```ts
    const onData = (chunk: Buffer | string) => {
      for (const line of this.log.push(String(chunk))) {
        const event = classifyServerLine(line);
        if (!event || generation !== this.generation) continue;
        if (event === 'vad-failed') {
          this.onVadFailed(generation, backend);
          continue;
        }
        this.events.add(event);
      }
    };
```
   and add the method below `launch()`:
```ts
  // b5130 loads the VAD model per request; if it cannot, every request fails. Carry on without it.
  private onVadFailed(generation: number, backend: Backend): void {
    if (!this.launchedWithVad || this.vadFailed || generation !== this.generation) return;
    this.vadFailed = true;
    console.error('whisper-server could not load the VAD model; restarting without VAD');
    this.halt();
    void this.launch(backend, false);
  }
```
7. In `checkHealthOnce`, the ready status becomes:
```ts
      this.setStatus({ ...this.status, state: 'ready', gpu, vad: this.launchedWithVad, message: undefined });
```
8. In `handleExit`, the crash-restart status literal keeps `vad: false` next to `gpu: false`: change `port: null, gpu: false, message:` to `port: null, gpu: false, vad: false, message:`. The `fail()` helper: change `port: null, gpu: false, message` to `port: null, gpu: false, vad: false, message`.

`src/services/serverGate.ts` — in `statusText`, the ready case becomes:
```ts
    case 'ready': {
      const name = status.modelId ? displayName(status.modelId) : 'unknown model';
      return `Ready — ${name} (${status.gpu ? 'GPU' : 'CPU'}${status.vad ? ', VAD' : ''})`;
    }
```

`src/shared/api.ts` — `ServerStatusView`: add `vad: boolean;` after `gpu: boolean;`.

Fix any other literal the compiler flags (`npm run build`), e.g. test fixtures in `src/__tests__/headerModel.test.ts` (`server()` fixture: add `vad: false`).

- [ ] **Step 3: Run the tests, build, lint**

Run: `npm test && npm run build && npm run lint` → all pass, 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/services/whisperServer.ts src/services/serverOutput.ts src/services/serverGate.ts src/shared/api.ts src/__tests__
git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit -m "Start whisper-server with VAD and fall back when it cannot load

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Wire VAD into the app and its settings

**Files:**
- Modify: `src/services/whisperRuntime.ts`, `src/services/settingsService.ts`, `src/shared/api.ts`, `src/main.ts`, `src/renderer/dialogs.ts`, `public/index.html`
- Test: `src/__tests__/modelManager.test.ts` (VAD file is not listed)

**Interfaces:**
- Consumes: `installVadModel`, `VAD_MODEL` (Task 1); `WhisperServer.start(..., { vadModelPath })` (Task 2).
- Produces: `Settings.refineVad` / `SettingsView.refineVad: boolean` (default `true`); checkbox `#refineVadInput`.

- [ ] **Step 1: Write the failing test**

In `src/__tests__/modelManager.test.ts`, add a test that uses the file's existing temp-dir helper for a `ModelManager` (read the top of the file first; the test below assumes a `modelsDir` and a `manager` created the way the other tests do):

```ts
  it('does not list the VAD model as a speech model', async () => {
    fs.writeFileSync(path.join(modelsDir, 'ggml-silero-v6.2.0.bin'), Buffer.alloc(16));
    await manager.init();
    expect(manager.listModels().map((m) => m.id)).not.toContain('ggml-silero-v6.2.0.bin');
    expect(manager.listModels().some((m) => m.id.includes('silero'))).toBe(false);
  });
```

Run: `npx jest src/__tests__/modelManager.test.ts`
Expected: PASS already (the catalog is by id and custom models live in `custom/`). This test guards that behaviour; keep it.

- [ ] **Step 2: Settings**

`src/services/settingsService.ts`: add `refineVad: boolean;` to `Settings` (after `refineWithExternalApi`), `refineVad: true,` to the store defaults, and `refineVad: storeAny.get('refineVad', true),` to `getSettings()`.

`src/shared/api.ts`: add `refineVad: boolean;` to `SettingsView` after `refineWithExternalApi`.

`public/index.html`: in `<div id="builtinOptions">`, after the Force CPU label, add:
```html
        <label class="check"><input type="checkbox" id="refineVadInput"> Skip silence when refining (VAD)</label>
        <p class="hint">Removes paragraphs that contain no speech.</p>
```

`src/renderer/dialogs.ts`:
- `settingsFields()`: add `refineVad: byId<HTMLInputElement>('refineVadInput'),` after `forceCpu`.
- `openSettings()`: add `f.refineVad.checked = settings.refineVad;` after `f.forceCpu.checked = …`.
- `saveSettingsFromDialog()`: add `refineVad: f.refineVad.checked,` after `forceCpu`.

`src/main.ts`, `save-settings` handler: change
```ts
  if (before.serverMode !== after.serverMode || before.forceCpu !== after.forceCpu) {
```
to
```ts
  if (before.serverMode !== after.serverMode || before.forceCpu !== after.forceCpu || before.refineVad !== after.refineVad) {
```

- [ ] **Step 3: Install and pass the model at server start**

`src/services/whisperRuntime.ts`:
1. Add `import { installVadModel } from './vadModel';`.
2. Replace the `modelManager` construction with a shared models directory:
```ts
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
```
3. In `startBuiltinServer()`, change the last line to:
```ts
  await whisperServer.start(settings.modelId, modelPath, { forceCpu: settings.forceCpu, vadModelPath: vadModelForServer() });
```

- [ ] **Step 4: Build, test, lint, and check a real start**

Run: `npm test && npm run build && npm run lint` → pass.

Then start a throwaway instance with the real models copied in, and check the server line (no recording):

```bash
P=$(node -e "console.log(require('fs').mkdtempSync(require('path').join(require('os').tmpdir(),'dw-vadrun-')))")
mkdir -p "$P/models" && cp "$APPDATA/Dark-Whisper/models/ggml-base.en.bin" "$P/models/"
node -e "require('fs').writeFileSync(process.argv[1]+'/config.json', JSON.stringify({serverMode:'builtin', modelId:'ggml-base.en.bin'}))" "$P"
(npx electron . --user-data-dir="$P" --remote-debugging-port=9337 &) ; sleep 20
node scripts/dev-cdp.mjs "window.api.getServerStatus()" 2>/dev/null || node -e "import('./scripts/dev-cdp.mjs').then(async ({connect}) => { const a = await connect(9337); console.log(await a.evaluate('window.api.getServerStatus()')); a.close(); })"
ls "$P/models"; grep -i "vad" "$P/logs/whisper-server.log" | head -3
```

Expected: status `{ state: 'ready', vad: true, text: 'Ready — base.en (GPU, VAD)' … }` (or CPU); `models/` contains `ggml-silero-v6.2.0.bin`. Then stop that instance (`taskkill` the electron process whose command line contains `dw-vadrun-`) and delete `$P`.

- [ ] **Step 5: Commit**

```bash
git add src/services/whisperRuntime.ts src/services/settingsService.ts src/shared/api.ts src/main.ts src/renderer/dialogs.ts public/index.html src/__tests__/modelManager.test.ts
git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit -m "Install the VAD model at start-up and add the VAD setting

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Remove paragraphs that turn out to contain no speech

**Files:**
- Modify: `src/services/documentStore.ts`, `src/services/guardedStore.ts`, `src/services/sessionService.ts`, `src/services/blockRefiner.ts`, `src/services/sessionRuntime.ts`, `src/shared/api.ts`, `src/renderer/sessionModel.ts`, `public/app.css`
- Test: `src/__tests__/documentStore.test.ts`, `src/__tests__/sessionService.test.ts`, `src/__tests__/blockRefiner.test.ts`, `src/__tests__/sessionModel.test.ts`, `src/__tests__/sessionOutsideEdit.test.ts`

**Interfaces:**
- Consumes: `ServerStatus.vad` (Task 2).
- Produces:
  - `DocumentStore.removeBlock(file: string, index: number, expectedHash: string): RemoveOutcome` with `type RemoveOutcome = 'removed' | 'skipped-edited' | 'missing'`; same method on `GuardedStore` and `SessionStoreLike`.
  - `SessionService.applyRefinement(blockIndex: number, text: string, opts?: { vad: boolean }): RefineOutcome` with `RefineOutcome = ReplaceOutcome | 'no-speech' | 'removed'`.
  - `RefineEvent.kind` gains `'removed'`; `BlockState` gains `'removed'`.

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/documentStore.test.ts` inside `describe('DocumentStore with clock lines')`:

```ts
  function threeBlocks() {
    const file = store.createDocument('s1', FM);
    for (const [index, text] of [[1, 'one'], [2, 'Thank you.'], [3, 'three']] as const) {
      store.openBlock(file, { index, startSec: index, endSec: index }, `**14:3${index}**`);
      store.appendSegment(file, text);
    }
    return file;
  }

  it('removes one paragraph and nothing else', () => {
    const file = threeBlocks();
    expect(store.removeBlock(file, 2, hashText('Thank you.'))).toBe('removed');
    const content = fs.readFileSync(file, 'utf8');
    expect(content).not.toContain('Thank you.');
    expect(content).not.toContain('dw:block 2');
    expect(content).toContain('<!-- dw:block 1 t=1-1 -->\n**14:31**\none\n\n<!-- dw:block 3 t=3-3 -->\n**14:33**\nthree\n');
  });

  it('removes the last paragraph, leaving one newline at the end', () => {
    const file = threeBlocks();
    expect(store.removeBlock(file, 3, hashText('three'))).toBe('removed');
    expect(fs.readFileSync(file, 'utf8').endsWith('**14:32**\nThank you.\n')).toBe(true);
  });

  it('keeps an edited paragraph and reports a missing one', () => {
    const file = threeBlocks();
    expect(store.removeBlock(file, 2, hashText('something else'))).toBe('skipped-edited');
    expect(store.removeBlock(file, 9, hashText('x'))).toBe('missing');
    expect(fs.readFileSync(file, 'utf8')).toContain('Thank you.');
  });

  it('keeps Windows line endings when removing', () => {
    const file = threeBlocks();
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
    expect(store.removeBlock(file, 2, hashText('Thank you.'))).toBe('removed');
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain('one\r\n\r\n<!-- dw:block 3 t=3-3 -->\r\n');
    expect(content.replace(/\r\n/g, '')).not.toContain('\n');
  });
```

In `src/__tests__/sessionService.test.ts`:
1. In `fakeStore()`, add to the `store` object:
```ts
    removeBlock: (_file, index, expectedHash) => {
      const current = blocks.get(index);
      if (current === undefined) return 'missing';
      if (hashText(current) !== expectedHash) return 'skipped-edited';
      blocks.delete(index);
      return 'removed';
    },
```
2. Append inside the top-level describe:
```ts
  it('removes a paragraph that VAD found silent, unless it was edited', () => {
    const ctx = setup();
    ctx.service.segment({ text: 'Thanks a lot', atMs: 1_000 });
    ctx.service.setPaused(true, 2_000);
    ctx.service.setPaused(false, 3_000);
    ctx.service.segment({ text: 'second', atMs: 4_000 });
    ctx.service.end();

    expect(ctx.service.applyRefinement(1, '', { vad: true })).toBe('removed');
    expect(ctx.blocks.has(1)).toBe(false);
    expect(ctx.service.applyRefinement(1, 'late', { vad: true })).toBe('missing');

    ctx.blocks.set(2, 'second, edited');
    expect(ctx.service.applyRefinement(2, ' ', { vad: true })).toBe('skipped-edited');
    expect(ctx.blocks.get(2)).toBe('second, edited');
  });

  it('keeps the live text for an empty result without VAD', () => {
    const ctx = setup();
    ctx.service.segment({ text: 'rough', atMs: 1_000 });
    ctx.service.end();
    expect(ctx.service.applyRefinement(1, '', { vad: false })).toBe('no-speech');
    expect(ctx.service.applyRefinement(1, '')).toBe('no-speech');
    expect(ctx.blocks.get(1)).toBe('rough');
  });
```

In `src/__tests__/blockRefiner.test.ts`, add next to the `no-speech` test:
```ts
  it('reports a paragraph removed for having no speech', async () => {
    const ctx = setup({ apply: jest.fn(() => 'removed' as const) });
    ctx.queue.enqueue(JOB);
    await ctx.queue.drain();
    expect(ctx.events).toContainEqual({ kind: 'removed', blockIndex: 1 });
  });
```

In `src/__tests__/sessionModel.test.ts`, add inside the describe:
```ts
  it('treats a removed paragraph as finished', () => {
    expect(BLOCK_LABELS.removed).toBe('removed — no speech');
    let model = applyStatus(emptySessionModel(), status());
    model = applyBlock(model, block(1, 'removed'));
    model = applyBlock(model, block(1, 'refining'));
    expect(model.blocks).toEqual([block(1, 'removed')]);
  });
```

Run: `npx jest src/__tests__/documentStore.test.ts src/__tests__/sessionService.test.ts src/__tests__/blockRefiner.test.ts src/__tests__/sessionModel.test.ts` → FAIL.

- [ ] **Step 2: Implement**

`src/services/documentStore.ts`:
- below `export type ReplaceOutcome = …;` add `export type RemoveOutcome = 'removed' | 'skipped-edited' | 'missing';`
- add after `replaceBlock`:
```ts
  // A paragraph that turned out to hold no speech (spec §5). The block runs from its marker to the
  // next marker, which includes the blank line written before that next marker, so removing the
  // range leaves exactly one blank line between the neighbours.
  removeBlock(file: string, index: number, expectedHash: string): RemoveOutcome {
    const bounds = this.blockBounds(file, index);
    if (!bounds) return 'missing';
    const current = this.readBlockText(file, index) ?? '';
    if (hashText(current) !== expectedHash) return 'skipped-edited';
    const next = [...bounds.lines.slice(0, bounds.startLine), ...bounds.lines.slice(bounds.endLine)];
    this.write(file, next.join('\n'));
    return 'removed';
  }
```
  (For the last block, the range ends at the file's final empty element, so the result ends with the blank line that preceded the marker — a single trailing newline.)

`src/services/guardedStore.ts`: import `RemoveOutcome` and add after `replaceBlock`:
```ts
  removeBlock(file: string, index: number, expectedHash: string): RemoveOutcome {
    this.checkForOutsideEdit(file);
    const outcome = this.store.removeBlock(file, index, expectedHash);
    this.noteWrite(file);
    return outcome;
  }
```

`src/services/sessionService.ts`:
- import `RemoveOutcome` from `./documentStore`;
- `export type RefineOutcome = ReplaceOutcome | 'no-speech' | 'removed';`
- `SessionStoreLike`: add `removeBlock(file: string, index: number, expectedHash: string): RemoveOutcome;`
- replace `applyRefinement` with:
```ts
  // A refinement that heard nothing: with VAD that is reliable, so the paragraph (whose live text
  // was invented) is removed; without VAD the live text is kept. whisper-server starts each line
  // after the first with a space; those are trimmed.
  applyRefinement(blockIndex: number, text: string, opts: { vad: boolean } = { vad: false }): RefineOutcome {
    const hash = this.hashes.get(blockIndex);
    if (hash === undefined) return 'missing';
    if (isNoiseSegment(text)) {
      if (!opts.vad) return 'no-speech';
      const removed = this.deps.store.removeBlock(this.info.documentPath, blockIndex, hash);
      if (removed === 'removed') this.hashes.delete(blockIndex);
      return removed;
    }
    const clean = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .join('\n');
    const outcome = this.deps.store.replaceBlock(this.info.documentPath, blockIndex, clean, hash);
    if (outcome === 'replaced') {
      this.hashes.set(blockIndex, hashText(clean));
    }
    return outcome;
  }
```
  (The `.split('\n')` and `.join('\n')` are backslash-n escapes in TypeScript source, as in the current method.)

`src/services/blockRefiner.ts`:
- `kind: 'started' | 'replaced' | 'removed' | 'skipped' | 'failed';`
- `apply(...)` return type: `'replaced' | 'skipped-edited' | 'missing' | 'no-speech' | 'removed'`
- in `runJob`, after the `replaced` branch:
```ts
        } else if (outcome === 'removed') {
          this.deps.report({ kind: 'removed', blockIndex: job.blockIndex });
```

`src/shared/api.ts`: `BlockState` gains `'removed'`.

`src/services/sessionRuntime.ts`:
- `REFINE_STATE`: add `removed: 'removed',`
- the queue's `apply` becomes:
```ts
    apply: (blockIndex, text) =>
      service.applyRefinement(blockIndex, text, {
        vad: getSettings().serverMode === 'builtin' && whisperServer.getStatus().vad,
      }),
```

`src/renderer/sessionModel.ts`: `RANK` gains `removed: 3,`; `BLOCK_LABELS` gains `removed: 'removed — no speech',`.

`public/app.css`: after `.badge.failed, .badge.skipped { … }` add `.badge.removed { color: var(--muted); text-decoration: line-through; }`.

`src/__tests__/sessionOutsideEdit.test.ts`: no change expected (it uses `GuardedStore`); if the compiler flags a missing member on a fake store elsewhere, add `removeBlock` the same way as in `sessionService.test.ts`.

- [ ] **Step 3: Run tests, build, lint, smoke**

Run: `npm test && npm run build && npm run lint && npm run smoke:workspace` → all pass.

- [ ] **Step 4: Commit**

```bash
git add src public/app.css
git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit -m "Remove paragraphs that VAD finds silent

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Documentation and the test build

**Files:**
- Modify: `README.md`, `DEVELOPMENT.md`, `.claude`, `QUICKSTART.md`

- [ ] **Step 1: Update the docs**

- README Features: extend **Paragraph Refinement** with "; silent paragraphs are skipped with Silero VAD, so Whisper's invented "Thank you." never lands in your notes".
- README Configuring Settings, built-in options: add `- **Skip silence when refining (VAD)** - Built-in only; removes paragraphs that contain no speech (default on)`.
- README Configuration table: add `| \`refineVad\` | \`true\` / \`false\` | Default \`true\` |`.
- README Status Line row: `| Green - \`Ready\` | Ready; hover for the model, backend (GPU/CPU) and whether VAD is on |`.
- README Session Problems: add `- **A paragraph disappeared** - its audio held no speech (the details panel shows "removed — no speech"). If real speech is being removed, untick **Skip silence when refining (VAD)** and report it`.
- README Technical Details: add `- **VAD Model:** \`ggml-silero-v6.2.0.bin\` (Silero, 885 KB), bundled and copied to \`%APPDATA%\\Dark-Whisper\\models\\\``.
- README 1.3.0 changelog: add the bullet `- Silent paragraphs are skipped: the built-in server uses Silero VAD, so "Thank you." and similar invented text no longer appear.`
- README Project structure: add `│   │   ├── vadModel.ts            # The pinned Silero VAD model: verify and install` under services, and `├── whisper-vad.json           # Pinned Silero VAD model` next to `whisper.version`.
- README "Releases and CI": in step 2 add "fetches and checks the pinned Silero VAD model, and checks that the VAD server returns nothing for silence".
- DEVELOPMENT Server Supervision: add a bullet: "**VAD:** with `refineVad` on, `whisperRuntime` verifies the bundled `resources/whisper/vad/ggml-silero-v6.2.0.bin` against `whisper-vad.json`, copies it into the models folder, and the server gets `--vad -vm <path relative to the model directory>`. b5130 loads the VAD model per request; a bad file makes every request fail with `whisper_vad: failed to initialize VAD context`, which relaunches the server without VAD. `ServerStatus.vad` says whether the running process uses it." Add `vadModel.ts` to the Electron-free services table ("Pinned Silero VAD model: hash check and install into the models folder"). In the Documents and refinement section add: "With VAD on, an empty refinement removes its paragraph (`removeBlock`, hash-guarded, state `removed`); without VAD the live text is kept."
- DEVELOPMENT Manual Test Checklist: add `- [ ] Quick note with long pauses: no "Thank you." paragraphs; the server tooltip shows VAD`.
- `.claude`: add under Server Lifecycle "Args add `--vad -vm <relative silero path>` when `refineVad` and the pinned model verifies; `vad-failed` (`failed to initialize VAD context`) relaunches without VAD. VAD loads per request in b5130." and under Settings add `refineVad` (default true).
- QUICKSTART: in the `whisper:fetch` description mention "and the Silero VAD model into `resources/whisper/vad`".

- [ ] **Step 2: Verify and commit**

Run: `npm test && npm run build && npm run lint && npm run smoke:workspace` → pass.

```bash
git add README.md DEVELOPMENT.md QUICKSTART.md .claude
git -c user.name=TheGeek01 -c user.email=TheGeek01@users.noreply.github.com commit -m "Document VAD refinement

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 3: Rebuild the test copy**

With the test app closed: `npm run build && npx electron-builder --win --dir`. Confirm `release/win-unpacked/resources/whisper/vad/ggml-silero-v6.2.0.bin` exists (885 098 bytes). `resources/whisper/vulkan` must still hold the Vulkan binaries copied from the installed 1.2.1.

## After the tasks (with the user)

Live check: quick notes with 6–10 s pauses — no "Thank you." paragraphs, real speech kept, tooltip shows `VAD`. Then merge, tag v1.3.0 (after the Task 1 Step 7 parse), watch CI including the new VAD smoke step, and verify the release asset.
